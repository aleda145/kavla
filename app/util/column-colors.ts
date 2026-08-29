export const getColumnTypeColor = (type: string): string => {
  const t = type.toUpperCase();
  if (t.includes("STRUCT") || t.includes("LIST") || t.includes("MAP") || t.includes("[]") || t.includes("JSON")) {
    return "bg-purple-200";
  }
  if (t.includes("INT") || t.includes("FLOAT") || t.includes("DOUBLE") || t.includes("DECIMAL") || t.includes("REAL")) {
    return "bg-cyan-200";
  }
  if (t.includes("CHAR") || t.includes("STRING") || t.includes("TEXT") || t.includes("UTF8")) {
    return "bg-orange-200";
  }
  if (t.includes("DATE") || t.includes("TIMESTAMP") || t.includes("TIME")) {
    return "bg-lime-200";
  }
  if (t.includes("BOOL")) {
    return "bg-pink-200";
  }
  return "";
};

// For use in the SQL Editor - more muted to avoid distraction
export const getColumnTypeMutedColor = (type: string): string => {
  const t = type.toUpperCase();
  if (t.includes("STRUCT") || t.includes("LIST") || t.includes("MAP") || t.includes("[]") || t.includes("JSON")) {
    return "bg-purple-100";
  }
  if (t.includes("INT") || t.includes("FLOAT") || t.includes("DOUBLE") || t.includes("DECIMAL") || t.includes("REAL")) {
    return "bg-cyan-100";
  }
  if (t.includes("CHAR") || t.includes("STRING") || t.includes("TEXT")) {
    return "bg-orange-100";
  }
  if (t.includes("DATE") || t.includes("TIMESTAMP") || t.includes("TIME")) {
    return "bg-lime-100";
  }
  if (t.includes("BOOL")) {
    return "bg-pink-100";
  }
  return "";
};
