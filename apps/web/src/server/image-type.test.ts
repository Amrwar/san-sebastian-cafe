import { describe, expect, it } from "vitest";
import { detectImageType } from "./image-type";

const bytes = (...parts: Array<number[] | string>) =>
  new Uint8Array(
    parts.flatMap((p) => (typeof p === "string" ? [...new TextEncoder().encode(p)] : p)),
  );

describe("detectImageType", () => {
  it("recognises JPEG, PNG and WebP by signature", () => {
    expect(detectImageType(bytes([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))).toBe("jpeg");
    expect(detectImageType(bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("png");
    expect(detectImageType(bytes("RIFF", [1, 2, 3, 4], "WEBPVP8 "))).toBe("webp");
  });

  it("rejects anything else, whatever its name", () => {
    expect(detectImageType(bytes("GIF89a"))).toBeNull();
    expect(detectImageType(bytes("<svg xmlns="))).toBeNull();
    expect(detectImageType(bytes("RIFF", [1, 2, 3, 4], "WAVE"))).toBeNull();
    expect(detectImageType(bytes([0xff, 0xd8]))).toBeNull();
    expect(detectImageType(new Uint8Array())).toBeNull();
  });
});
