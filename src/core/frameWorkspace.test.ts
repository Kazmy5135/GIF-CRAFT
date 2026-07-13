import { describe, expect, it } from "vitest";
import {
  acceptRetryCandidate,
  attachRetryCandidate,
  canTransitionFrameRetryAttempt,
  countWorkspaceDecisions,
  createFrameWorkspace,
  createFrameWorkspaceSnapshot,
  discardRetryCandidate,
  filterWorkspaceSlots,
  FrameWorkspaceConflictError,
  guardFrameWorkspaceHandoff,
  markFrameWorkspacePersisted,
  moveFrameSlot,
  moveFrameSlotTo,
  registerFrameRetryAttempt,
  removeFrame,
  restoreFrame,
  restoreFrameWorkspaceDefaults,
  restoreOriginalFrame,
  setFrameDecision,
  setFrameWorkspaceFrameRate,
  transitionFrameRetryAttempt,
  transitionWorkspaceRetryAttempt,
  validateFrameWorkspaceSnapshot,
  type FrameRetryAttempt,
  type FrameRevision,
  type FrameWorkspace,
} from "./frameWorkspace";
import type { Frame, FrameWorkspaceHandoff } from "./sequenceGeneration";

const t0 = "2026-07-12T01:00:00.000Z";
const t1 = "2026-07-12T01:01:00.000Z";

function frame(index: number, overrides: Partial<Frame> = {}): Frame {
  return {
    id: `frame-${index}`,
    jobId: "job-1",
    providerIndex: index,
    sequenceIndex: index,
    resourceRef: `frame-resource:${index}`,
    mimeType: "image/png",
    width: 512,
    height: 512,
    size: 100,
    readable: true,
    createdAt: t0,
    ...overrides,
  };
}

function handoff(frames: readonly Frame[] = [frame(0), frame(1), frame(2)]): FrameWorkspaceHandoff {
  return {
    jobId: "job-1",
    presetId: "character.idle.v1",
    presetVersion: 1,
    frames,
    frameRate: 8,
    loopMode: "loop",
    canvas: { mode: "source", aspectRatio: "1:1", width: 512, height: 512 },
    anchor: "bottom_center_feet_baseline",
  };
}

function workspace(): FrameWorkspace {
  return createFrameWorkspace({ workspaceId: "workspace-1", handoff: handoff(), createdAt: t0 });
}

function options(workspace: FrameWorkspace, updatedAt = t1) {
  return { expectedRevision: workspace.revision, updatedAt };
}

function attempt(workspace: FrameWorkspace, slotId = workspace.orderedSlotIds[1]!, overrides: Partial<FrameRetryAttempt> = {}): FrameRetryAttempt {
  const slot = workspace.slots[slotId]!;
  return {
    id: "attempt-1",
    workspaceId: workspace.workspaceId,
    slotId,
    originalSequenceIndex: slot.originalSequenceIndex,
    parentJobId: workspace.sourceJobId,
    clientRequestId: "retry-request-1",
    executionMode: "full_sequence_fallback",
    inputSnapshot: {
      targetFrameId: slot.originalFrameId,
      originalSequenceIndex: slot.originalSequenceIndex,
      parentJobId: workspace.sourceJobId,
      workspaceRevision: workspace.revision,
      previousFrameId: "frame-0",
      nextFrameId: "frame-2",
      prompt: "keep identity and motion continuity",
    },
    status: "submitting",
    createdAt: t1,
    updatedAt: t1,
    ...overrides,
  };
}

function candidate(workspace: FrameWorkspace, retry: FrameRetryAttempt): FrameRevision {
  return {
    id: "revision:candidate:1",
    workspaceId: workspace.workspaceId,
    slotId: retry.slotId,
    source: "retry_candidate",
    retryAttemptId: retry.id,
    resourceRef: "candidate-resource:1",
    mimeType: "image/png",
    width: 512,
    height: 512,
    size: 120,
    readable: true,
    createdAt: t1,
    isCurrent: false,
  };
}

function keepAll(workspace: FrameWorkspace): FrameWorkspace {
  return workspace.orderedSlotIds.reduce(
    (current, slotId, index) =>
      setFrameDecision(current, slotId, "kept", options(current, `2026-07-12T01:0${index + 1}:00.000Z`)),
    workspace,
  );
}

describe("frame workspace handoff and creation", () => {
  it("creates stable original slots and revisions without mutating source frames", () => {
    const frames = [frame(2), frame(0), frame(1)];
    const originalOrder = frames.map((item) => item.sequenceIndex);
    const result = createFrameWorkspace({ workspaceId: "workspace-1", handoff: handoff(frames), createdAt: t0 });

    expect(frames.map((item) => item.sequenceIndex)).toEqual(originalOrder);
    expect(result.orderedSlotIds).toEqual(["slot:frame-0", "slot:frame-1", "slot:frame-2"]);
    expect(result.slots["slot:frame-1"]).toMatchObject({
      originalFrameId: "frame-1",
      originalSequenceIndex: 1,
      decision: "pending",
      currentRevisionId: "revision:original:frame-1",
    });
    expect(result.revisions["revision:original:frame-1"]).toMatchObject({
      source: "original",
      resourceRef: "frame-resource:1",
      isCurrent: true,
    });
    expect(result.revision).toBe(0);
    expect(result.playbackFrameRate).toBe(8);
  });

  it("rejects unreadable, foreign, duplicated, non-contiguous and dimension-mismatched input", () => {
    const guarded = guardFrameWorkspaceHandoff(
      handoff([
        frame(0, { readable: false }),
        frame(1, { jobId: "other-job", providerIndex: 0, sequenceIndex: 2, width: 256 }),
      ]),
    );

    expect(guarded.ok).toBe(false);
    if (guarded.ok) throw new Error("invalid fixture expectation");
    expect(guarded.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "invalid_frame_resource",
        "frame_job_mismatch",
        "duplicate_provider_index",
        "sequence_index_gap",
        "dimension_mismatch",
      ]),
    );
    expect(() => createFrameWorkspace({ workspaceId: "workspace-1", handoff: handoff([]), createdAt: t0 })).toThrow(
      "工作区交接无效",
    );
  });
});

describe("review, removal and stable sorting", () => {
  it("filters and counts deterministic review decisions", () => {
    let result = workspace();
    result = setFrameDecision(result, result.orderedSlotIds[0]!, "kept", options(result));
    result = removeFrame(result, result.orderedSlotIds[1]!, options(result));

    expect(countWorkspaceDecisions(result)).toEqual({ pending: 1, kept: 1, removed: 1 });
    expect(filterWorkspaceSlots(result, "removed").map((slot) => slot.originalFrameId)).toEqual(["frame-1"]);
    expect(filterWorkspaceSlots(result, "all")).toHaveLength(3);
  });

  it("removes non-destructively and restores into the same stable ordered position", () => {
    const initial = workspace();
    const slotId = initial.orderedSlotIds[1]!;
    const revisionId = initial.slots[slotId]!.currentRevisionId;
    const removed = removeFrame(initial, slotId, options(initial));
    const restored = restoreFrame(removed, slotId, { ...options(removed), decision: "kept" });

    expect(removed.orderedSlotIds).toEqual(initial.orderedSlotIds);
    expect(removed.revisions[revisionId]).toBe(initial.revisions[revisionId]);
    expect(restored.orderedSlotIds).toEqual(initial.orderedSlotIds);
    expect(restored.slots[slotId]!.decision).toBe("kept");
  });

  it("uses the same stable ordering for buttons and drag placement without changing original indexes", () => {
    const initial = workspace();
    const moved = moveFrameSlot(initial, "slot:frame-0", "last", options(initial));
    const dragged = moveFrameSlotTo(moved, "slot:frame-0", "slot:frame-1", "before", options(moved));

    expect(moved.orderedSlotIds).toEqual(["slot:frame-1", "slot:frame-2", "slot:frame-0"]);
    expect(dragged.orderedSlotIds).toEqual(["slot:frame-0", "slot:frame-1", "slot:frame-2"]);
    expect(Object.values(dragged.slots).map((slot) => slot.originalSequenceIndex).sort()).toEqual([0, 1, 2]);
    expect(moveFrameSlot(dragged, "slot:frame-0", "backward", options(dragged))).toBe(dragged);
  });
});

describe("revision concurrency", () => {
  it("rejects stale edits with an explicit reload recovery action", () => {
    const initial = workspace();
    const savedElsewhere = setFrameDecision(initial, "slot:frame-0", "kept", options(initial));

    expect(() => removeFrame(savedElsewhere, "slot:frame-1", { expectedRevision: 0, updatedAt: t1 })).toThrow(
      FrameWorkspaceConflictError,
    );
    try {
      removeFrame(savedElsewhere, "slot:frame-1", { expectedRevision: 0, updatedAt: t1 });
    } catch (error) {
      expect(error).toMatchObject({
        code: "workspace_revision_conflict",
        recoveryAction: "reload_workspace",
        expectedRevision: 0,
        actualRevision: 1,
      });
    }
  });

  it("keeps repeated no-op decisions and boundary moves idempotent", () => {
    const kept = setFrameDecision(workspace(), "slot:frame-0", "kept", { expectedRevision: 0, updatedAt: t1 });
    expect(setFrameDecision(kept, "slot:frame-0", "kept", options(kept))).toBe(kept);
    expect(moveFrameSlot(kept, "slot:frame-0", "first", options(kept))).toBe(kept);
  });

  it("tracks repository acknowledgements without inventing a user edit revision", () => {
    const edited = setFrameDecision(workspace(), "slot:frame-0", "kept", { expectedRevision: 0, updatedAt: t1 });
    const persisted = markFrameWorkspacePersisted(edited, 1);

    expect(persisted.revision).toBe(1);
    expect(persisted.lastPersistedRevision).toBe(1);
    expect(markFrameWorkspacePersisted(persisted, 0)).toBe(persisted);
    expect(() => markFrameWorkspacePersisted(persisted, 2)).toThrow("持久化确认修订无效");
  });

  it("overrides playback FPS non-destructively through revision-checked commands", () => {
    const initial = workspace();
    const updated = setFrameWorkspaceFrameRate(initial, 12, options(initial));

    expect(updated).toMatchObject({ playbackFrameRate: 12, revision: 1 });
    expect(updated.source.frameRate).toBe(8);
    expect(setFrameWorkspaceFrameRate(updated, 12, options(updated))).toBe(updated);
    expect(() => setFrameWorkspaceFrameRate(updated, 16, { expectedRevision: 0, updatedAt: t1 })).toThrow(
      FrameWorkspaceConflictError,
    );
    expect(() => setFrameWorkspaceFrameRate(updated, 0, options(updated))).toThrow("正整数");
    expect(() => setFrameWorkspaceFrameRate(updated, 7.5, options(updated))).toThrow("正整数");
  });

  it("restores legacy v4 workspaces to their immutable source FPS without a new revision", () => {
    const initial = workspace();
    const { playbackFrameRate: _legacyMissingField, ...legacyFields } = initial;
    const legacy = legacyFields as FrameWorkspace;

    const restored = restoreFrameWorkspaceDefaults(legacy);

    expect(restored.playbackFrameRate).toBe(8);
    expect(restored.revision).toBe(initial.revision);
    expect(restored.updatedAt).toBe(initial.updatedAt);
  });
});

describe("retry candidates", () => {
  it("enforces legal retry transitions including unknown reconciliation", () => {
    expect(canTransitionFrameRetryAttempt("submitting", "running")).toBe(true);
    expect(canTransitionFrameRetryAttempt("status_unknown", "submitting")).toBe(false);
    expect(canTransitionFrameRetryAttempt("status_unknown", "running")).toBe(true);
    expect(() => transitionFrameRetryAttempt(attempt(workspace()), "accepted", t1)).toThrow("非法重试状态转换");
  });

  it("registers client requests idempotently and prevents a second active retry on one slot", () => {
    const initial = workspace();
    const retry = attempt(initial);
    const registered = registerFrameRetryAttempt(initial, { attempt: retry, options: options(initial) });

    expect(registered.slots[retry.slotId]!.retryAttemptIds).toEqual([retry.id]);
    const duplicate = registerFrameRetryAttempt(registered, {
      attempt: { ...retry, id: "attempt-duplicate", inputSnapshot: { ...retry.inputSnapshot, workspaceRevision: registered.revision } },
      options: options(registered),
    });
    expect(duplicate).toBe(registered);
    expect(() =>
      registerFrameRetryAttempt(registered, {
        attempt: attempt(registered, retry.slotId, {
          id: "attempt-2",
          clientRequestId: "retry-request-2",
          inputSnapshot: { ...retry.inputSnapshot, workspaceRevision: registered.revision },
        }),
        options: options(registered),
      }),
    ).toThrow("已有活动重试");
  });

  it("persists retry lifecycle transitions through revision-checked workspace commands", () => {
    const initial = workspace();
    const retry = attempt(initial);
    const registered = registerFrameRetryAttempt(initial, { attempt: retry, options: options(initial) });
    const running = transitionWorkspaceRetryAttempt(registered, retry.id, "running", options(registered), {
      childGenerationJobId: "child-job-1",
    });
    const unknown = transitionWorkspaceRetryAttempt(running, retry.id, "status_unknown", options(running));

    expect(running.retryAttempts[retry.id]).toMatchObject({
      status: "running",
      childGenerationJobId: "child-job-1",
    });
    expect(unknown.retryAttempts[retry.id]!.status).toBe("status_unknown");
    expect(unknown.revision).toBe(3);
  });

  it("attaches and accepts a validated candidate atomically, then restores original", () => {
    const initial = workspace();
    const retry = attempt(initial);
    const registered = registerFrameRetryAttempt(initial, { attempt: retry, options: options(initial) });
    const runningAttempt = transitionFrameRetryAttempt(registered.retryAttempts[retry.id]!, "running", t1);
    const running = {
      ...registered,
      retryAttempts: { ...registered.retryAttempts, [retry.id]: runningAttempt },
    };
    const attached = attachRetryCandidate(running, {
      attemptId: retry.id,
      revision: candidate(running, runningAttempt),
      options: options(running),
    });
    const accepted = acceptRetryCandidate(attached, retry.id, options(attached));
    const restored = restoreOriginalFrame(accepted, retry.slotId, options(accepted));

    expect(attached.slots[retry.slotId]!.currentRevisionId).toBe(attached.slots[retry.slotId]!.originalRevisionId);
    expect(attached.slots[retry.slotId]!.candidateRevisionId).toBe("revision:candidate:1");
    expect(accepted.slots[retry.slotId]!.currentRevisionId).toBe("revision:candidate:1");
    expect(accepted.retryAttempts[retry.id]!.status).toBe("accepted");
    expect(accepted.revisions["revision:candidate:1"]!.isCurrent).toBe(true);
    expect(accepted.revisions[accepted.slots[retry.slotId]!.originalRevisionId]!.isCurrent).toBe(false);
    expect(restored.slots[retry.slotId]!.currentRevisionId).toBe(restored.slots[retry.slotId]!.originalRevisionId);
    expect(restored.retryAttempts[retry.id]!.status).toBe("accepted");
  });

  it("discards a candidate without switching or deleting either resource revision", () => {
    const initial = workspace();
    const retry = attempt(initial);
    const registered = registerFrameRetryAttempt(initial, { attempt: retry, options: options(initial) });
    const attached = attachRetryCandidate(registered, {
      attemptId: retry.id,
      revision: candidate(registered, retry),
      options: options(registered),
    });
    const discarded = discardRetryCandidate(attached, retry.id, options(attached));

    expect(discarded.retryAttempts[retry.id]!.status).toBe("discarded");
    expect(discarded.slots[retry.slotId]!.currentRevisionId).toBe(discarded.slots[retry.slotId]!.originalRevisionId);
    expect(discarded.revisions["revision:candidate:1"]).toBeDefined();
  });
});

describe("snapshot readiness and immutable export contract", () => {
  it("blocks pending frames, fewer than two included frames, missing resources and active retries", () => {
    const initial = workspace();
    expect(validateFrameWorkspaceSnapshot(initial).issues.map((issue) => issue.code)).toContain("unreviewed_frame");

    let onlyOne = setFrameDecision(initial, "slot:frame-0", "kept", options(initial));
    onlyOne = removeFrame(onlyOne, "slot:frame-1", options(onlyOne));
    onlyOne = removeFrame(onlyOne, "slot:frame-2", options(onlyOne));
    expect(validateFrameWorkspaceSnapshot(onlyOne).issues.map((issue) => issue.code)).toContain("too_few_frames");

    const invalid = {
      ...keepAll(initial),
      revisions: {
        ...initial.revisions,
        [initial.slots["slot:frame-1"]!.currentRevisionId]: {
          ...initial.revisions[initial.slots["slot:frame-1"]!.currentRevisionId]!,
          readable: false,
        },
      },
    };
    expect(validateFrameWorkspaceSnapshot(invalid).issues.map((issue) => issue.code)).toContain("unreadable_revision");

    const retry = attempt(initial);
    const active = registerFrameRetryAttempt(initial, { attempt: retry, options: options(initial) });
    expect(validateFrameWorkspaceSnapshot(active).issues.map((issue) => issue.code)).toContain("active_retry");
  });

  it("blocks dangling order, revision and retry audit references", () => {
    const ready = keepAll(workspace());
    const firstSlot = ready.slots["slot:frame-0"]!;
    const invalid = {
      ...ready,
      orderedSlotIds: ready.orderedSlotIds.slice(1),
      slots: {
        ...ready.slots,
        [firstSlot.id]: { ...firstSlot, retryAttemptIds: ["missing-attempt"] },
        "slot:frame-1": { ...ready.slots["slot:frame-1"]!, currentRevisionId: "missing-revision" },
      },
    };

    expect(validateFrameWorkspaceSnapshot(invalid).issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["unordered_slot", "missing_revision"]),
    );

    const orderedInvalid = { ...invalid, orderedSlotIds: ready.orderedSlotIds };
    expect(validateFrameWorkspaceSnapshot(orderedInvalid).issues.map((issue) => issue.code)).toContain("missing_retry_attempt");
  });

  it("creates a frozen snapshot with continuous output indexes and complete playback metadata", () => {
    let ready = keepAll(workspace());
    ready = removeFrame(ready, "slot:frame-1", options(ready));
    ready = moveFrameSlot(ready, "slot:frame-2", "first", options(ready));
    ready = setFrameWorkspaceFrameRate(ready, 12, options(ready));
    const snapshot = createFrameWorkspaceSnapshot(ready, {
      snapshotId: "snapshot-1",
      createdAt: "2026-07-12T02:00:00.000Z",
    });

    expect(snapshot.frames.map((item) => [item.outputIndex, item.originalFrameId])).toEqual([
      [0, "frame-2"],
      [1, "frame-0"],
    ]);
    expect(snapshot).toMatchObject({
      workspaceId: "workspace-1",
      sourceJobId: "job-1",
      frameRate: 12,
      loopMode: "loop",
      canvas: { width: 512, height: 512 },
      anchor: "bottom_center_feet_baseline",
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.frames)).toBe(true);
    expect(Object.isFrozen(snapshot.frames[0])).toBe(true);
    expect(ready.source.frameRate).toBe(8);
  });

  it("keeps earlier snapshots unchanged when a later revision overrides FPS", () => {
    const ready = keepAll(workspace());
    const originalSnapshot = createFrameWorkspaceSnapshot(ready, {
      snapshotId: "snapshot-original-fps",
      createdAt: "2026-07-12T02:00:00.000Z",
    });
    const updated = setFrameWorkspaceFrameRate(ready, 16, options(ready));
    const updatedSnapshot = createFrameWorkspaceSnapshot(updated, {
      snapshotId: "snapshot-overridden-fps",
      createdAt: "2026-07-12T02:01:00.000Z",
    });

    expect(originalSnapshot.frameRate).toBe(8);
    expect(updatedSnapshot.frameRate).toBe(16);
    expect(originalSnapshot.frameRate).toBe(8);
    expect(originalSnapshot.revision).not.toBe(updatedSnapshot.revision);
  });
});
