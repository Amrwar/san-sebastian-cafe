import { parse, TYPE, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";
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

/** Argument names used by an ICU message (parsed properly, including plural/select branches). */
function placeholders(message: string): string[] {
  const names = new Set<string>();
  const walk = (elements: MessageFormatElement[]) => {
    for (const el of elements) {
      if ("value" in el && el.type !== TYPE.literal) names.add(el.value);
      if ("options" in el) {
        for (const option of Object.values(el.options)) walk(option.value);
      }
      if ("children" in el) walk(el.children);
    }
  };
  walk(parse(message));
  return [...names].sort();
}

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
