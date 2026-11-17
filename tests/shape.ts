/** Compares JSON shapes (key paths and value types), not values. */

export type Shape =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "undefined"
  | { array: Shape | "empty" }
  | { object: Record<string, Shape> };

export function shapeOf(value: unknown): Shape {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return value.length === 0 ? { array: "empty" } : { array: shapeOf(value[0]) };
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return {
        object: Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, shapeOf(v)])),
      };
    default:
      return "undefined";
  }
}

/** Every key in `reference` must exist in `actual` with the same shape (actual may have extra keys). */
export function assertShapeCovers(actual: unknown, reference: unknown, label: string): void {
  const want = shapeOf(reference);
  const got = shapeOf(actual);
  const missing = diffShape(got, want, "");
  if (missing.length) {
    throw new Error(`${label}: mock response missing keys or wrong types:\n  ${missing.join("\n  ")}`);
  }
}

function diffShape(actual: Shape, reference: Shape, path: string): string[] {
  if (reference === actual) return [];
  if (typeof reference === "object" && "object" in reference && typeof actual === "object" && "object" in actual) {
    const errs: string[] = [];
    for (const [key, refShape] of Object.entries(reference.object)) {
      const child = actual.object[key];
      if (!child) errs.push(`${path}.${key} missing`);
      else errs.push(...diffShape(child, refShape, `${path}.${key}`));
    }
    return errs;
  }
  if (typeof reference === "object" && "array" in reference && typeof actual === "object" && "array" in actual) {
    if (reference.array === "empty") return actual.array === "empty" ? [] : [`${path}[] expected empty array`];
    if (actual.array === "empty") return [`${path}[] expected non-empty array`];
    return diffShape(actual.array, reference.array, `${path}[]`);
  }
  return [`${path || "(root)"}: expected ${fmt(reference)}, got ${fmt(actual)}`];
}

function fmt(s: Shape): string {
  if (typeof s === "object" && "array" in s) return s.array === "empty" ? "[]" : `array<${fmt(s.array)}>`;
  if (typeof s === "object" && "object" in s) return "object";
  return s;
}