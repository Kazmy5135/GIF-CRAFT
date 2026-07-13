import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SourceImageContext,
  type SourceImageContextValue,
} from "../source-image/SourceImageContext";
import { ImageLibraryPage } from "./ImageLibraryPage";
import { sourceAsset } from "./testFixtures";

function sourceContext(
  overrides: Partial<SourceImageContextValue> = {},
): SourceImageContextValue {
  const source = sourceAsset({ availability: "unknown", confirmedAt: undefined, contentSnapshotId: undefined });
  return {
    providers: [],
    providersLoading: false,
    refreshProviders: vi.fn(),
    history: [source],
    historyLoading: false,
    currentSourceId: null,
    currentSource: null,
    taskStatus: "idle",
    taskError: "",
    promptSettings: { basePrompt: "", negativePrompt: "", version: 1 },
    updatePromptSettings: vi.fn(),
    resetPromptSettings: vi.fn(),
    generate: vi.fn(),
    addLocalImage: vi.fn(),
    confirmSource: vi.fn().mockResolvedValue(undefined),
    removeSourceImage: vi.fn(),
    clearTaskError: vi.fn(),
    ...overrides,
  };
}

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}{useLocation().search}</output>;
}

function renderPage(value: SourceImageContextValue) {
  return render(
    <MemoryRouter initialEntries={["/library/images"]}>
      <SourceImageContext.Provider value={value}>
        <ImageLibraryPage />
        <LocationProbe />
      </SourceImageContext.Provider>
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe("ImageLibraryPage", () => {
  it("shows source metadata and explicitly confirms before entering sequence creation", async () => {
    const confirmSource = vi.fn().mockResolvedValue(undefined);
    renderPage(sourceContext({ confirmSource }));

    expect(screen.getByText("hero.png")).toBeInTheDocument();
    expect(screen.getByText(/512 × 512/)).toBeInTheDocument();
    expect(screen.getAllByText("待确认")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "确认并创建序列" }));

    await waitFor(() => expect(confirmSource).toHaveBeenCalledWith("source-1"));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/create/sequence"),
    );
  });

  it("keeps the user in the library when source confirmation fails", async () => {
    const confirmSource = vi.fn().mockRejectedValue(new Error("图片字节无法读取"));
    renderPage(sourceContext({ confirmSource }));
    fireEvent.click(screen.getByRole("button", { name: "确认并创建序列" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("图片字节无法读取");
    expect(screen.getByTestId("location")).toHaveTextContent("/library/images");
  });
});
