const { z } = require("zod");

// Define the field schema
const fieldSchema = z.object({
  name: z.string(),
  type: z.string().optional().default("any"),
  unit: z.string().optional().default(""),
  hidden: z.boolean().optional().default(false),
  description: z.string().optional().default(""),
});

// Type for the fields array
const fieldsSchema = z.array(fieldSchema);

/**
 * Function to convert JSON fields to TypeScript definitions
 * @param {Array} fields - The array of field objects to be converted
 * @returns {Object} - The TypeScript definitions object
 */
function convertSchemaToJSON(fields) {
  // Validate fields
  const validatedFields = fieldsSchema.parse(fields);

  const defs = {};

  validatedFields.forEach((field) => {
    const type = field.type || "any"; // Directly use the type from the field
    const path = field.name.split(".");

    let current = defs;

    path.forEach((key, index) => {
      // Ensure the current level is initialized as an object or the final type
      if (!current[key]) {
        current[key] = index === path.length - 1 ? type : {};
      } else if (
        index === path.length - 1 &&
        typeof current[key] === "object"
      ) {
        // If the final level was previously initialized as an object, overwrite with the type
        current[key] = type;
      }

      current = current[key] || {};
    });
  });

  return defs;
}

/**
 * Helper function to convert object to type definition string
 * @param {Object} defs - The object containing type definitions
 * @param {number} [indent=2] - The number of spaces to use for indentation
 * @returns {string} - The formatted type definition string
 */
function getStringifiedSchema(defs, indent = 2) {
  const entries = Object.entries(defs);
  const spaces = " ".repeat(indent);

  return `{
${entries
  .map(([key, value]) => {
    if (typeof value === "string") {
      return `${spaces}${key}: ${value};`;
    }

    return `${spaces}${key}: ${getStringifiedSchema(value, indent + 2)};`;
  })
  .join("\n")}
${" ".repeat(indent - 2)}}`;
}

module.exports = {
  convertSchemaToJSON,
  getStringifiedSchema,
  fieldsSchema,
};
