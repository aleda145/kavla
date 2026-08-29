import type { Editor } from "tldraw";

export function getUniqueName(editor: Editor, desiredName: string, currentShapeId?: string): string {
  let finalName = desiredName;
  let counter = 1;

  const existingNames = new Set(
    editor
      .getCurrentPageShapes()
      .filter((shape) => shape.id !== currentShapeId)
      .map((shape) =>
        "name" in shape.props && typeof shape.props.name === "string" ? shape.props.name.toLowerCase() : null
      )
      .filter((name): name is string => name !== null)
  );

  while (existingNames.has(finalName.toLowerCase())) {
    finalName = `${desiredName}_${counter}`;
    counter++;
  }

  return finalName;
}
