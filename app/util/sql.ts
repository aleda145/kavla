export const toValidSqlName = (name: string): string => {
  let validName = name.split(".").slice(0, -1).join(".") || name;

  validName = validName.toLowerCase();

  validName = validName.replace(/[^a-z0-9_]/g, "_");

  validName = validName.replace(/__+/g, "_");

  validName = validName.replace(/^[^a-z_]+/, "");

  if (!validName) {
    return "unnamed";
  }

  return validName;
};
