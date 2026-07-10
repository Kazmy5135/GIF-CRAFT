import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SourceImageProvider } from "../features/source-image/SourceImageContext";
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
          <App />
        </SourceImageProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "生图" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "生成序列帧" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "序列帧调整（导出）" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "设置" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "功能尚未实现" })).toBeInTheDocument();
  });
});
