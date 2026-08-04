import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { error: Error | null; componentStack: string | null };

/**
 * 이 오류가 "배포로 청크가 갈렸다" 인가.
 *
 * 서버에 새 빌드가 올라가면 옛 해시 청크는 삭제된다. 그 전에 열어 둔 탭이 아직
 * 방문하지 않은 lazy 표면(드로어·설정·라우트)을 처음 열면 `import()` 가 404 로
 * 죽는다 — 며칠씩 탭을 열어 두는 이 앱에서는 배포마다 일어나는 일이다.
 *
 * 이걸 일반 렌더 오류와 갈라야 하는 이유는 **복구 수단이 정반대**이기 때문이다.
 * 다시 시도(re-mount)는 같은 URL 을 다시 부르므로 반드시 또 404 다 — 사용자에게는
 * 눌리지 않는 죽은 버튼으로 보인다. 여기서 유효한 유일한 조치는 새로고침(새
 * index.html 을 받아 새 해시를 알게 된다)이다.
 *
 * 브라우저마다 문구가 달라 셋 다 본다(크롬/파이어폭스/사파리). 문자열 매칭이
 * 거슬리지만 이 실패에는 구조화된 타입이 없다 — 못 잡으면 종전 화면으로
 * 떨어질 뿐이라 실패 모드가 안전하다.
 */
export function isStaleChunkError(error: Error): boolean {
  const msg = `${error.name}: ${error.message}`.toLowerCase();
  return (
    msg.includes('dynamically imported module') ||
    msg.includes('importing a module script failed') ||
    msg.includes('failed to fetch dynamically imported')
  );
}

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
    const stale = isStaleChunkError(error);

    return (
      <div className="grid place-items-center min-h-screen bg-bg text-fg-dim p-6">
        <div className="w-full max-w-xl space-y-4">
          <div className="text-fg font-semibold text-lg">
            {stale ? '새 버전이 배포되었습니다' : '화면을 표시하지 못했습니다'}
          </div>
          <p className="text-sm">
            {stale
              ? '이 탭이 열려 있는 동안 서버가 갱신되어, 예전 화면 조각을 더 이상 불러올 수 없습니다. 새로고침하면 최신 버전으로 이어집니다.'
              : '예기치 못한 오류로 화면 렌더링이 중단되었습니다. 아래 내용을 복사해 두시면 원인 파악에 도움이 됩니다'}
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

          {/* 청크가 갈린 경우 '다시 시도' 는 같은 404 를 다시 부르므로 아예
              내린다 — 눌러도 실패하는 버튼을 첫 자리에 두면 앱이 고장난 것으로
              읽힌다. 그 밖에는 종전 두 출구를 유지한다(주석 참고). */}
          <div className="flex gap-2">
            {stale ? null : (
              <button
                onClick={this.reset}
                className="px-3 py-1.5 bg-accent text-accent-fg rounded text-sm"
              >
                다시 시도
              </button>
            )}
            <button
              onClick={this.reload}
              className={
                stale
                  ? 'px-3 py-1.5 bg-accent text-accent-fg rounded text-sm'
                  : 'px-3 py-1.5 bg-bg-input hover:bg-bg-input-hover border border-border rounded text-sm'
              }
            >
              새로고침
            </button>
          </div>
        </div>
      </div>
    );
  }
}
