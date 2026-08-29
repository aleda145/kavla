import React, { useState, useEffect } from "react";
import { useToasts } from "tldraw";

import { getUniqueName } from "./getUniqueName";
import { toValidSqlName } from "./sql";

interface EditableTextProps {
  text: string;
  onSave: (newText: string) => void;
  editor: any;
  shapeId: string;
}

const EditableText: React.FC<EditableTextProps> = ({ text, onSave, editor, shapeId }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [value, setValue] = useState(text);
  const { addToast } = useToasts();

  useEffect(() => {
    setValue(text);
  }, [text]);

  const handleEditClick = () => {
    setIsEditing(true);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setValue(e.target.value);
  };

  const handleBlur = () => {
    setIsEditing(false);
    const validSqlName = toValidSqlName(value);

    if (!validSqlName) {
      addToast({
        title: "Invalid Name",
        description: "Please enter a valid name.",
      });
      setValue(text); // Revert to original text
      return;
    }

    const uniqueName = getUniqueName(editor, validSqlName, shapeId);
    if (uniqueName !== value) {
      addToast({
        title: "Name Updated",
        description: `The name has been changed to ${uniqueName}.`,
      });
    }
    onSave(uniqueName);
    setValue(uniqueName);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      handleBlur();
    }
  };

  return (
    <div style={{ display: "flex", alignItems: "center" }}>
      {isEditing ? (
        <input
          type="text"
          value={value}
          onChange={handleChange}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          autoFocus
          style={{ flexGrow: 1 }}
        />
      ) : (
        <>
          <button
            onClick={handleEditClick}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (e.pointerType === "touch") {
                handleEditClick();
              }
            }}
            title="Edit name"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "0.8em",
              touchAction: "none",
            }}
          >
            <h3 style={{ margin: 0, marginRight: 5, fontSize: "1.5em" }}>{text}</h3>
            ✏️
          </button>
        </>
      )}
    </div>
  );
};

export default EditableText;
