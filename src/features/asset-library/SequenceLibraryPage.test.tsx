import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GenerationJob } from "../../core/sequenceGeneration";
import type { StoredGenerationJob } from "../../infrastructure/storage/sequenceJobRepository";
import {
  SourceImageContext,
  type SourceImageContextValue,
} from "../source-image/SourceImageContext";
import { SequenceLibraryPage } from "./SequenceLibraryPage";
import { generationJob, sourceAsset, storedJob } from "./testFixtures";

function sourceContext(): SourceImageContextValue {
  const source = sourceAsset();
  return {
    providers: [],
    providersLoading: false,
    refreshProviders: vi.fn(),
    history: [source],
    historyLoading: false,
    currentSourceId: source.id,
    currentSource: source,
    taskStatus: "idle",
    taskError: "",
    promptSettings: { basePrompt: "", negativePrompt: "", version: 1 },
    updatePromptSettings: vi.fn(),
    resetPromptSettings: vi.fn(),
    generate: vi.fn(),
    addLocalImage: vi.fn(),
    confirmSource: vi.fn(),
    removeSourceImage: vi.fn(),
    clearTaskError: vi.fn(),
  };
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

function renderPage(records: StoredGenerationJob<GenerationJob>[]) {
  const listJobs = (() => Promise.resolve(records)) as typeof import("../../infrastructure/storage/sequenceJobRepository").listGenerationJobs;
  return render(
    <MemoryRouter initialEntries={["/library/sequences"]}>
      <SourceImageContext.Provider value={sourceContext()}>
        <SequenceLibraryPage dependencies={{ listJobs }} />
        <LocationProbe />
      </SourceImageContext.Provider>
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe("SequenceLibraryPage", () => {
  it("defaults to usable results and exposes all task statuses on demand", async () => {
    const completed = storedJob(generationJob("completed"));
    const failed = storedJob(generationJob("failed"));
    renderPage([failed, completed]);

    expect(await screen.findByText("序列 ID：job-completed")).toBeInTheDocument();
    expect(screen.queryByText("序列 ID：job-failed")).not.toBeInTheDocument();
    expect(screen.getByText("8 帧")).toBeInTheDocument();
    expect(screen.getByText("8 FPS")).toBeInTheDocument();
    expect(screen.getByText("资源可用")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("序列任务状态"), { target: { value: "all" } });
    expect(screen.getByText("序列 ID：job-failed")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "状态未知" })).toBeInTheDocument();
  });

  it("navigates to the stable workspace and redo routes", async () => {
    renderPage([storedJob(generationJob("completed"))]);
    const workspace = await screen.findByRole("button", { name: "进入工作区" });

    fireEvent.click(workspace);
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/workspace/job-completed"),
    );
    fireEvent.click(screen.getByRole("button", { name: "整序列重做" }));
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/create?sourceId=source-1&redoOf=job-completed",
    );
  });

  it("disables unsafe actions when local frames or the source image are unavailable", async () => {
    const completed = generationJob("completed");
    const purged = storedJob(completed, { resultStorageStatus: "purged" });
    const listJobs = (() => Promise.resolve([purged])) as typeof import("../../infrastructure/storage/sequenceJobRepository").listGenerationJobs;
    const value = { ...sourceContext(), history: [] };
    render(
      <MemoryRouter>
        <SourceImageContext.Provider value={value}>
          <SequenceLibraryPage dependencies={{ listJobs }} />
        </SourceImageContext.Provider>
      </MemoryRouter>,
    );

    fireEvent.change(await screen.findByLabelText("序列任务状态"), { target: { value: "all" } });
    expect(await screen.findByRole("button", { name: "进入工作区" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "整序列重做" })).toBeDisabled();
    expect(screen.getByText("资源已清理")).toBeInTheDocument();
  });
});
