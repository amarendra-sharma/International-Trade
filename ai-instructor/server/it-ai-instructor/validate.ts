// validate.ts - small strict JSON-schema subset validator. Unknown properties are rejected, never ignored.
// Used for HTTP requests, model-requested tool inputs, and tool outputs.
export type Schema =
  | { type: "string"; minLength?: number; maxLength?: number; enum?: readonly string[]; pattern?: string }
  | { type: "integer" | "number"; minimum?: number; maximum?: number }
  | { type: "boolean" }
  | { type: "array"; items: Schema; maxItems?: number; minItems?: number }
  | { type: "object"; properties: Record<string, Schema>; required?: readonly string[]; additionalProperties?: false };

export class ValidationError extends Error {
  constructor(public path: string, message: string) { super(`${path || "$"}: ${message}`); this.name = "ValidationError"; }
}

export function validate(schema: Schema, value: unknown, path = ""): unknown {
  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") throw new ValidationError(path, "expected string");
      if (schema.minLength !== undefined && value.length < schema.minLength) throw new ValidationError(path, "too short");
      if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new ValidationError(path, "too long");
      if (schema.enum && !schema.enum.includes(value)) throw new ValidationError(path, "not an allowed value");
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw new ValidationError(path, "bad format");
      return value;
    }
    case "integer":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new ValidationError(path, "expected number");
      if (schema.type === "integer" && !Number.isInteger(value)) throw new ValidationError(path, "expected integer");
      if (schema.minimum !== undefined && value < schema.minimum) throw new ValidationError(path, "below minimum");
      if (schema.maximum !== undefined && value > schema.maximum) throw new ValidationError(path, "above maximum");
      return value;
    }
    case "boolean":
      if (typeof value !== "boolean") throw new ValidationError(path, "expected boolean");
      return value;
    case "array": {
      if (!Array.isArray(value)) throw new ValidationError(path, "expected array");
      if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new ValidationError(path, "too many items");
      if (schema.minItems !== undefined && value.length < schema.minItems) throw new ValidationError(path, "too few items");
      return value.map((v, i) => validate(schema.items, v, `${path}[${i}]`));
    }
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ValidationError(path, "expected object");
      const obj = value as Record<string, unknown>, out: Record<string, unknown> = {};
      for (const k of Object.keys(obj)) {
        if (k === "__proto__" || k === "constructor" || k === "prototype") throw new ValidationError(`${path}.${k}`, "forbidden key");
        if (!(k in schema.properties)) throw new ValidationError(`${path}.${k}`, "unknown property");
      }
      for (const r of schema.required ?? []) if (!(r in obj) || obj[r] === undefined) throw new ValidationError(`${path}.${r}`, "required");
      for (const [k, s] of Object.entries(schema.properties)) if (k in obj && obj[k] !== undefined) out[k] = validate(s, obj[k], `${path}.${k}`);
      return out;
    }
  }
}
