import type { TLBaseShape } from "tldraw";
import type { SQLTextAreaShape } from "../SQLTextArea/sql-text-area-types";

export type PythonShape = TLBaseShape<"python-text-area", SQLTextAreaShape["props"] & {
  output: string;
  errorLine: number | null;
}>;
export type ComputeShape = SQLTextAreaShape | PythonShape;
export interface PythonConfig { version: string; requirements: string[]; lock?: string }
export interface PythonAnalysis {
  dependencies: string[];
  needsSetup?: boolean;
  error?: string;
  line?: number;
  column?: number;
  traceback?: string;
}
export interface PythonResult extends PythonAnalysis {
  rowCount: number;
  schema: { name: string; type: string }[];
  output?: string;
}

export async function pythonRequest<T>(path: string, body?: unknown, signal?: AbortSignal, method = "POST"): Promise<T> {
  const response = await fetch(`/api/session/python${path}`, {
    method, credentials: "same-origin", signal,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Python request failed (${response.status})`);
  return data as T;
}

const reservedNames = new Set(["ArithmeticError", "AssertionError", "AttributeError", "BaseException", "BlockingIOError", "BrokenPipeError", "BufferError", "BytesWarning", "ChildProcessError", "ConnectionAbortedError", "ConnectionError", "ConnectionRefusedError", "ConnectionResetError", "DeprecationWarning", "EOFError", "Ellipsis", "EncodingWarning", "EnvironmentError", "Exception", "False", "FileExistsError", "FileNotFoundError", "FloatingPointError", "FutureWarning", "GeneratorExit", "IOError", "ImportError", "ImportWarning", "IndentationError", "IndexError", "InterruptedError", "IsADirectoryError", "KeyError", "KeyboardInterrupt", "LookupError", "MemoryError", "ModuleNotFoundError", "NameError", "None", "NotADirectoryError", "NotImplemented", "NotImplementedError", "OSError", "OverflowError", "PendingDeprecationWarning", "PermissionError", "ProcessLookupError", "RecursionError", "ReferenceError", "ResourceWarning", "RuntimeError", "RuntimeWarning", "StopAsyncIteration", "StopIteration", "SyntaxError", "SyntaxWarning", "SystemError", "SystemExit", "TabError", "TimeoutError", "True", "TypeError", "UnboundLocalError", "UnicodeDecodeError", "UnicodeEncodeError", "UnicodeError", "UnicodeTranslateError", "UnicodeWarning", "UserWarning", "ValueError", "Warning", "ZeroDivisionError", "__build_class__", "__debug__", "__doc__", "__import__", "__loader__", "__name__", "__package__", "__spec__", "abs", "aiter", "all", "and", "anext", "any", "as", "ascii", "assert", "async", "await", "bin", "bool", "break", "breakpoint", "bytearray", "bytes", "callable", "chr", "class", "classmethod", "compile", "complex", "continue", "copyright", "credits", "def", "del", "delattr", "dict", "dir", "divmod", "elif", "else", "enumerate", "eval", "except", "exec", "exit", "filter", "finally", "float", "for", "format", "from", "frozenset", "getattr", "global", "globals", "hasattr", "hash", "help", "hex", "id", "if", "import", "in", "input", "int", "is", "isinstance", "issubclass", "iter", "lambda", "len", "license", "list", "locals", "map", "max", "memoryview", "min", "next", "nonlocal", "not", "object", "oct", "open", "or", "ord", "pass", "pow", "print", "property", "quit", "raise", "range", "repr", "result", "return", "reversed", "round", "set", "setattr", "shapes", "slice", "sorted", "staticmethod", "str", "sum", "super", "try", "tuple", "type", "vars", "while", "with", "yield", "zip"]);
export function pythonShapeReference(name: string): string {
  return /^[A-Za-z_]\w*$/.test(name) && !reservedNames.has(name) ? name : `shapes[${JSON.stringify(name)}]`;
}
