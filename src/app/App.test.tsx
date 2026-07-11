import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SourceImageProvider } from "../features/source-image/SourceImageContext";
import { SequenceProvider } from "../features/sequence/SequenceContext";
import { App } from "./App";

describe("App shell", () => {
  it("renders the four navigation tabs and a planned page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ providers: [] }),
      }),
    );

    render(
      <MemoryRouter initialEntries={["/sequence"]}>
        <SourceImageProvider>
          <SequenceProvider>
            <App />
          </SequenceProvider>
        </SourceImageProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "生图" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "生成序列帧" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "序列帧工作区" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "设置" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "生成序列帧" })).toBeInTheDocument();
  });
});
