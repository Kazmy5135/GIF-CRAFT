import "fake-indexeddb/auto";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceImageProvider } from "../features/source-image/SourceImageContext";
import { SequenceProvider } from "../features/sequence/SequenceContext";
import { closeGifCraftDatabase } from "../infrastructure/storage/database";
import { App } from "./App";

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await closeGifCraftDatabase();
});

describe("App shell", () => {
  it("renders task-oriented navigation and the sequence page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ providers: [] }),
      }),
    );

    render(
      <MemoryRouter initialEntries={["/create/sequence"]}>
        <SourceImageProvider>
          <SequenceProvider>
            <App />
          </SequenceProvider>
        </SourceImageProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "新生成" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "库存" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "设置" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "2 序列生成" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "生成序列帧" })).toBeInTheDocument();
  });

  it("mounts the real frame workspace route", async () => {
    render(
      <MemoryRouter initialEntries={["/frames"]}>
        <SourceImageProvider>
          <SequenceProvider>
            <App />
          </SequenceProvider>
        </SourceImageProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "序列帧工作区" })).toBeInTheDocument();
    expect(screen.getByText("选择一个已完成且本地帧资源可读的任务。")).toBeInTheDocument();
  });
});
