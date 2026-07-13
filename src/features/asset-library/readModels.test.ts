import { describe, expect, it } from "vitest";
import {
  buildSequenceLibraryItems,
  buildSourceImageLibraryItems,
  filterSequenceLibraryItems,
  filterSourceImageLibraryItems,
  getSequenceResourceStatus,
} from "./readModels";
import { generationJob, sourceAsset, storedJob } from "./testFixtures";

describe("asset library read models", () => {
  it("sorts and classifies source images without taking ownership of source data", () => {
    const confirmed = sourceAsset();
    const unconfirmed = sourceAsset({
      id: "source-2",
      createdAt: "2026-07-13T10:00:00.000Z",
      confirmedAt: undefined,
      contentSnapshotId: undefined,
      availability: "unknown",
    });
    const items = buildSourceImageLibraryItems([confirmed, unconfirmed], confirmed.id);

    expect(items.map((item) => item.asset.id)).toEqual(["source-2", "source-1"]);
    expect(items[0].availability).toBe("unconfirmed");
    expect(items[1]).toMatchObject({ availability: "available", isCurrent: true });
    expect(filterSourceImageLibraryItems(items, "available")).toHaveLength(1);
    expect(items[1].asset).toBe(confirmed);
  });

  it("uses completed integrity and storage summary to guard usable sequences", () => {
    const available = storedJob(generationJob("completed"));
    const purged = storedJob(
      generationJob("completed", { id: "job-purged" }),
      { id: "job-purged", resultStorageStatus: "purged" },
    );
    const failed = storedJob(generationJob("failed"));
    const items = buildSequenceLibraryItems([failed, purged, available], [sourceAsset()]);

    expect(getSequenceResourceStatus(available)).toBe("available");
    expect(getSequenceResourceStatus(purged)).toBe("purged");
    expect(getSequenceResourceStatus(failed)).toBe("not_available");
    expect(filterSequenceLibraryItems(items, "usable").map((item) => item.job.id)).toEqual([
      "job-completed",
    ]);
    expect(filterSequenceLibraryItems(items, "failed")).toHaveLength(1);
  });

  it("does not offer redo when the current source bytes differ from the frozen request", () => {
    const item = buildSequenceLibraryItems(
      [storedJob(generationJob("completed"))],
      [sourceAsset({ contentSnapshotId: `sha256:${"b".repeat(64)}` })],
    )[0];

    expect(item.sourceAvailable).toBe(false);
  });
});
