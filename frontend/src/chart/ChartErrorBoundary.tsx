import { Component, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * ChartErrorBoundary — guards the lightweight-charts pane tree.
 *
 * lightweight-charts asserts on a few invariants (asc-sorted times, etc.)
 * and throws synchronously inside React render/effect. Without this
 * boundary, the throw bubbles to the React root and unmounts the entire
 * app — sidebar, tabs, everything. The boundary keeps the chart area
 * isolated so the rest of the page survives.
 *
 * Renders a small fallback that surfaces the message (so users can
 * copy-paste it into bug reports) and a "다시 시도" button to clear
 * the error state and let React re-mount children.
 */
export default class ChartErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    // Keep the original error visible in dev tools for stack-trace inspection.
    // The boundary fallback shows the message; this preserves the noise for
    // engineers who have the console open.
    console.error('[ChartErrorBoundary]', error);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <div className="grid place-items-center h-full bg-bg-card text-fg-dim p-6">
          <div className="max-w-md text-center space-y-3">
            <div className="text-fg font-semibold">차트 렌더링에 실패했습니다</div>
            <div className="text-xs font-mono break-all bg-bg-subtle border rounded p-2">
              {this.state.error.message}
            </div>
            <button
              onClick={this.reset}
              className="px-3 py-1.5 bg-accent text-accent-fg rounded text-sm"
            >
              다시 시도
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
