import type { PythonShape } from "../Python/types";
import { useEditor } from "tldraw";
import { useEffect, useState } from "react";
import { SQLTextAreaShape } from "../SQLTextArea/sql-text-area-types";
import { DataSourceShape } from "../DataSource/data-source-types";

const isSchemaNode = (shape: import("tldraw").TLShape): shape is SQLTextAreaShape | PythonShape | DataSourceShape => {
  return (shape.type === "python-text-area" || shape.type === "sql-text-area") || shape.type === "data-source";
};

export interface SchemaRegistry {
  [nodeId: string]: {
    tableName: string;
    columns: Array<{ name: string; type: string }>;
    type: "sql-text-area" | "python-text-area" | "data-source";
  };
}

export const useSchemaRegistry = () => {
  const editor = useEditor();
  const [registry, setRegistry] = useState<SchemaRegistry>({});

  useEffect(() => {
    const scan = () => {
      const shapes = editor.getCurrentPageShapes();
      const newRegistry: SchemaRegistry = {};

      for (const shape of shapes) {
        if (isSchemaNode(shape)) {
          let columns: { name: string; type: string }[] = [];

          if ("outputSchema" in shape.props && shape.props.outputSchema) {
            columns = shape.props.outputSchema;
          } else if ("metadata" in shape.props && shape.props.metadata) {
            columns = shape.props.metadata;
          }

          {
            newRegistry[shape.id] = {
              tableName: shape.props.name,
              columns,
              type: shape.type,
            };
          }
        }
      }
      return newRegistry;
    };

    setRegistry(scan());

    const unsubscribe = editor.store.listen((entry) => {
      if (entry.changes.added || entry.changes.updated || entry.changes.removed) {
        const relevantChange =
          Object.values(entry.changes.added).some(
            (r) => r.typeName === "shape" && (r.type === "python-text-area" || r.type === "sql-text-area" || r.type === "data-source")
          ) ||
          Object.values(entry.changes.updated).some(
            (u) => u[1].typeName === "shape" && (u[1].type === "python-text-area" || u[1].type === "sql-text-area" || u[1].type === "data-source")
          ) ||
          Object.values(entry.changes.removed).some(
            (r) => r.typeName === "shape" && (r.type === "python-text-area" || r.type === "sql-text-area" || r.type === "data-source")
          );

        if (relevantChange) {
          setRegistry(scan());
        }
      }
    });

    return () => {
      unsubscribe();
    };
  }, [editor]);

  return registry;
};
