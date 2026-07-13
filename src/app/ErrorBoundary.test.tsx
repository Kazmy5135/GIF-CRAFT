import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

function BrokenPage(): never {
  throw new Error("test page failure");
}

describe("ErrorBoundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a recovery link when a page crashes", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <ErrorBoundary>
        <BrokenPage />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("页面出现错误");
    expect(screen.getByRole("link", { name: "返回新生成" })).toHaveAttribute("href", "/create");
  });
});
