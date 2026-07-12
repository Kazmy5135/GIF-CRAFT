import { useCallback, useEffect, useRef, useState } from "react";
import type { SequenceLoopMode } from "../../core/sequenceGeneration";

export function playbackIndexAt(input: {
  startedIndex: number;
  elapsedMs: number;
  frameRate: number;
  frameCount: number;
  loopMode: SequenceLoopMode;
}): { index: number; ended: boolean } {
  if (input.frameCount <= 0) return { index: 0, ended: true };
  const elapsedFrames = Math.floor((Math.max(0, input.elapsedMs) / 1000) * input.frameRate);
  const rawIndex = input.startedIndex + elapsedFrames;
  if (input.loopMode === "once" && rawIndex >= input.frameCount) {
    return { index: input.frameCount - 1, ended: true };
  }
  return { index: rawIndex % input.frameCount, ended: false };
}

export function usePreviewPlayback(input: {
  frameIds: readonly string[];
  frameRate: number;
  loopMode: SequenceLoopMode;
  selectedId: string | null;
  onSelect: (frameId: string) => void;
}) {
  const [playing, setPlaying] = useState(false);
  const startedAt = useRef(0);
  const startedIndex = useRef(0);
  const frameRequest = useRef<number | null>(null);
  const inputRef = useRef(input);
  inputRef.current = input;

  const selectIndex = useCallback((index: number) => {
    const current = inputRef.current;
    const count = current.frameIds.length;
    if (!count) return;
    const normalized = Math.max(0, Math.min(count - 1, index));
    current.onSelect(current.frameIds[normalized]);
  }, []);

  const pause = useCallback(() => setPlaying(false), []);

  const play = useCallback(() => {
    const current = inputRef.current;
    if (current.frameIds.length < 2) return;
    const selectedIndex = Math.max(0, current.frameIds.indexOf(current.selectedId ?? ""));
    startedIndex.current = selectedIndex >= current.frameIds.length - 1 && current.loopMode === "once" ? 0 : selectedIndex;
    startedAt.current = performance.now();
    if (startedIndex.current !== selectedIndex) selectIndex(startedIndex.current);
    setPlaying(true);
  }, [selectIndex]);

  const restart = useCallback(() => {
    selectIndex(0);
    startedIndex.current = 0;
    startedAt.current = performance.now();
  }, [selectIndex]);

  const step = useCallback((delta: -1 | 1) => {
    setPlaying(false);
    const current = inputRef.current;
    const selectedIndex = Math.max(0, current.frameIds.indexOf(current.selectedId ?? ""));
    selectIndex(selectedIndex + delta);
  }, [selectIndex]);

  useEffect(() => {
    if (!playing) return;
    const tick = (now: number) => {
      const current = inputRef.current;
      if (document.hidden || current.frameIds.length < 2) {
        setPlaying(false);
        return;
      }
      const position = playbackIndexAt({
        startedIndex: startedIndex.current,
        elapsedMs: now - startedAt.current,
        frameRate: current.frameRate,
        frameCount: current.frameIds.length,
        loopMode: current.loopMode,
      });
      if (position.ended) {
        selectIndex(position.index);
        setPlaying(false);
        return;
      }
      selectIndex(position.index);
      frameRequest.current = requestAnimationFrame(tick);
    };
    frameRequest.current = requestAnimationFrame(tick);
    return () => {
      if (frameRequest.current !== null) cancelAnimationFrame(frameRequest.current);
      frameRequest.current = null;
    };
  }, [playing, selectIndex]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden) setPlaying(false);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  return { playing, play, pause, restart, step };
}
