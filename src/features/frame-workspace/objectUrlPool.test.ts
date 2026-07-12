import { ObjectUrlPool } from "./objectUrlPool";
import { describe, expect, it, vi } from "vitest";

describe("ObjectUrlPool", () => {
  it("复用相同 Blob、按容量回收并可整体释放", () => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "" });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => undefined });
    const create = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => `blob:${(blob as Blob).size}:${Math.random()}`);
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const pool = new ObjectUrlPool(2);
    const first = new Blob(["a"], { type: "image/png" });
    const second = new Blob(["bb"], { type: "image/png" });
    const third = new Blob(["ccc"], { type: "image/png" });

    expect(pool.acquire("a", first)).toBe(pool.acquire("a", first));
    pool.acquire("b", second);
    pool.acquire("c", third);

    expect(create).toHaveBeenCalledTimes(3);
    expect(revoke).toHaveBeenCalledTimes(1);
    pool.clear();
    expect(revoke).toHaveBeenCalledTimes(3);
  });
});
