import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { error: Error | null; componentStack: string | null };

/**
 * AppErrorBoundary — the last boundary before the React root.
 *
 * ChartErrorBoundary (src/chart/ChartErrorBoundary.tsx) already isolates the
 * lightweight-charts pane tree, which is where throws were expected. Anything
 * outside it — a sidebar, a drawer, a route component, a zustand selector that
 * reads a shape localStorage no longer holds — had no boundary at all, so a
 * single render throw unmounted the whole app to a blank white page. Blank
 * page plus no record is the worst diagnostic state available: the user cannot
 * describe what happened and the stack exists only in a console they are not
 * looking at.
 *
 * This fallback is therefore built as a bug report first and a recovery
 * affordance second. The message and the component stack are on screen and
 * selectable, because for the frontend there is no equivalent of the backend's
 * rotating log file — the screen IS the durable record.
 *
 * Two exits, deliberately:
 *  - 다시 시도 clears the error and lets React re-mount. Enough for a
 *    transient render throw.
 *  - 새로고침 reloads the document. Needed because a root-level throw is
 *    frequently caused by module-level or persisted state that re-mounting
 *    does not clear — retry alone would just re-throw immediately, which reads
 *    to the user as a dead button.
 */
export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Preserved for engineers with devtools open; the fallback below is what
    // everyone else gets.
    console.error('[AppErrorBoundary]', error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  reset = (): void => {
    this.setState({ error: null, componentStack: null });
  };

  reload = (): void => {
    window.location.reload();
  };

  render() {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="grid place-items-center min-h-screen bg-bg text-fg-dim p-6">
        <div className="w-full max-w-xl space-y-4">
          <div className="text-fg font-semibold text-lg">
            화면을 표시하지 못했습니다
          </div>
          <p className="text-sm">
            예기치 못한 오류로 화면 렌더링이 중단되었습니다. 아래 내용을 복사해
            두시면 원인 파악에 도움이 됩니다.
          </p>

          <div className="text-xs font-data break-all bg-bg-subtle border border-border rounded p-3 text-error">
            {error.message || String(error)}
          </div>

          {componentStack ? (
            <details className="text-xs">
              <summary className="cursor-pointer text-fg-dim select-none">
                컴포넌트 스택
              </summary>
              <pre className="mt-2 whitespace-pre-wrap break-all font-data bg-bg-subtle border border-border rounded p-3 max-h-64 overflow-auto">
                {componentStack}
              </pre>
            </details>
          ) : null}

          <div className="flex gap-2">
            <button
              onClick={this.reset}
              className="px-3 py-1.5 bg-accent text-accent-fg rounded text-sm"
            >
              다시 시도
            </button>
            <button
              onClick={this.reload}
              className="px-3 py-1.5 bg-bg-input hover:bg-bg-input-hover border border-border rounded text-sm"
            >
              새로고침
            </button>
          </div>
        </div>
      </div>
    );
  }
}
