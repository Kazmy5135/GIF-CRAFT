import type { ReferenceImageSnapshot } from "../../core/sourceImage";

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 32_000_000;
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("无法读取图片文件。"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

export async function getImageDimensions(
  source: Blob | string,
): Promise<{ width: number; height: number }> {
  if (source instanceof Blob && "createImageBitmap" in window) {
    const bitmap = await createImageBitmap(source, { imageOrientation: "from-image" });
    const dimensions = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return dimensions;
  }

  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = typeof source === "string" ? undefined : URL.createObjectURL(source);
    const releaseObjectUrl = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    image.onload = () => {
      const dimensions = { width: image.naturalWidth, height: image.naturalHeight };
      releaseObjectUrl();
      resolve(dimensions);
    };
    image.onerror = () => {
      releaseObjectUrl();
      reject(new Error("图片内容无法解码。"));
    };
    image.src = objectUrl || (typeof source === "string" ? source : "");
  });
}

export async function validateAndReadImage(
  file: File,
): Promise<ReferenceImageSnapshot> {
  if (!ALLOWED_TYPES.has(file.type)) {
    throw new Error("仅支持 PNG、JPEG 和 WebP 图片。" );
  }
  if (file.size === 0 || file.size > MAX_IMAGE_BYTES) {
    throw new Error("图片必须小于或等于 15 MB。" );
  }

  let dimensions: { width: number; height: number };
  try {
    dimensions = await getImageDimensions(file);
  } catch {
    throw new Error("图片已损坏或浏览器无法解码。" );
  }

  if (dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
    throw new Error("图片像素总量不能超过 3200 万。" );
  }

  const dataUrl = await readAsDataUrl(file);
  const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return {
    name: file.name,
    mimeType: file.type,
    data,
    width: dimensions.width,
    height: dimensions.height,
    size: file.size,
  };
}

export function referenceImageDataUrl(image: ReferenceImageSnapshot): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

export function nearestAspectRatio(width: number, height: number) {
  const value = width / height;
  const ratios = [
    ["1:1", 1],
    ["3:2", 3 / 2],
    ["2:3", 2 / 3],
    ["16:9", 16 / 9],
    ["9:16", 9 / 16],
  ] as const;
  return ratios.reduce((best, item) =>
    Math.abs(item[1] - value) < Math.abs(best[1] - value) ? item : best,
  )[0];
}
