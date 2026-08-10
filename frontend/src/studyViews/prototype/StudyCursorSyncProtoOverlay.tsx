/**
 * PROTOTYPE — 일봉(D) 창에 **다른 창(분봉)의 커서 위치**를 표시하는 오버레이 3변형.
 *
 * 구조는 `StudySavedRangeBand` 를 그대로 베꼈다(rAF 로 합친
 * `subscribeVisibleLogicalRangeChange` + `ResizeObserver`, `z-10`, **pane 박스 클립**).
 * z 와 클립은 한 쌍이라는 것도 같다 — `z-0` 이면 캔버스 뒤로 숨고(#1238), 올리기만
 * 하면 가격축·시간축 거터를 덮는다(#1272).
 *
 * ── 좌표 파이프라인(이 프로토타입의 핵심) ────────────────────────────────
 * 분봉 ms 를 일봉 축에 **그대로 태우면 안 된다**. `LiveChartRoot` 의 동시호가 음영이
 * 정확히 그 이유로 삭제됐다 — intraday 가상시각과 캘린더 축(하루 1포인트)은 좌표계가
 * 다르다. 그래서:
 *
 *   분봉 cursorMs → KST 날짜(`unixMsToKSTDate`) → **일봉 캔들 ts_ms 조회**
 *                 → `axis.toVirtual(ts)/1000` → `timeToCoordinate`
 *
 * 날짜로 스냅하므로 **D 에서만 정확하다**. W/M 은 스코프 밖이라 마운트하지 않는다.
 *
 * ── 1차 실측이 바꾼 것 (2026-08-10) ─────────────────────────────────────
 * 처음 세운 3변형은 A=헤어라인 / B=캔들 밴드 / C=밴드+일중 틱 이었고, 브라우저에서
 * **셋이 구분되지 않았다**. 이유 둘:
 *   1. **캔들이 너무 좁다.** 일봉 603개 광각에서 `barSpacing` 이 **0.85px**, 줌인해도
 *      8.3px 다. 캔들 폭에 매인 표현(밴드·그 안의 진행 틱)은 헤어라인과 같아진다.
 *   2. **저장 구간 밴드와 색이 싸운다.** `StudySavedRangeBand` 가 이미
 *      `--tint-selection` + `--accent` 다. 커서 밴드를 같은 토큰으로 얹으면 겹치는
 *      순간 사라진다.
 * 그래서 변형 축을 **"무엇에 매이는가"** 로 다시 세웠다: 캔들 폭에 매이지 않는 표현
 * (브래킷은 최소 폭 보장, 스트립은 pane 전폭)이 실제로 다른 그림이 된다.
 *
 * 색은 **평가 대상이 아니다.** DESIGN.md 상 크로스헤어는 `--accent` 소유지만 저장
 * 구간과 충돌하므로 여기서는 형태(2px 실선·삼각·브래킷)로 먼저 분리했다. 색 축을
 * 바꿀지는 사용자 결정으로 넘긴다.
 */
import { memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { IChartApi, UTCTimestamp } from 'lightweight-charts';
import type { PaneSeriesMap } from '../../chart/drawing/chartCoordinates';
import { safeUnsubscribe } from '../../chart/util/safeUnsubscribe';
import { WindowViewContext } from '../../live/workspace/windowView';
import { isMinuteTimeframe } from '../../state/livePage';
import { unixMsToKSTDate } from '../../util/time';
import type { VirtualAxis } from '../../util/virtualAxis';
import { useStudyCursorSyncProtoStore } from './studyCursorSyncProto';

/** 좌상단 레전드(OHLC + 이동평균)와 저장 구간 라벨이 쓰는 높이. 그 아래로 내린다. */
const LEGEND_CLEARANCE_PX = 46;
/** 저장 구간 라벨(같은 y)과 겹치지 않게 커서 칩을 한 줄 더 내린다. */
const CHIP_TOP_PX = LEGEND_CLEARANCE_PX + 24;
/** 캔들이 0.85px 까지 좁아지므로 브래킷은 최소 폭을 보장한다. */
const MIN_BRACKET_PX = 12;

/** 정규장 09:00–15:30 KST. 변형 C 스트립의 분모. */
const SESSION_OPEN_MIN = 9 * 60;
const SESSION_CLOSE_MIN = 15 * 60 + 30;

type Props = {
  chart: IChartApi;
  axis: VirtualAxis;
  /** 이 창이 그리고 있는 일봉 캔들. `close` 는 변형 D 의 가로선 높이로 쓴다. */
  candles: readonly { ts_ms: number; close: number }[];
  /** 변형 D 전용 — `setCrosshairPosition` 이 시리즈 핸들을 요구한다. */
  paneSeries: PaneSeriesMap;
  code: string | null;
};

function kstHhmm(ms: number): string {
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function kstMmdd(ms: number): string {
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** 정규장 안에서의 진행 비율 0..1. 장 전/후는 양 끝으로 물린다. */
function sessionProgress(ms: number): number {
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  const min = d.getUTCHours() * 60 + d.getUTCMinutes();
  const raw = (min - SESSION_OPEN_MIN) / (SESSION_CLOSE_MIN - SESSION_OPEN_MIN);
  return Math.min(1, Math.max(0, raw));
}

const chipStyle = {
  background: 'var(--accent)',
  color: 'var(--accent-fg)',
} as const;

function StudyCursorSyncProtoOverlay({ chart, axis, candles, paneSeries, code }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [, force] = useState(0);
  const variant = useStudyCursorSyncProtoStore((s) => s.variant);
  const cursor = useStudyCursorSyncProtoStore((s) => s.cursor);
  const myWindowId = useContext(WindowViewContext)?.windowId ?? null;

  useEffect(() => {
    const ts = chart.timeScale();
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => force((n) => n + 1));
    };
    ts.subscribeVisibleLogicalRangeChange(schedule);
    const parent = containerRef.current?.parentElement;
    const ro = parent && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    if (ro && parent) ro.observe(parent);
    return () => {
      cancelAnimationFrame(raf);
      safeUnsubscribe(() => ts.unsubscribeVisibleLogicalRangeChange(schedule));
      ro?.disconnect();
    };
  }, [chart]);

  // KST 날짜 → 일봉 캔들. 이 맵이 두 좌표계를 잇는 유일한 다리다.
  const byDate = useMemo(() => {
    const m = new Map<string, { ts_ms: number; close: number }>();
    for (const c of candles) m.set(unixMsToKSTDate(c.ts_ms), c);
    return m;
  }, [candles]);

  // 필터 + 날짜 스냅을 **early return 위로** 올렸다 — 변형 D 는 렌더가 아니라 effect 로
  // 동작하는데(그리는 주체가 lwc 다), hook 은 조기 반환 뒤에 올 수 없기 때문이다.
  const match = useMemo(() => {
    if (!cursor) return null;
    // 소비 측 세 필터: 자기 창 제외 · 분봉 발행만 · 같은 종목.
    // `/study` 는 모든 창이 활성 저장뷰의 같은 code 를 보므로 code 는 형식적이다.
    if (cursor.windowId !== null && cursor.windowId === myWindowId) return null;
    if (!isMinuteTimeframe(cursor.timeframe)) return null;
    if (cursor.code !== null && code !== null && cursor.code !== code) return null;
    // 그 날의 일봉이 이 창에 없다(맥락 창 밖 · 휴장) → 가리킬 곳이 없다.
    return byDate.get(unixMsToKSTDate(cursor.tsMs)) ?? null;
  }, [cursor, myWindowId, code, byDate]);

  /**
   * 변형 D·E — **크로스헤어를 직접 그리지 않는다.** lwc 가 "두 차트의 크로스헤어
   * 동기화" 용도로 문서화한 `setCrosshairPosition` 을 부를 뿐이다(typings.d.ts 의
   * 그 예시가 곧 이 기능). E 는 여기에 시각 칩 하나만 더 얹는다(렌더 쪽).
   *
   * 두 가지가 A~C 와 다르다:
   *  - **가격도 요구한다.** 크로스헤어는 십자라 가로선이 함께 그려진다. 분봉의 가격을
   *    일봉에 옮기는 건 의미가 없어 **그 날 일봉의 종가**를 준다.
   *  - **화면 밖은 lwc 가 알아서 안 그린다.** D 는 엣지 인디케이터도 없다(A~C 와의
   *    비교 지점이라 일부러 보완하지 않았다). E 는 칩 경로를 타므로 엣지가 뜬다.
   */
  useEffect(() => {
    if (variant !== 'D' && variant !== 'E') return;
    const series = paneSeries.get('candle');
    if (!series || !match) return;
    chart.setCrosshairPosition(
      match.close,
      (axis.toVirtual(match.ts_ms) / 1000) as UTCTimestamp,
      series,
    );
    // 커서가 바뀔 때마다 이전 위치를 지운다 — 안 지우면 창을 벗어나도 남는다.
    return () => { chart.clearCrosshairPosition(); };
  }, [variant, match, chart, axis, paneSeries]);

  // PROTOTYPE 디버그 훅 — 안 그려질 때 "발행이 없는가 / 필터에 걸렸는가 / 그 날의
  // 일봉이 없는가 / 화면 밖인가" 를 밖에서 구분하려면 이 창이 쥔 걸 봐야 한다.
  // 사용자도 콘솔에서 직접 찔러볼 수 있게 남겨 둔다.
  // try/catch 는 방어가 아니라 **테스트 모의 대응**이다. 기존 `LiveChartRoot` 스펙의
  // timeScale 모의에는 `options()` 가 없어서, 이 훅이 그대로면 D 타임프레임 테스트
  // 27개가 프로토타입 때문에 깨진다. 던져버릴 코드가 실코드 스펙을 망가뜨리면 안 된다.
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    let x: unknown = null;
    let barSpacing: unknown = null;
    try {
      if (match) {
        x = chart.timeScale().timeToCoordinate((axis.toVirtual(match.ts_ms) / 1000) as UTCTimestamp);
      }
      barSpacing = chart.timeScale().options().barSpacing;
    } catch { /* 모의 차트 — 디버그 값만 비운다 */ }
    (window as unknown as Record<string, unknown>).__protoOverlayDebug = {
      myWindowId, code, variant, cursor,
      day: cursor ? unixMsToKSTDate(cursor.tsMs) : null,
      match, x, barSpacing,
      days: [...byDate.keys()],
      chart, axis, byDate, paneSeries,
    };
  }

  // D 는 lwc 가 전부 그린다 — DOM 을 내놓지 않는다(위 effect 가 전부).
  if (!variant || variant === 'D' || !cursor || !match) return null;

  const ts = chart.timeScale();
  const x = ts.timeToCoordinate((axis.toVirtual(match.ts_ms) / 1000) as UTCTimestamp);
  if (x == null) return null;

  const paneWidth = ts.width();
  const cx = x as number;
  const clock = kstHhmm(cursor.tsMs);
  const date = kstMmdd(cursor.tsMs);

  // 화면 밖 — **1차 실측이 드러낸 필수 케이스**. 두 창의 뷰포트가 독립이라 흔히
  // 벌어진다(실측: 커서가 pane 왼쪽 1,236px 밖). 아무것도 안 그리면 "동기화가
  // 고장났다" 로 읽히므로 방향과 날짜를 가장자리에 남긴다. 변형 축이 아니라
  // 세 변형 공통이다.
  if (cx < 0 || cx > paneWidth) {
    return (
      <Clip innerRef={containerRef} ts={ts}>
        <EdgeIndicator side={cx < 0 ? 'left' : 'right'} date={date} clock={clock} />
      </Clip>
    );
  }

  return (
    <Clip innerRef={containerRef} ts={ts}>
      {variant === 'A' && <VariantA cx={cx} clock={clock} paneWidth={paneWidth} />}
      {variant === 'B' && (
        <VariantB
          cx={cx}
          clock={clock}
          paneWidth={paneWidth}
          width={Math.max(MIN_BRACKET_PX, ts.options().barSpacing ?? MIN_BRACKET_PX)}
        />
      )}
      {variant === 'C' && (
        <VariantC cx={cx} clock={clock} progress={sessionProgress(cursor.tsMs)} />
      )}
      {/* E — 선은 lwc 가 이미 그렸다(위 effect). 여기서는 시간축 배지가 채우지 못하는
          **시:분**만 얹는다. 칩은 A 와 같은 것을 재사용한다. */}
      {variant === 'E' && <Chip cx={cx} paneWidth={paneWidth} top={CHIP_TOP_PX} text={clock} />}
    </Clip>
  );
}

/**
 * pane 박스 클립. `inset-0` 로 두면 컨테이너가 우측 가격축 거터 + 하단 시간축을
 * 덮는데 `timeToCoordinate` 가 주는 건 **pane 좌표**라 두 좌표계의 끝 경계가 다르다
 * (#1272). `z-10` 으로 올렸으면 반드시 잘라야 한다.
 */
// prop 이름이 `innerRef` 인 이유: 이 리포는 React 18 이라 함수 컴포넌트에 `ref` 를
// 그냥 넘기면 경고와 함께 **버려진다** — 그러면 아래 `ResizeObserver` 가 관찰할
// parent 를 못 찾아 리사이즈 시 좌표가 갱신되지 않는다(조용한 고장).
const Clip = ({
  innerRef, ts, children,
}: {
  innerRef: React.Ref<HTMLDivElement>;
  ts: ReturnType<IChartApi['timeScale']>;
  children: React.ReactNode;
}) => (
  <div
    ref={innerRef}
    data-testid="study-cursor-sync-proto"
    className="pointer-events-none absolute top-0 left-0 z-10 overflow-hidden"
    style={{ width: `${ts.width()}px`, bottom: `${ts.height()}px` }}
  >
    {children}
  </div>
);

/** A — 순간 위치 하나. 2px 헤어라인 + 아래를 지목하는 삼각 + 시각 칩. 가장 조용하다. */
function VariantA({ cx, clock, paneWidth }: { cx: number; clock: string; paneWidth: number }) {
  return (
    <>
      <div
        data-testid="proto-a-line"
        className="absolute top-0 bottom-0"
        style={{ left: `${cx - 1}px`, width: '2px', background: 'var(--accent)' }}
      />
      <Triangle cx={cx} top={CHIP_TOP_PX + 18} />
      <Chip cx={cx} paneWidth={paneWidth} top={CHIP_TOP_PX} text={clock} />
    </>
  );
}

/**
 * B — 그 캔들을 **지목**한다. 밴드가 아니라 위아래 브래킷이라 저장 구간 tint 와
 * 색으로 싸우지 않고, 최소 폭이 있어 `barSpacing` 0.85px 에서도 살아남는다.
 */
function VariantB({
  cx, width, clock, paneWidth,
}: { cx: number; width: number; clock: string; paneWidth: number }) {
  const w = Math.max(MIN_BRACKET_PX, width);
  const left = cx - w / 2;
  const arm = Math.max(3, w / 3);
  return (
    <>
      {/* 좌우 기둥 + 상단 캡 = ⊓ 채널. **면이 아니라 선**이라 저장 구간의 tint 밴드
          위에 얹혀도 서로를 지우지 않는다(1차 실측에서 밴드끼리 부딪혔다). 가운데를
          비워 두므로 캔들 자체는 가리지 않는다. */}
      {([0, 1] as const).map((i) => (
        <div
          key={i}
          data-testid={`proto-b-post-${i}`}
          className="absolute top-0 bottom-0"
          style={{
            left: `${i === 0 ? left : left + w - 2}px`,
            width: '2px',
            background: 'var(--accent)',
          }}
        />
      ))}
      <div
        data-testid="proto-b-cap"
        className="absolute"
        style={{
          left: `${left}px`,
          width: `${w}px`,
          top: `${CHIP_TOP_PX + 20}px`,
          height: `${arm}px`,
          borderTop: '2px solid var(--accent)',
        }}
      />
      <Chip cx={cx} paneWidth={paneWidth} top={CHIP_TOP_PX} text={clock} />
    </>
  );
}

/**
 * C — **캔들 폭에서 벗어난다.** 하루 안 어디인지를 pane 하단 전폭 스트립으로 옮겨,
 * `barSpacing` 이 1px 이든 20px 이든 같은 해상도로 읽히게 한다. 캔들 위치는 1px
 * 헤어라인으로만 남긴다. 스토어가 날짜가 아니라 raw ms 를 실어야 하는 이유가 이 변형.
 */
function VariantC({ cx, clock, progress }: { cx: number; clock: string; progress: number }) {
  return (
    <>
      <div
        className="absolute top-0 bottom-0 w-px"
        style={{ left: `${cx}px`, background: 'var(--accent)', opacity: 0.7 }}
      />
      {/* 하단 스트립 — 레전드·저장구간 라벨이 점유한 상단을 피한다. */}
      <div className="absolute right-2 bottom-2 left-2 h-[18px]">
        <div
          className="absolute inset-0 rounded-sm"
          style={{ background: 'var(--tint-neutral)' }}
        />
        <div
          data-testid="proto-c-fill"
          className="absolute top-0 bottom-0 left-0 rounded-l-sm"
          style={{ width: `${progress * 100}%`, background: 'var(--tint-selection)' }}
        />
        <div
          data-testid="proto-c-tick"
          className="absolute top-0 bottom-0"
          style={{ left: `${progress * 100}%`, width: '2px', background: 'var(--accent)' }}
        />
        <span
          className="absolute top-1/2 left-1 -translate-y-1/2 text-[10px] tabular-nums"
          style={{ color: 'var(--fg-dimmer)' }}
        >
          09:00
        </span>
        <span
          className="absolute top-1/2 right-1 -translate-y-1/2 text-[10px] tabular-nums"
          style={{ color: 'var(--fg-dimmer)' }}
        >
          15:30
        </span>
        <span
          className="absolute -translate-x-1/2 rounded-sm px-1 text-[10px] tabular-nums"
          style={{ ...chipStyle, top: '-16px', left: `${progress * 100}%` }}
        >
          {clock}
        </span>
      </div>
    </>
  );
}

/** 커서가 이 창의 가시 범위 밖일 때 — 방향 + 언제인지만 남긴다. */
function EdgeIndicator({
  side, date, clock,
}: { side: 'left' | 'right'; date: string; clock: string }) {
  return (
    <div
      data-testid={`proto-edge-${side}`}
      className="absolute flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] tabular-nums"
      style={{ ...chipStyle, top: `${CHIP_TOP_PX}px`, [side]: '4px' }}
    >
      {side === 'left' && <span>◀</span>}
      <span>{date} {clock}</span>
      {side === 'right' && <span>▶</span>}
    </div>
  );
}

function Chip({
  cx, paneWidth, top, text,
}: { cx: number; paneWidth: number; top: number; text: string }) {
  return (
    <div
      data-testid="proto-chip"
      className="absolute -translate-x-1/2 rounded-sm px-1.5 py-0.5 text-[11px] tabular-nums"
      style={{
        ...chipStyle,
        top: `${top}px`,
        left: `${Math.min(Math.max(cx, 26), Math.max(26, paneWidth - 26))}px`,
      }}
    >
      {text}
    </div>
  );
}

function Triangle({ cx, top }: { cx: number; top: number }) {
  return (
    <div
      className="absolute -translate-x-1/2"
      style={{
        top: `${top}px`,
        left: `${cx}px`,
        width: 0,
        height: 0,
        borderLeft: '5px solid transparent',
        borderRight: '5px solid transparent',
        borderTop: '6px solid var(--accent)',
      }}
    />
  );
}

export default memo(StudyCursorSyncProtoOverlay);
