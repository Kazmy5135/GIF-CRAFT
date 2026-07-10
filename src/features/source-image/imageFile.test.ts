import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_IMAGE_BYTES,
  nearestAspectRatio,
  validateAndReadImage,
} from "./imageFile";

describe("source image upload validation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects unsupported image formats before decoding", async () => {
    const file = new File(["not an image"], "asset.gif", { type: "image/gif" });

    await expect(validateAndReadImage(file)).rejects.toThrow("PNG、JPEG 和 WebP");
  });

  it("rejects files over the upload limit before decoding", async () => {
    const file = new File(["image"], "large.png", { type: "image/png" });
    Object.defineProperty(file, "size", { value: MAX_IMAGE_BYTES + 1 });

    await expect(validateAndReadImage(file)).rejects.toThrow("15 MB");
  });

  it("rejects image bytes that the browser cannot decode", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("decode failed")));
    const file = new File(["broken"], "broken.webp", { type: "image/webp" });

    await expect(validateAndReadImage(file)).rejects.toThrow("已损坏");
  });

  it("selects the nearest supported aspect ratio", () => {
    expect(nearestAspectRatio(1920, 1080)).toBe("16:9");
    expect(nearestAspectRatio(800, 1200)).toBe("2:3");
  });
});
