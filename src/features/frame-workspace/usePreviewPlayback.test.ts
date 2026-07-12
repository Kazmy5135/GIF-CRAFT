import { describe, expect, it } from "vitest";
import { playbackIndexAt } from "./usePreviewPlayback";

describe("playbackIndexAt", () => {
  it("以单调时间基准计算 8/12 FPS，不累计定时器漂移", () => {
    expect(playbackIndexAt({ startedIndex: 0, elapsedMs: 499, frameRate: 8, frameCount: 8, loopMode: "loop" })).toEqual({ index: 3, ended: false });
    expect(playbackIndexAt({ startedIndex: 2, elapsedMs: 500, frameRate: 12, frameCount: 12, loopMode: "loop" })).toEqual({ index: 8, ended: false });
    expect(playbackIndexAt({ startedIndex: 7, elapsedMs: 125, frameRate: 8, frameCount: 8, loopMode: "loop" })).toEqual({ index: 0, ended: false });
  });

  it("单次播放在最后一帧确定停止", () => {
    expect(playbackIndexAt({ startedIndex: 1, elapsedMs: 750, frameRate: 8, frameCount: 6, loopMode: "once" })).toEqual({ index: 5, ended: true });
  });
});
