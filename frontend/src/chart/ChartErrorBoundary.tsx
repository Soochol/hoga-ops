import { Component, type ErrorInfo, type ReactNode } from 'react';
import {
  formatUpdateLoopReport,
  readUpdateLoopReport,
  readUpdateLoopReports,
} from '../state/updateLoopSignal';

type Props = {
  children: ReactNode;
  /** 폴백 제목. 기본은 차트 문구 — 데이터 창(10호가·거래원 등)을 감쌀 때 창 문구로 교체. */
  title?: string;
};
type State = { error: Error | null; componentStack: string | null; copied: boolean };

/** 상자에 보여 줄 컴포넌트 스택 줄 수. 전문은 「복사」가 실어 준다. */
const VISIBLE_STACK_LINES = 12;

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
 *
 * ## 왜 컴포넌트 스택까지 상자에 싣는가
 *
 * message 하나로 범인을 못 찾는 에러가 이 서브트리에 있다. 대표가 React 의
 * **"Maximum update depth exceeded"** 로, 문구가 가리키는 것은 *증상*(갱신 50회
 * 연속)이지 위치가 아니다. 그 에러에서 위치를 말해 주는 유일한 값이 컴포넌트
 * 스택인데, 종전엔 `console.error` 로만 나가서 **DevTools 를 연 사람만** 볼 수
 * 있었다. 실제로 2026-09-01 리포트가 그 벽에 걸렸다 — 사용자는 상자를 봤지만
 * 콘솔을 꺼낼 방법을 몰랐고, 「다시 시도」로 화면이 살아나면 스택은 그대로
 * 사라졌다(재마운트에서 재현되지 않는 콜드 마운트 계열이라 다시 잡기도 어렵다).
 *
 * 그래서 상자가 스스로 지목하게 한다: 스택 앞부분을 접힌 채로 싣고, 「복사」가
 * 메시지 + 전문을 클립보드에 넣는다. 콘솔 로그는 그대로 둔다(엔지니어용).
 */
export default class ChartErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null, copied: false };

  static getDerivedStateFromError(error: Error): Pick<State, 'error'> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 스택은 여기서만 온다 — `getDerivedStateFromError` 는 error 만 받는다.
    this.setState({ componentStack: info.componentStack ?? null });
    // Keep the original error visible in dev tools for stack-trace inspection.
    // The boundary fallback shows the message; this preserves the noise for
    // engineers who have the console open.
    console.error('[ChartErrorBoundary]', error, info.componentStack);
  }

  reset = (): void => {
    this.setState({ error: null, componentStack: null, copied: false });
  };

  /** 메시지 + 컴포넌트 스택 **전문**. 상자에 보이는 것은 앞 몇 줄뿐이라, 붙여넣기용
   *  값은 따로 만든다. */
  private report(): string {
    const { error, componentStack } = this.state;
    // 갱신 루프 덫의 신고를 **함께** 싣는다. 컴포넌트 스택은 루프의 «던진 쪽» 만
    // 알려 주는데(실측: `LiveChartRoot`), 매 커밋 스토어를 쓰는 «쓴 쪽» 은 다른
    // 컴포넌트일 수 있다 — 스토어 알림은 트리 경계를 넘기 때문이다. 두 조각이
    // 한 번의 붙여넣기로 같이 와야 조사가 한 왕복에 끝난다.
    // 신고는 **전부** 싣는다 — 래치가 스토어별이라 루프에 두 스토어가 실렸으면 둘 다
    // 잡힌다. 상자의 헤드라인은 첫 신고만 보여 주지만, 붙여넣기는 조사에 쓰이므로
    // 나머지를 버리면 조사가 다시 한 왕복 늘어난다.
    return [
      error?.message ?? '',
      componentStack ?? '',
      ...readUpdateLoopReports().map(formatUpdateLoopReport),
    ].join('\n').trim();
  }

  copy = (): void => {
    // localhost 는 secure context 라 clipboard 가 있지만, 없는 환경(비-secure origin ·
    // jsdom)에서는 **호출 자체가 undefined 를 돌려준다** — 거기에 `.then` 을 걸면 폴백
    // 상자가 스스로 터진다. 진단 화면이 진단을 막으면 안 되므로 반환값을 먼저 본다.
    const write = navigator.clipboard?.writeText(this.report());
    if (write === undefined) return;
    void write.then(
      () => this.setState({ copied: true }),
      () => this.setState({ copied: false }),
    );
  };

  render() {
    if (this.state.error) {
      const loop = readUpdateLoopReport();
      const stack = this.state.componentStack;
      const head = stack === null
        ? null
        : stack.split('\n').filter((line) => line.trim() !== '').slice(0, VISIBLE_STACK_LINES);
      return (
        <div className="grid place-items-center h-full bg-bg-card text-fg-dim p-6">
          <div className="max-w-md text-center space-y-3">
            <div className="text-fg font-semibold">{this.props.title ?? '차트 렌더링에 실패했습니다'}</div>
            <div className="text-xs font-data break-all bg-bg-subtle border rounded p-2">
              {this.state.error.message}
            </div>
            {loop !== null && (
              /* 덫이 뭔가 잡았으면 상자에서 바로 보인다 — 「오류 복사」에는 스택까지
                 실린다. 없으면 이 줄도 없다(빈 자리를 만들지 않는다). */
              <div data-testid="chart-error-update-loop" className="text-xs text-fg-dim">
                갱신 루프 후보: <span className="font-data">{loop.store}</span> — 한 프레임에{' '}
                {loop.writes}회 쓰기
              </div>
            )}
            {head !== null && head.length > 0 && (
              <details data-testid="chart-error-component-stack" className="text-left">
                <summary className="cursor-pointer text-xs text-fg-dim">
                  어디서 났는지 (컴포넌트 스택)
                </summary>
                <pre className="mt-2 max-h-40 overflow-auto rounded border bg-bg-subtle p-2 text-[11px] font-data leading-snug whitespace-pre-wrap break-all">
                  {head.join('\n')}
                </pre>
              </details>
            )}
            {/* 창은 160px 까지 좁아진다(`snapEngine` 의 `MIN_W`) — 두 버튼이 한 줄에
                안 들어가면 겹치지 말고 접혀야 한다. */}
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                onClick={this.reset}
                className="px-3 py-1.5 bg-accent text-accent-fg rounded text-sm"
              >
                다시 시도
              </button>
              <button
                type="button"
                data-testid="chart-error-copy"
                onClick={this.copy}
                className="rounded-lg border border-border-strong px-3 py-[7px] text-sm text-fg-dim hover:bg-bg-input-hover hover:text-fg"
              >
                {this.state.copied ? '복사됨' : '오류 복사'}
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
