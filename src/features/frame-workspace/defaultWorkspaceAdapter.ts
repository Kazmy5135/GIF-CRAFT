import {
  acceptRetryCandidate,
  attachRetryCandidate,
  createFrameWorkspace as createDomainWorkspace,
  createFrameWorkspaceSnapshot,
  discardRetryCandidate,
  markFrameWorkspacePersisted,
  moveFrameSlotTo,
  registerFrameRetryAttempt,
  restoreFrame,
  restoreOriginalFrame,
  setFrameDecision,
  transitionWorkspaceRetryAttempt,
  validateFrameWorkspaceSnapshot,
  type FrameRetryAttempt,
  type FrameWorkspace,
  type FrameRevision,
} from "../../core/frameWorkspace";
import {
  createFrameWorkspaceHandoff,
  sequencePresets,
  type Frame,
  type GenerationJob,
  type SequenceGenerationError,
  type SequenceProviderCapabilities,
} from "../../core/sequenceGeneration";
import {
  createFrameRetryService,
  FrameRetryServiceError,
} from "../../infrastructure/api/frameRetryService";
import { fetchSequenceProviders } from "../../infrastructure/api/sequenceApi";
import {
  adoptWorkspaceFrameResource,
  createFrameWorkspace as createStoredFrameWorkspace,
  FrameWorkspaceAlreadyExistsError,
  frameWorkspaceStorageRecord,
  getFrameWorkspaceByJobId,
  listWorkspaceFrameResources,
  saveWorkspaceFrameResource,
  saveFrameWorkspace,
  saveFrameWorkspaceSnapshot,
  workspaceFrameResourceStorageRecord,
  type StoredWorkspaceFrameResource,
} from "../../infrastructure/storage/frameWorkspaceRepository";
import {
  getGenerationJob,
  listFrameResources,
  listGenerationJobs,
  type StoredFrameResource,
} from "../../infrastructure/storage/sequenceJobRepository";
import { getSourceImage } from "../../infrastructure/storage/sourceImageRepository";
import type {
  EligibleJobView,
  FrameWorkspaceAdapter,
  WorkspaceCommand,
  WorkspaceFrameView,
  WorkspaceView,
} from "./workspaceAdapter";

interface OpaqueWorkspace {
  domain: FrameWorkspace;
  sourceResources: Map<string, StoredFrameResource<Frame>>;
  candidateResources: Map<string, StoredWorkspaceFrameResource<FrameRevision>>;
  retryMode?: SequenceProviderCapabilities["frameRetryMode"];
  decodedResourceRefs: Set<string>;
}

function requireOpaque(view: WorkspaceView): OpaqueWorkspace {
  const opaque = view.opaque as OpaqueWorkspace | undefined;
  if (!opaque?.domain) throw new Error("工作区 UI 适配数据缺失，请重新加载。");
  return opaque;
}

function resourceMetadataIsReadable(resource: StoredFrameResource<Frame>): boolean {
  return resource.frame.readable && resource.blob.size === resource.size && resource.blob.type === resource.frame.mimeType;
}

async function decodeImageBlob(blob: Blob, width: number, height: number): Promise<boolean> {
  try {
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(blob);
      const valid = bitmap.width === width && bitmap.height === height;
      bitmap.close();
      return valid;
    }
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      const loaded = new Promise<boolean>((resolve) => {
        image.onload = () => resolve(image.naturalWidth === width && image.naturalHeight === height);
        image.onerror = () => resolve(false);
      });
      image.src = url;
      return await loaded;
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return false;
  }
}

function workspaceRecordRefsAreValid(domain: FrameWorkspace, resources: readonly StoredFrameResource<Frame>[]): boolean {
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  return Object.values(domain.slots).every((slot) => {
    const resource = byId.get(slot.originalFrameId);
    return Boolean(resource && resource.jobId === domain.sourceJobId && resourceMetadataIsReadable(resource));
  });
}

function toView(opaque: OpaqueWorkspace): WorkspaceView {
  const { domain, sourceResources, candidateResources } = opaque;
  const frames = domain.orderedSlotIds.map((slotId): WorkspaceFrameView => {
    const slot = domain.slots[slotId];
    const revision = domain.revisions[slot.currentRevisionId];
    const original = sourceResources.get(slot.originalFrameId);
    const candidate = candidateResources.get(revision.resourceRef);
    const blob = revision.source === "original" ? original?.blob ?? null : candidate?.blob ?? null;
    const originalFrame = original?.frame;
    const frame: Frame = {
      id: revision.id,
      jobId: domain.sourceJobId,
      providerIndex: originalFrame?.providerIndex ?? slot.originalSequenceIndex,
      sequenceIndex: originalFrame?.sequenceIndex ?? slot.originalSequenceIndex,
      resourceRef: revision.resourceRef,
      mimeType: revision.mimeType,
      width: revision.width,
      height: revision.height,
      size: revision.size,
      readable: revision.readable && Boolean(blob) && opaque.decodedResourceRefs.has(revision.resourceRef),
      createdAt: revision.createdAt,
      ...(originalFrame?.providerTimestamp !== undefined ? { providerTimestamp: originalFrame.providerTimestamp } : {}),
    };
    const lastAttempt = slot.retryAttemptIds.map((id) => domain.retryAttempts[id]).filter(Boolean).at(-1);
    const candidateRevision = slot.candidateRevisionId ? domain.revisions[slot.candidateRevisionId] : undefined;
    const candidateResource = candidateRevision ? candidateResources.get(candidateRevision.resourceRef) : undefined;
    const candidateFrame: Frame | undefined = candidateRevision ? {
      id: candidateRevision.id,
      jobId: domain.sourceJobId,
      providerIndex: originalFrame?.providerIndex ?? slot.originalSequenceIndex,
      sequenceIndex: originalFrame?.sequenceIndex ?? slot.originalSequenceIndex,
      resourceRef: candidateRevision.resourceRef,
      mimeType: candidateRevision.mimeType,
      width: candidateRevision.width,
      height: candidateRevision.height,
      size: candidateRevision.size,
      readable: candidateRevision.readable && Boolean(candidateResource?.blob) && opaque.decodedResourceRefs.has(candidateRevision.resourceRef),
      createdAt: candidateRevision.createdAt,
    } : undefined;
    return {
      id: slot.id,
      originalFrameId: slot.originalFrameId,
      originalIndex: slot.originalSequenceIndex,
      decision: slot.decision,
      currentVersion: revision.source === "original" ? "original" : "candidate",
      frame,
      blob,
      retryStatus: lastAttempt ? (lastAttempt.status === "submitting" ? "running" : lastAttempt.status === "accepted" || lastAttempt.status === "discarded" ? "idle" : lastAttempt.status) : "idle",
      retryMode: opaque.retryMode,
      retryError: lastAttempt?.error?.message,
      retryCanReconcile: Boolean(lastAttempt && ["running", "status_unknown"].includes(lastAttempt.status) && lastAttempt.childGenerationJobId),
      retryCanAbandon: Boolean(lastAttempt && ["submitting", "running", "status_unknown"].includes(lastAttempt.status)),
      ...(candidateRevision && candidateFrame ? {
        candidate: {
          attemptId: candidateRevision.retryAttemptId ?? lastAttempt?.id ?? "",
          frame: candidateFrame,
          blob: candidateResource?.blob ?? null,
        },
      } : {}),
    };
  });
  return {
    id: domain.workspaceId,
    jobId: domain.sourceJobId,
    revision: domain.revision,
    persistedRevision: domain.lastPersistedRevision,
    presetName: sequencePresets[domain.source.presetId]?.displayName ?? domain.source.presetId,
    frameRate: domain.source.frameRate,
    loopMode: domain.source.loopMode,
    canvas: { width: domain.source.canvas.width, height: domain.source.canvas.height },
    frames,
    updatedAt: domain.updatedAt,
    opaque,
  };
}

function mutate(view: WorkspaceView, command: WorkspaceCommand): WorkspaceView {
  const opaque = requireOpaque(view);
  const options = { expectedRevision: opaque.domain.revision, updatedAt: new Date().toISOString() };
  let domain: FrameWorkspace;
  if (command.type === "set_decision") {
    domain = setFrameDecision(opaque.domain, command.frameId, command.decision, options);
  } else if (command.type === "restore") {
    domain = restoreFrame(opaque.domain, command.frameId, options);
  } else {
    const from = opaque.domain.orderedSlotIds.indexOf(command.frameId);
    const targetIndex = Math.max(0, Math.min(opaque.domain.orderedSlotIds.length - 1, command.targetIndex));
    if (from < 0 || from === targetIndex) return view;
    const targetSlotId = opaque.domain.orderedSlotIds[targetIndex];
    domain = moveFrameSlotTo(opaque.domain, command.frameId, targetSlotId, from > targetIndex ? "before" : "after", options);
  }
  if (domain === opaque.domain) return view;
  return toView({ ...opaque, domain });
}

function retryDescription(mode: SequenceProviderCapabilities["frameRetryMode"] | undefined): string {
  if (mode === "native_single_frame") return "当前服务声明原生指定帧重试，但当前工作区尚未接入该执行路径。";
  if (mode === "full_sequence_fallback") return "当前服务使用完整子任务降级，并只提取同一原始索引作为候选，不会自动替换。";
  return "当前服务没有可用的指定帧重试能力。";
}

export function createDefaultWorkspaceAdapter(): FrameWorkspaceAdapter {
  const retryModeByJob = new Map<string, SequenceProviderCapabilities["frameRetryMode"]>();
  const providerByJob = new Map<string, Pick<SequenceProviderCapabilities, "provider" | "frameRetryMode"> & { proxyInstanceId: string }>();
  const retryService = createFrameRetryService();
  const knownAttempts = new Set<string>();
  let currentRetryMode: SequenceProviderCapabilities["frameRetryMode"] | undefined;

  async function loadResources(jobId: string) {
    const resources = await listFrameResources<Frame>(jobId);
    if (!resources.length || resources.some((resource) => resource.jobId !== jobId || !resourceMetadataIsReadable(resource))) {
      throw new Error("来源任务的本地帧资源缺失、损坏或格式不一致，请重新生成。");
    }
    const decoded = await Promise.all(resources.map((resource) => decodeImageBlob(resource.blob, resource.frame.width, resource.frame.height)));
    if (decoded.some((valid) => !valid)) throw new Error("来源任务包含无法解码或尺寸不匹配的帧，请重新生成。");
    return resources;
  }

  async function loadDomain(jobId: string, resources: readonly StoredFrameResource<Frame>[]): Promise<FrameWorkspace> {
    const jobRecord = await getGenerationJob<GenerationJob>(jobId);
    if (!jobRecord || jobRecord.resultStorageStatus !== "available") throw new Error("生成任务不存在或本地结果已被清理。");
    const job = jobRecord.job;
    const handoff = createFrameWorkspaceHandoff(job, resources.map((resource) => resource.frame));
    const stored = await getFrameWorkspaceByJobId<FrameWorkspace>(jobId);
    if (stored) {
      if (!workspaceRecordRefsAreValid(stored.workspace, resources)) throw new Error("工作区引用的原始帧已丢失或损坏。");
      return markFrameWorkspacePersisted(stored.workspace, stored.revision);
    }
    const created = createDomainWorkspace({ workspaceId: crypto.randomUUID(), handoff, createdAt: new Date().toISOString() });
    try {
      await createStoredFrameWorkspace(frameWorkspaceStorageRecord(created));
      return created;
    } catch (error) {
      if (!(error instanceof FrameWorkspaceAlreadyExistsError)) throw error;
      const raced = await getFrameWorkspaceByJobId<FrameWorkspace>(jobId);
      if (!raced) throw error;
      return markFrameWorkspacePersisted(raced.workspace, raced.revision);
    }
  }

  return {
    async listEligibleJobs(): Promise<EligibleJobView[]> {
      const jobs = await listGenerationJobs<GenerationJob>();
      const eligible: EligibleJobView[] = [];
      for (const record of jobs) {
        if (record.status !== "completed" || record.resultStorageStatus !== "available" || record.job.resultIntegrity.status !== "complete") continue;
        try {
          const resources = await loadResources(record.id);
          createFrameWorkspaceHandoff(record.job, resources.map((resource) => resource.frame));
          eligible.push({
            id: record.id,
            presetName: sequencePresets[record.job.request.presetId]?.displayName ?? record.job.request.presetId,
            frameCount: resources.length,
            frameRate: record.job.request.effectiveParameters.frameRate,
            loopMode: record.job.request.effectiveParameters.loopMode,
            createdAt: record.createdAt,
          });
        } catch {
          // Invalid local resources are intentionally omitted from the chooser.
        }
      }
      return eligible;
    },
    async loadOrCreate(jobId: string): Promise<WorkspaceView> {
      const [resources, providers] = await Promise.all([
        loadResources(jobId),
        fetchSequenceProviders().catch(() => []),
      ]);
      const jobRecord = await getGenerationJob<GenerationJob>(jobId);
      const provider = providers.find((item) => item.provider === jobRecord?.provider);
      if (provider) {
        retryModeByJob.set(jobId, provider.frameRetryMode);
        providerByJob.set(jobId, { provider: provider.provider, frameRetryMode: provider.frameRetryMode, proxyInstanceId: provider.proxyInstanceId });
      }
      currentRetryMode = retryModeByJob.get(jobId);
      const domain = await loadDomain(jobId, resources);
      const candidates = await listWorkspaceFrameResources<FrameRevision>(domain.workspaceId);
      const decodedResourceRefs = new Set(resources.map((resource) => resource.frame.resourceRef));
      await Promise.all(candidates.map(async (candidate) => {
        if (
          candidate.blob.size === candidate.size &&
          candidate.blob.type === candidate.mimeType &&
          await decodeImageBlob(candidate.blob, candidate.width, candidate.height)
        ) decodedResourceRefs.add(candidate.id);
      }));
      return toView({
        domain,
        sourceResources: new Map(resources.map((resource) => [resource.id, resource])),
        candidateResources: new Map(candidates.map((resource) => [resource.id, resource])),
        retryMode: currentRetryMode,
        decodedResourceRefs,
      });
    },
    apply: mutate,
    async save(view, expectedRevision) {
      const opaque = requireOpaque(view);
      await saveFrameWorkspace(frameWorkspaceStorageRecord(opaque.domain), expectedRevision);
      const domain = markFrameWorkspacePersisted(opaque.domain, opaque.domain.revision);
      return toView({ ...opaque, domain });
    },
    checkReadiness(view) {
      const readiness = validateFrameWorkspaceSnapshot(requireOpaque(view).domain);
      const resourceIssues = view.frames
        .filter((frame) => frame.decision !== "removed" && (!frame.blob || !frame.frame.readable))
        .map((frame) => `原始索引 ${frame.originalIndex} 的当前采用资源缺失、损坏或无法解码。`);
      return { ready: readiness.ready && resourceIssues.length === 0, issues: [...readiness.issues.map((issue) => issue.message), ...resourceIssues] };
    },
    async createSnapshot(view) {
      const included = view.frames.filter((frame) => frame.decision !== "removed");
      const decoded = await Promise.all(included.map((frame) => frame.blob ? decodeImageBlob(frame.blob, frame.frame.width, frame.frame.height) : false));
      if (decoded.some((valid) => !valid)) throw new Error("当前采用帧存在缺失、损坏或无法解码的资源，不能生成快照。");
      const snapshot = createFrameWorkspaceSnapshot(requireOpaque(view).domain, { snapshotId: crypto.randomUUID(), createdAt: new Date().toISOString() });
      await saveFrameWorkspaceSnapshot(snapshot);
      return { id: snapshot.snapshotId, frameCount: snapshot.frames.length, createdAt: snapshot.createdAt };
    },
    describeRetryCapability: () => retryDescription(currentRetryMode),
    async requestRetry(view, frameId) {
      let opaque = requireOpaque(view);
      if (opaque.domain.revision !== opaque.domain.lastPersistedRevision) {
        throw new Error("请等待当前编辑保存完成后再重试指定帧。");
      }
      const slot = opaque.domain.slots[frameId];
      if (!slot || slot.decision === "removed") throw new Error("已移除或不存在的帧不能发起重试。");
      const parentRecord = await getGenerationJob<GenerationJob>(opaque.domain.sourceJobId);
      if (!parentRecord) throw new Error("来源生成任务已丢失。");
      const parentJob = parentRecord.job;
      const source = await getSourceImage(parentJob.request.source.id);
      if (
        !source ||
        source.contentSnapshotId !== parentJob.request.source.contentSnapshotId ||
        source.mimeType !== parentJob.request.source.mimeType ||
        source.size !== parentJob.request.source.size ||
        source.availability !== "available" ||
        !source.dataUrl
      ) {
        throw new Error("父任务冻结的源图字节已丢失或不匹配，不能安全重试。");
      }
      const capabilities = providerByJob.get(opaque.domain.sourceJobId);
      if (!capabilities || capabilities.provider !== parentJob.provider) throw new Error("无法读取父任务对应的重试能力。");
      if (capabilities.frameRetryMode !== "full_sequence_fallback") {
        throw new Error(retryDescription(capabilities.frameRetryMode));
      }

      const previousAttempt = slot.retryAttemptIds.map((id) => opaque.domain.retryAttempts[id]).filter(Boolean).at(-1);
      let attempt: FrameRetryAttempt;
      if (previousAttempt && ["submitting", "running", "status_unknown"].includes(previousAttempt.status)) {
        attempt = previousAttempt;
      } else {
        const attemptId = crypto.randomUUID();
        const clientRequestId = crypto.randomUUID();
        const orderedIndex = opaque.domain.orderedSlotIds.indexOf(slot.id);
        const previousSlot = opaque.domain.slots[opaque.domain.orderedSlotIds[orderedIndex - 1]];
        const nextSlot = opaque.domain.slots[opaque.domain.orderedSlotIds[orderedIndex + 1]];
        const createdAt = new Date().toISOString();
        attempt = {
          id: attemptId,
          workspaceId: opaque.domain.workspaceId,
          slotId: slot.id,
          originalSequenceIndex: slot.originalSequenceIndex,
          parentJobId: opaque.domain.sourceJobId,
          clientRequestId,
          executionMode: "full_sequence_fallback",
          inputSnapshot: {
            targetFrameId: slot.originalFrameId,
            originalSequenceIndex: slot.originalSequenceIndex,
            parentJobId: opaque.domain.sourceJobId,
            workspaceRevision: opaque.domain.revision,
            previousFrameId: previousSlot?.originalFrameId,
            nextFrameId: nextSlot?.originalFrameId,
            prompt: parentJob.request.promptSnapshot.compiledText,
          },
          status: "submitting",
          createdAt,
          updatedAt: createdAt,
        };
        const registered = registerFrameRetryAttempt(opaque.domain, {
          attempt,
          options: { expectedRevision: opaque.domain.revision, updatedAt: createdAt },
        });
        await saveFrameWorkspace(frameWorkspaceStorageRecord(registered), opaque.domain.lastPersistedRevision);
        opaque = { ...opaque, domain: markFrameWorkspacePersisted(registered, registered.revision) };
        knownAttempts.add(attempt.id);
      }

      try {
        const result = !knownAttempts.has(attempt.id)
          ? attempt.childGenerationJobId
            ? await retryService.reconcile({
                attemptId: attempt.id,
                parentJob,
                targetSequenceIndex: slot.originalSequenceIndex,
                capabilities,
                childJobId: attempt.childGenerationJobId,
              })
            : (() => { throw new Error("该重试在刷新前未留下可查询的子任务 ID；为避免重复生成，不会重新提交。"); })()
          : await retryService.retry({
              attemptId: attempt.id,
              draftId: attempt.id,
              clientRequestId: attempt.clientRequestId,
              parentJob,
              targetSequenceIndex: slot.originalSequenceIndex,
              sourceImageDataUrl: source.dataUrl,
              capabilities,
              onReceipt: async (receipt) => {
                const currentAttempt = opaque.domain.retryAttempts[attempt.id];
                if (!currentAttempt) throw new Error("工作区重试尝试已丢失。");
                if (currentAttempt.childGenerationJobId === receipt.childJobId && currentAttempt.status === "running") return;
                const withReceipt = transitionWorkspaceRetryAttempt(
                  opaque.domain,
                  attempt.id,
                  "running",
                  { expectedRevision: opaque.domain.revision, updatedAt: receipt.submittedAt ?? new Date().toISOString() },
                  { childGenerationJobId: receipt.childJobId },
                );
                await saveFrameWorkspace(frameWorkspaceStorageRecord(withReceipt), opaque.domain.lastPersistedRevision);
                opaque = { ...opaque, domain: markFrameWorkspacePersisted(withReceipt, withReceipt.revision) };
              },
            });
        const revision: FrameRevision = {
          id: `revision:candidate:${attempt.id}`,
          workspaceId: opaque.domain.workspaceId,
          slotId: slot.id,
          source: "retry_candidate",
          retryAttemptId: attempt.id,
          resourceRef: result.candidateFrame.resourceRef,
          mimeType: result.candidateFrame.mimeType,
          width: result.candidateFrame.width,
          height: result.candidateFrame.height,
          size: result.candidateFrame.size,
          readable: result.candidateFrame.readable,
          createdAt: result.candidateFrame.createdAt,
          isCurrent: false,
        };
        const candidateRecord = workspaceFrameResourceStorageRecord({
          revision,
          sourceJobId: opaque.domain.sourceJobId,
          childJobId: result.childJobId,
          blob: result.candidateBlob,
        });
        if (!await decodeImageBlob(candidateRecord.blob, candidateRecord.width, candidateRecord.height)) {
          throw new Error("候选帧无法真实解码或尺寸不匹配，当前帧保持不变。");
        }
        await saveWorkspaceFrameResource(candidateRecord);
        const candidateReady = attachRetryCandidate(opaque.domain, {
          attemptId: attempt.id,
          revision,
          options: { expectedRevision: opaque.domain.revision, updatedAt: new Date().toISOString() },
        });
        await saveFrameWorkspace(frameWorkspaceStorageRecord(candidateReady), opaque.domain.lastPersistedRevision);
        const candidates = new Map(opaque.candidateResources);
        candidates.set(candidateRecord.id, candidateRecord);
        const decodedResourceRefs = new Set(opaque.decodedResourceRefs);
        decodedResourceRefs.add(candidateRecord.id);
        return toView({ ...opaque, domain: markFrameWorkspacePersisted(candidateReady, candidateReady.revision), candidateResources: candidates, decodedResourceRefs });
      } catch (error) {
        const serviceError = error instanceof FrameRetryServiceError ? error : null;
        const status = serviceError?.code === "status_unknown" ? "status_unknown" : "failed";
        const domainError: SequenceGenerationError = {
          code: serviceError?.code === "status_unknown" ? "timeout_unknown" : serviceError?.code === "capability_unsupported" ? "capability_unsupported" : serviceError?.code === "invalid_result" ? "invalid_result" : serviceError?.code === "invalid_candidate_resource" ? "resource_unavailable" : serviceError?.code === "invalid_request" ? "validation_failed" : "request_failed",
          message: error instanceof Error ? error.message : "指定帧重试失败。",
          retryable: serviceError?.recoveryAction === "retry",
          recoveryAction: serviceError?.recoveryAction ?? "retry",
        };
        const latestAttempt = opaque.domain.retryAttempts[attempt.id];
        if (status === "status_unknown" && latestAttempt?.status === "status_unknown") {
          return toView(opaque);
        }
        const failed = transitionWorkspaceRetryAttempt(
          opaque.domain,
          attempt.id,
          status,
          { expectedRevision: opaque.domain.revision, updatedAt: new Date().toISOString() },
          { childGenerationJobId: serviceError?.childJobId, error: domainError },
        );
        await saveFrameWorkspace(frameWorkspaceStorageRecord(failed), opaque.domain.lastPersistedRevision);
        const persisted = markFrameWorkspacePersisted(failed, failed.revision);
        if (status === "status_unknown") return toView({ ...opaque, domain: persisted });
        throw Object.assign(new Error(domainError.message), { workspaceView: toView({ ...opaque, domain: persisted }) });
      }
    },
    async acceptCandidate(view, frameId) {
      const opaque = requireOpaque(view);
      if (opaque.domain.revision !== opaque.domain.lastPersistedRevision) throw new Error("请等待保存完成后再接受候选。");
      const slot = opaque.domain.slots[frameId];
      const candidateId = slot?.candidateRevisionId;
      const attemptId = candidateId ? opaque.domain.revisions[candidateId]?.retryAttemptId : undefined;
      if (!candidateId || !attemptId) throw new Error("当前帧没有可接受的候选。");
      const acceptedAt = new Date().toISOString();
      const accepted = acceptRetryCandidate(opaque.domain, attemptId, { expectedRevision: opaque.domain.revision, updatedAt: acceptedAt });
      const resourceRef = accepted.revisions[candidateId]?.resourceRef;
      if (!resourceRef) throw new Error("候选资源引用缺失。");
      await adoptWorkspaceFrameResource({
        workspace: frameWorkspaceStorageRecord(accepted),
        candidateId: resourceRef,
        expectedRevision: opaque.domain.lastPersistedRevision,
        adoptedAt: acceptedAt,
      });
      return toView({ ...opaque, domain: markFrameWorkspacePersisted(accepted, accepted.revision) });
    },
    async discardCandidate(view, frameId) {
      const opaque = requireOpaque(view);
      if (opaque.domain.revision !== opaque.domain.lastPersistedRevision) throw new Error("请等待保存完成后再放弃候选。");
      const slot = opaque.domain.slots[frameId];
      const candidateId = slot?.candidateRevisionId;
      const attemptId = candidateId ? opaque.domain.revisions[candidateId]?.retryAttemptId : undefined;
      if (!attemptId) throw new Error("当前帧没有可放弃的候选。");
      const discarded = discardRetryCandidate(opaque.domain, attemptId, { expectedRevision: opaque.domain.revision, updatedAt: new Date().toISOString() });
      await saveFrameWorkspace(frameWorkspaceStorageRecord(discarded), opaque.domain.lastPersistedRevision);
      return toView({ ...opaque, domain: markFrameWorkspacePersisted(discarded, discarded.revision) });
    },
    async restoreOriginal(view, frameId) {
      const opaque = requireOpaque(view);
      if (opaque.domain.revision !== opaque.domain.lastPersistedRevision) throw new Error("请等待保存完成后再恢复原版。");
      const restored = restoreOriginalFrame(opaque.domain, frameId, { expectedRevision: opaque.domain.revision, updatedAt: new Date().toISOString() });
      if (restored === opaque.domain) return view;
      await saveFrameWorkspace(frameWorkspaceStorageRecord(restored), opaque.domain.lastPersistedRevision);
      return toView({ ...opaque, domain: markFrameWorkspacePersisted(restored, restored.revision) });
    },
    async abandonRetryTracking(view, frameId) {
      const opaque = requireOpaque(view);
      if (opaque.domain.revision !== opaque.domain.lastPersistedRevision) throw new Error("请等待保存完成后再放弃重试跟踪。");
      const slot = opaque.domain.slots[frameId];
      const attempt = slot?.retryAttemptIds.map((id) => opaque.domain.retryAttempts[id]).filter(Boolean).at(-1);
      if (!attempt || !["submitting", "running", "status_unknown"].includes(attempt.status)) {
        throw new Error("当前帧没有可以放弃跟踪的活动重试。");
      }
      const discarded = transitionWorkspaceRetryAttempt(
        opaque.domain,
        attempt.id,
        "discarded",
        { expectedRevision: opaque.domain.revision, updatedAt: new Date().toISOString() },
        { childGenerationJobId: attempt.childGenerationJobId },
      );
      await saveFrameWorkspace(frameWorkspaceStorageRecord(discarded), opaque.domain.lastPersistedRevision);
      return toView({ ...opaque, domain: markFrameWorkspacePersisted(discarded, discarded.revision) });
    },
  };
}
