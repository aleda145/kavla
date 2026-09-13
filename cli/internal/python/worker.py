"""Fresh-process Python shape execution and non-executing dependency analysis."""
import ast
import builtins
import json
import keyword
import sys
import symtable
import traceback

RESERVED = set(dir(builtins)) | {"result", "shapes", "__name__", "__file__"}


def analyze(code, names):
    tree = ast.parse(code, filename="<python-shape>")
    table = symtable.symtable(code, "<python-shape>", "exec")
    reads = set()
    explicit = set()
    bound = set()
    module_bound = {symbol.get_name() for symbol in table.get_symbols()
                    if symbol.is_assigned() or symbol.is_imported() or symbol.is_namespace()}

    class References(ast.NodeVisitor):
        def __init__(self, scope):
            self.scope = scope

        def global_input(self, name):
            if self.scope is table:
                return name not in bound
            try:
                symbol = self.scope.lookup(name)
            except KeyError:
                return False
            return symbol.is_global() and name not in module_bound

        def visit_Name(self, node):
            if isinstance(node.ctx, ast.Load) and self.global_input(node.id):
                reads.add(node.id)
            elif self.scope is table and isinstance(node.ctx, (ast.Store, ast.Del)):
                bound.add(node.id)

        def visit_Assign(self, node):
            self.visit(node.value)
            for target in node.targets:
                self.visit(target)

        def visit_AnnAssign(self, node):
            self.visit(node.annotation)
            if node.value:
                self.visit(node.value)
                self.visit(node.target)

        def visit_NamedExpr(self, node):
            self.visit(node.value)
            self.visit(node.target)

        def visit_If(self, node):
            self.visit(node.test)
            previous = bound.copy()
            for item in node.body:
                self.visit(item)
            body_bound = bound.copy()
            bound.clear()
            bound.update(previous)
            for item in node.orelse:
                self.visit(item)
            bound.intersection_update(body_bound)

        def visit_For(self, node):
            self.visit(node.iter)
            previous = bound.copy()
            self.visit(node.target)
            for item in node.body:
                self.visit(item)
            bound.clear()
            bound.update(previous)
            for item in node.orelse:
                self.visit(item)
            bound.intersection_update(previous)

        visit_AsyncFor = visit_For

        def visit_While(self, node):
            self.visit(node.test)
            previous = bound.copy()
            for item in node.body + node.orelse:
                self.visit(item)
            bound.clear()
            bound.update(previous)

        def visit_Try(self, node):
            previous = bound.copy()
            for branch in [node.body + node.orelse] + [handler.body for handler in node.handlers]:
                bound.clear()
                bound.update(previous)
                for item in branch:
                    self.visit(item)
            bound.clear()
            bound.update(previous)
            for item in node.finalbody:
                self.visit(item)

        def visit_AugAssign(self, node):
            if isinstance(node.target, ast.Name) and self.global_input(node.target.id):
                reads.add(node.target.id)
            self.visit(node.value)
            self.visit(node.target)

        def visit_Import(self, node):
            if self.scope is table:
                bound.update(alias.asname or alias.name.split(".")[0] for alias in node.names)

        def visit_ImportFrom(self, node):
            if self.scope is table:
                bound.update(alias.asname or alias.name for alias in node.names)

        def visit_Subscript(self, node):
            if isinstance(node.value, ast.Name) and node.value.id == "shapes" and self.global_input("shapes"):
                if not isinstance(node.slice, ast.Constant) or not isinstance(node.slice.value, str):
                    raise ValueError('Use a literal shape name, for example shapes["query_1"].')
                explicit.add(node.slice.value)
            self.generic_visit(node)

        def nested(self, node, name, body):
            child = next((child for child in self.scope.get_children()
                          if child.get_name() == name and child.get_lineno() == node.lineno), None)
            if child:
                visitor = References(child)
                for item in body:
                    visitor.visit(item)

        def visit_FunctionDef(self, node):
            for item in node.decorator_list + node.args.defaults + [v for v in node.args.kw_defaults if v]:
                self.visit(item)
            self.nested(node, node.name, node.body)
            if self.scope is table:
                bound.add(node.name)

        visit_AsyncFunctionDef = visit_FunctionDef

        def visit_ClassDef(self, node):
            for item in node.decorator_list + node.bases:
                self.visit(item)
            self.nested(node, node.name, node.body)
            if self.scope is table:
                bound.add(node.name)

        def visit_Lambda(self, node):
            for item in node.args.defaults:
                self.visit(item)
            self.nested(node, "lambda", [node.body])

        def comprehension(self, node, name):
            self.visit(node.generators[0].iter)
            child = next((child for child in self.scope.get_children()
                          if child.get_name() == name and child.get_lineno() == node.lineno), None)
            if child:
                visitor = References(child)
                for index, generator in enumerate(node.generators):
                    if index:
                        visitor.visit(generator.iter)
                    for condition in generator.ifs:
                        visitor.visit(condition)
                for field in ("elt", "key", "value"):
                    value = getattr(node, field, None)
                    if value is not None:
                        visitor.visit(value)

        def visit_ListComp(self, node): self.comprehension(node, "listcomp")
        def visit_SetComp(self, node): self.comprehension(node, "setcomp")
        def visit_DictComp(self, node): self.comprehension(node, "dictcomp")
        def visit_GeneratorExp(self, node): self.comprehension(node, "genexpr")

    References(table).visit(tree)
    missing = explicit - set(names)
    if missing:
        raise ValueError("Unknown shape: " + ", ".join(sorted(missing)))
    return sorted(explicit | ((reads & set(names)) - RESERVED))


def execute(request):
    import pandas as pd
    import pyarrow as pa
    import pyarrow.parquet as pq

    inputs = {name: pd.read_parquet(path, dtype_backend="pyarrow") for name, path in request["inputs"].items()}
    namespace = {"__name__": "__main__", "shapes": inputs}
    namespace.update({name: frame for name, frame in inputs.items()
                      if name.isidentifier() and not keyword.iskeyword(name) and name not in RESERVED})
    exec(compile(request["code"], "<python-shape>", "exec"), namespace)
    result = namespace.get("result")
    if not isinstance(result, pd.DataFrame):
        raise ValueError("Assign a pandas DataFrame to result to publish this shape's output.")
    if not result.columns.is_unique or not all(isinstance(column, str) for column in result.columns):
        raise ValueError("Result columns must have unique string names.")
    if len(result.columns) == 0:
        raise ValueError("Result must contain at least one column.")
    pq.write_table(pa.Table.from_pandas(result, preserve_index=False), request["output"])


def main():
    request = json.load(sys.stdin)
    response = {}
    try:
        if request["mode"] == "analyze":
            response["dependencies"] = analyze(request["code"], request["names"])
        else:
            execute(request)
    except BaseException as error:
        frames = traceback.extract_tb(error.__traceback__)
        line = getattr(error, "lineno", None)
        for frame in frames:
            if frame.filename == "<python-shape>":
                line = frame.lineno
        response = {"error": str(error) or type(error).__name__, "line": line, "column": getattr(error, "offset", None),
                    "traceback": traceback.format_exc()}
    with open(request["response"], "w", encoding="utf-8") as output:
        json.dump(response, output)


if __name__ == "__main__":
    main()
