/**
 * Minimal zod -> JSON Schema converter that covers the subset our tools use:
 * z.object, z.string, z.number, z.boolean, z.array, z.enum, z.optional,
 * z.default, z.describe.
 *
 * For anything more exotic, switch to the `zod-to-json-schema` package.
 */

import type { z } from "zod";

interface JSONSchema {
  type?: string | string[];
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: unknown[];
  description?: string;
  default?: unknown;
  additionalProperties?: boolean;
  minimum?: number;
  maximum?: number;
}

export function zodToJsonSchema(schema: z.ZodTypeAny): JSONSchema {
  const def = (schema as any)._def;
  const desc = (schema as any).description;
  const out: JSONSchema = desc ? { description: desc } : {};

  switch (def.typeName) {
    case "ZodString":
      out.type = "string";
      return out;
    case "ZodNumber":
      out.type = "number";
      for (const c of def.checks ?? []) {
        if (c.kind === "int") out.type = "integer";
        if (c.kind === "min") out.minimum = c.value;
        if (c.kind === "max") out.maximum = c.value;
      }
      return out;
    case "ZodBoolean":
      out.type = "boolean";
      return out;
    case "ZodEnum":
      out.type = "string";
      out.enum = def.values;
      return out;
    case "ZodArray":
      out.type = "array";
      out.items = zodToJsonSchema(def.type);
      return out;
    case "ZodObject": {
      out.type = "object";
      const shape = def.shape() as Record<string, z.ZodTypeAny>;
      out.properties = {};
      out.required = [];
      out.additionalProperties = false;
      for (const [k, v] of Object.entries(shape)) {
        const inner = zodToJsonSchema(v);
        out.properties[k] = inner;
        const t = (v as any)._def.typeName;
        if (t !== "ZodOptional" && t !== "ZodDefault") out.required.push(k);
      }
      if (out.required.length === 0) delete out.required;
      return out;
    }
    case "ZodOptional":
      return zodToJsonSchema(def.innerType);
    case "ZodDefault": {
      const inner = zodToJsonSchema(def.innerType);
      inner.default = def.defaultValue();
      return inner;
    }
    case "ZodLiteral":
      return { type: typeof def.value, enum: [def.value] };
    case "ZodDiscriminatedUnion": {
      // A discriminated union of objects (context_write's kinds) is an
      // OBJECT to every provider - Anthropic rejects a top-level type
      // that is not 'object' and the old fallthrough emitted one
      // (2 Sept 2026). anyOf keeps each variant's own shape.
      // Anthropic also rejects oneOf/anyOf/allOf at the top level, so
      // flatten: the union of every variant's properties, with the
      // discriminator as an enum and the only required key. The tool's
      // own zod .parse() still enforces the exact variant at run time.
      const opts = Array.from(def.options.values() as Iterable<z.ZodTypeAny>).map((o) => zodToJsonSchema(o));
      const properties: Record<string, unknown> = {};
      const discValues: unknown[] = [];
      for (const o of opts) {
        for (const [k, v] of Object.entries((o.properties ?? {}) as Record<string, unknown>)) {
          if (k === def.discriminator) {
            const en = (v as { enum?: unknown[] }).enum ?? [];
            for (const e of en) if (!discValues.includes(e)) discValues.push(e);
            continue;
          }
          if (!(k in properties)) properties[k] = v;
        }
      }
      properties[def.discriminator] = { type: "string", enum: discValues };
      return { type: "object", properties, required: [def.discriminator] } as JSONSchema;
    }
    case "ZodUnion": {
      // Reduce to the JSON-Schema-friendly common parent of literals/enums.
      const opts = def.options.map(zodToJsonSchema);
      // Best-effort: collapse string-literal unions to enum.
      if (opts.every((o: JSONSchema) => o.type === "string" && o.enum?.length === 1)) {
        return {
          type: "string",
          enum: opts.flatMap((o: JSONSchema) => o.enum as unknown[]),
        };
      }
      return { type: opts[0]?.type } as JSONSchema;
    }
    default:
      return { type: "string", description: `unsupported zod type ${def.typeName}` };
  }
}
