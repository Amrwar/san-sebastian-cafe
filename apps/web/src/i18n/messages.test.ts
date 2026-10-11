import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import fr from "../../messages/fr.json";

function flatten(obj: Record<string, unknown>, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object")
      Object.assign(out, flatten(value as Record<string, unknown>, path));
    else out[path] = String(value);
  }
  return out;
}

// ICU argument names: `{name}` or `{name, plural|select, …}`. Branch text such as `{No options}`
// is not an argument, so require `}` or `,` right after the name.
const placeholders = (s: string) =>
  [...new Set([...s.matchAll(/\{(\w+)\s*[,}]/g)].map((m) => m[1]))].sort();

describe("message catalogs", () => {
  const frFlat = flatten(fr);
  const enFlat = flatten(en);

  it("French and English define exactly the same keys", () => {
    expect(Object.keys(enFlat).sort()).toEqual(Object.keys(frFlat).sort());
  });

  it("no message is empty", () => {
    for (const [key, value] of [...Object.entries(frFlat), ...Object.entries(enFlat)]) {
      expect(value.trim(), key).not.toBe("");
    }
  });

  it("both languages use the same ICU placeholders", () => {
    for (const key of Object.keys(frFlat)) {
      expect(placeholders(enFlat[key] ?? ""), key).toEqual(placeholders(frFlat[key] ?? ""));
    }
  });
});
