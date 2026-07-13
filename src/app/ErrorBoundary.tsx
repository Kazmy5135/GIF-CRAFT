import { Component, type ErrorInfo, type PropsWithChildren } from "react";

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<PropsWithChildren, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Application page failed", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="fatal-error" role="alert">
          <h1>页面出现错误</h1>
          <p>当前页面无法继续运行。可以返回新生成入口重新开始。</p>
          <a className="button primary" href="/create">
            返回新生成
          </a>
        </main>
      );
    }
    return this.props.children;
  }
}
