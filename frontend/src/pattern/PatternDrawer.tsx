import { useCallback, useEffect, useMemo, useState } from 'react';
import { RailDrawer, RailDrawerBody, RailDrawerHeader, RailState } from '../ui/RailShell';
import { SegmentedControl } from '../ui/PageShell';
import { useLivePageStore } from '../state/livePage';
import { useJumpToLive, wantsNewTab, type JumpModifiers } from '../live/useJumpToLive';
import {
  regularSessionCloseMs,
  regularSessionOpenMs,
  subtractDaysKst,
} from '../live/liveDateTime';
import { usePatternQueryStore } from './patternQuery';
import { activationTarget, useWorkspaceStore } from '../state/workspace';
import type { PatternMatchRow, PatternSearchMode } from '../api/screener';
import { CandleThumb } from './CandleThumb';
import { SimilarityStrip } from './SimilarityStrip';
import {
  DEFAULT_FILTERS,
  DEFAULT_LENGTH,
  NOW_LENGTHS,
  VOLUME_WEIGHT_ON,
  resultForLength,
  usePatternSearch,
} from './usePatternSearch';

/**
 * 봉 패턴 검색 패널 (ADR-0166) — 레일 형제(스크리너·순위와 같은 계열).
 *
 * 화면이 지키는 것 셋. 셋 다 **실측이 근거**라 UI 취향으로 바꾸면 안 된다:
 *
 * 1. **봉수를 숨기지 않는다.** 길이를 바꾸면 답이 갈린다(SK하이닉스가 5·7봉 1위인데
 *    10봉에서 4위로 밀린다). 고정값으로 박으면 "며칠짜리 패턴인가" 라는 질문이
 *    화면에서 사라진다. `now` 는 길이를 묶어 받으므로 스테퍼가 **네트워크 없이** 돈다.
 * 2. **유사도를 숫자로만 그리지 않는다.** 분포 스트립이 옆에 붙는다.
 * 3. **베이스라인은 끌 수 없다.** 과거 탭 하단에 고정 — 매치 승률만 보이면 반드시
 *    신호로 오독되는데, 실측상 둘의 차이는 쿼리마다 부호가 뒤집힌다.
 *
 * ## 기준 종목은 `activeCode` 를 **추적하지 않는다**
 *
 * 패널을 열 때 한 번 시드하고, 그 뒤로는 화면 종목이 어떻게 바뀌든 움직이지 않는다.
 * 매치를 클릭하면 화면 종목이 바뀌는데 기준까지 따라가면 **목록이 통째로 갈려**
 * 결과를 하나씩 훑어볼 수가 없다 — 브라우저 확인에서 실제로 그랬다.
 *
 * 「매치 클릭」과 「사용자가 검색으로 바꾼 종목」을 출처로 구별하려 하지 않는다.
 * 그건 상태 전이가 이벤트 출처에 따라 갈리는 설계라 사용자 모델에 없다. 대신
 * **추적 자체를 없애** 그 구별이 필요 없게 만든다. 기준이 바뀌는 길은 둘뿐이다:
 *
 * 1. 헤더의 「현재 종목으로」 — `activeCode` 와 기준이 다를 때만 보인다. **그 버튼의
 *    존재가 곧 "기준과 화면이 다르다" 는 표시**를 겸한다.
 * 2. 차트에서 그은 구간(measure) — 새 검색이므로 그 종목이 새 기준이다.
 *
 * 패널을 닫으면 언마운트되므로(App 의 조건부 렌더) 다음에 열 때 다시 시드된다.
 */

const MODES: { key: PatternSearchMode; label: string }[] = [
  { key: 'now', label: '지금 닮은 종목' },
  { key: 'history', label: '과거에 이 모양' },
];

/** 매치 구간 **앞쪽**으로 함께 불러올 달력일. `studyDailyViewport` 가 구간보다 넓게
 *  보여주므로(맥락 배율) 시작일에 딱 맞추면 왼쪽이 잘린다. */
const CONTEXT_DAYS = 200;

const MIN_LENGTH = NOW_LENGTHS[0];
const MAX_LENGTH = NOW_LENGTHS[NOW_LENGTHS.length - 1];

/** `YYYYMMDD` → `YYYY-MM-DD`. 백엔드는 wire 에서 구분자 없는 형식을 쓴다. */
function formatDate(ymd: string): string {
  return ymd.length === 8 ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)}` : ymd;
}

/** 구간 라벨. 드로어가 좁아 **같은 해면 끝쪽 연도를 접는다** — 과거 매치는 연도가
 *  정보라 앞쪽은 남긴다(2018 년의 그 패턴인지가 사용자의 관심사다). */
function formatRange(from: string, to: string): string {
  const tail = from.slice(0, 4) === to.slice(0, 4) ? formatDate(to).slice(5) : formatDate(to);
  return `${formatDate(from)} ~ ${tail}`;
}

/** 과거 매치를 **그 날의 구간**으로 여는 focus 값.
 *
 * 저장뷰가 쓰는 슬롯을 그대로 빌린다 — 일봉에서 그 슬롯은 밴드와 뷰포트만 세우고
 * **창을 얼리지 않는다**(`savedRangeFreeze` 가 분봉 조건부다). 그래서 착지 후에도
 * 좌우 팬이 살아 있고, `studyDailyViewport` 가 구간 뒤로 여유를 줘서 「그 다음에 뭐가
 * 왔나」가 함께 보인다 — 이 기능의 핵심 질문이 그것이다.
 *
 * ⚠ **착지 창을 일봉으로 돌려놓아야 한다**(`openPatternMatch`). 저장뷰는 사용자가
 * 분봉 구간을 저장했을 때만 분봉으로 얼지만, 패턴 매치는 **항상 일봉 구간**이라
 * 분봉 창에 그대로 꽂으면 2018년 분봉을 요구하게 되고 그건 디스크에 없다 —
 * 브라우저 확인에서 "저장 구간에 캔들이 없다" 로 화면이 통째로 비었다.
 */
function patternRangeFocus(row: PatternMatchRow) {
  return {
    // viewKey(`sv=`)에 섞이는 값이라 매치마다 달라야 착석이 다시 산다.
    viewId: `pattern:${row.code}:${row.from_date}`,
    code: row.code,
    label: row.name || row.code,
    fromMs: regularSessionOpenMs(row.from_date),
    // 마지막 봉(09:00 ts)이 밴드 안에 들도록 **종가 쪽**까지 연다 —
    // `studyDailyContext` 의 필터가 `ts_ms <= toMs` 라 경계가 열려 있어야 한다.
    toMs: regularSessionCloseMs(row.to_date),
    fromDate: row.from_date,
    toDate: row.to_date,
    savedTimeframe: 'D' as const,
    // 일봉 경로는 `studyDailyViewport` 가 구간에서 유도하므로 **이 값을 쓰지 않는다**.
    savedBarSpan: 0,
  };
}

/**
 * 매치가 착지하는 **차트 창** id.
 *
 * `activationTarget` 을 그대로 쓸 수 없다 — 그건 zOrder 역순의 첫 핀 아닌 창일 뿐
 * **`kind` 를 보지 않는다**(종목 교체는 그룹 단위라 그걸로 충분하다). 브라우저
 * 확인에서 그 창이 거래원 창이라 타임프레임 전환이 조용히 no-op 이 됐고, 화면은
 * "저장 구간에 캔들이 없다" 로 비었다.
 *
 * 그래서 착지 창의 **그룹**을 구한 뒤 그 그룹에서 zOrder 상 가장 위인 차트 창을
 * 고른다 — 그게 사용자가 보고 있는 창이다.
 */
function patternLandingChart(ws: ReturnType<typeof useWorkspaceStore.getState>): string | null {
  const target = activationTarget(ws);
  if (target.kind !== 'window') return null;
  const group = target.window.group;
  for (let i = ws.zOrder.length - 1; i >= 0; i -= 1) {
    const win = ws.windows.find((w) => w.id === ws.zOrder[i]);
    if (win?.kind === 'chart' && win.group === group) return win.id;
  }
  return null;
}

function formatPct(v: number | null): string {
  if (v == null) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

/** 표시된 매치들의 이후 수익률 요약.
 *
 * **중앙값이어야 한다** — 백엔드 베이스라인이 중앙값이라, 여기서 평균을 쓰면 두 줄이
 * 다른 축이 되어 나란히 놓은 의미가 사라진다(꼬리가 긴 분포라 차이가 크다).
 * `null`(계열 끝이라 이후가 없는 매치)은 0 이 아니라 **표본에서 뺀다**. */
function matchSummary(rows: PatternMatchRow[]): { median: number; winRate: number; n: number } | null {
  const vals = rows.map((r) => r.forward_pct).filter((v): v is number => v != null);
  if (!vals.length) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    median,
    winRate: (vals.filter((v) => v > 0).length / vals.length) * 100,
    n: vals.length,
  };
}

function MatchRow({
  row,
  mode,
  dist,
  onOpen,
}: {
  row: PatternMatchRow;
  mode: PatternSearchMode;
  dist: { p50: number; p95: number; p99: number; p99_99: number | null };
  onOpen: (row: PatternMatchRow, e: JumpModifiers) => void;
}) {
  const forward = row.forward_pct;
  return (
    <button
      type="button"
      onClick={(e) => onOpen(row, e)}
      className="grid w-full grid-cols-[1fr_5.25rem_3.5rem] items-center gap-sm border-b border-grid px-md py-xs text-left hover:bg-bg-input-hover"
    >
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium text-fg">{row.name || row.code}</span>
        <span className="block truncate font-data text-2xs text-fg-dimmer">
          {mode === 'history' ? formatRange(row.from_date, row.to_date) : row.code}
        </span>
      </span>
      <CandleThumb bars={row.bars} tail={row.tail} height={34} />
      <span className="flex flex-col items-end gap-[3px]">
        <span className="font-data text-xs font-semibold text-accent">{row.corr.toFixed(3)}</span>
        {mode === 'history' ? (
          <span
            className="font-data text-2xs"
            style={{ color: (forward ?? 0) >= 0 ? 'var(--price-up)' : 'var(--price-down)' }}
          >
            {formatPct(forward)}
          </span>
        ) : (
          <SimilarityStrip value={row.corr} dist={dist} className="w-full" />
        )}
      </span>
    </button>
  );
}

export function PatternDrawer() {
  const activeCode = useLivePageStore((s) => s.activeCode);
  const activeInstrument = useLivePageStore((s) => s.activeInstrument);
  /** 검색의 기준. **열 때 한 번만** `activeCode` 에서 시드되고 이후 따라가지 않는다. */
  const [subject, setSubject] = useState<{ code: string; label: string } | null>(null);
  const [mode, setMode] = useState<PatternSearchMode>('now');
  const [length, setLength] = useState(DEFAULT_LENGTH);
  // 차트가 건넨 구간(measure). **1회 소비**라 스테퍼를 만진 뒤 되돌아오지 않는다.
  const [seededRange, setSeededRange] = useState<{ from: string; to: string } | null>(null);
  /** 한 종목에서 몇 자리를 볼지. 1 = 다양성 · 5 = "그 패턴이 나온 자리를 전부". */
  const [perCode, setPerCode] = useState(1);
  /** 거래량을 유사도에 섞을지. **숫자를 화면에 내지 않는다** — 계약은 "함께" 다. */
  const [withVolume, setWithVolume] = useState(false);
  const consumeSeed = usePatternQueryStore((s) => s.consumePatternQuery);
  const pendingSeed = usePatternQueryStore((s) => s.pending);
  const jump = useJumpToLive();
  const focusSavedRange = useLivePageStore((s) => s.focusSavedRange);

  // 최초 시드 — 기준이 아직 없을 때만. 이 조건이 「열 때 한 번」을 만든다
  // (패널은 닫으면 언마운트되므로 다음 열림에서 다시 시드된다).
  useEffect(() => {
    if (subject || !activeCode) return;
    setSubject({ code: activeCode, label: activeInstrument?.label ?? activeCode });
  }, [subject, activeCode, activeInstrument]);

  useEffect(() => {
    if (!pendingSeed) return;
    const seed = consumeSeed();
    if (!seed) return;
    // 차트에서 그은 구간은 **새 검색**이라 그 종목이 새 기준이다.
    setSubject({ code: seed.code, label: seed.label ?? seed.code });
    setSeededRange({ from: seed.from, to: seed.to });
    // ★ 과거 어느 구간을 긋든 묻는 것은 "이 패턴이 **과거 어디에서** 또 나왔나" 다.
    //   `now`(각 종목의 최신 봉)로 두면 그은 구간과 무관한 답을 낸다.
    //   탭은 살려 둔다 — "이 과거 패턴과 지금 같은 모양인 종목" 도 유효한 질문이다.
    setMode('history');
  }, [pendingSeed, consumeSeed]);

  const { data, isPending, isError, error } = usePatternSearch({
    code: subject?.code ?? null,
    mode,
    length,
    range: seededRange,
    filters: DEFAULT_FILTERS,
    perCode,
    volumeWeight: withVolume ? VOLUME_WEIGHT_ON : 0,
  });

  const result = useMemo(
    // 구간을 건네받았으면 **그 구간이 곧 길이**라 서버가 결과를 하나만 준다.
    () => (seededRange ? (data?.results[0] ?? null) : resultForLength(data?.results, length)),
    [data, length, seededRange],
  );
  const summary = useMemo(() => (result ? matchSummary(result.matches) : null), [result]);

  const onOpen = useCallback(
    (row: PatternMatchRow, e: JumpModifiers) => {
      // 지금 매치는 종목만 바꾼다 — 그 종목의 '지금' 이 곧 매치 구간이다.
      if (mode === 'now') {
        jump(row.code, row.name || row.code, e);
        return;
      }
      // 과거 매치는 종목 + **그 날의 구간**. 순서가 계약이다(`openSavedRangeInLive` 와
      // 동일): 종목 교체가 "종목이 바뀌면 저장 구간 해제" 트리거를 품고 있어,
      // focus 를 먼저 세우면 그 자리에서 지워진다.
      const ws = useWorkspaceStore.getState();
      const landing = patternLandingChart(ws);
      jump(row.code, row.name || row.code, e);
      // 새 탭은 이 창을 건드리지 않으므로 구간 슬롯도 세우지 않는다.
      if (wantsNewTab(e)) return;
      // 착지 **차트 창**을 일봉으로. 패턴 구간은 일봉이라 분봉 창에 꽂으면 그 날의
      // 분봉을 요구하게 되고, 오래된 날짜면 디스크에 없어 화면이 통째로 빈다.
      if (landing) {
        ws.setChartTimeframe(landing, 'D');
        // ★ 그 구간의 캔들을 **먼저 불러와야** 한다. `studyDailyViewport` 는 이미 로드된
        //   캔들 안에서 구간을 찾고, 없으면 최신 봉으로 폴백한다 — 저장뷰는 사용자가
        //   이미 본 구간이라 문제가 없었지만 패턴 매치는 **한 번도 안 본 과거**다.
        //   실측: 2018년 매치를 눌러도 차트가 2025-09 에 머물렀다.
        //   일봉은 캔들 수가 늘면 초기 뷰포트를 **다시 적용**하므로(LiveChartRoot 의
        //   `lastAppliedCountRef` 주석) 범위만 늘리면 착지는 기존 기계가 한다.
        ws.extendChartHistoricalRange(landing, subtractDaysKst(row.from_date, CONTEXT_DAYS));
      }
      focusSavedRange(patternRangeFocus(row));
    },
    [jump, focusSavedRange, mode],
  );

  return (
    <RailDrawer id="right-rail-pattern-panel" testId="pattern-drawer" ariaLabel="봉 패턴 검색">
      <RailDrawerHeader title="패턴" />

      <div className="flex flex-col gap-sm border-b border-border px-md pb-sm">
        <div className="flex items-baseline justify-between gap-sm">
          <span className="truncate text-sm font-semibold text-fg">
            {data?.name || subject?.label || '종목 없음'}
          </span>
          <span className="shrink-0 font-data text-2xs text-fg-dimmer">
            {result ? formatRange(result.query.from_date, result.query.to_date) : ''}
          </span>
        </div>

        {activeCode && subject && activeCode !== subject.code && (
          <button
            type="button"
            onClick={() =>
              setSubject({ code: activeCode, label: activeInstrument?.label ?? activeCode })
            }
            className="self-start rounded border border-border px-2 py-[3px] text-2xs text-fg-dim hover:bg-bg-input-hover hover:text-fg"
          >
            기준을 «{activeInstrument?.label ?? activeCode}» 로 바꾸기
          </button>
        )}

        {result && <CandleThumb bars={result.query.bars} height={56} />}

        {seededRange ? (
          <div className="flex items-center gap-sm">
            <span className="inline-flex items-center gap-1.5 rounded border border-accent bg-tint-selection px-2 py-[3px] text-2xs text-accent">
              차트에서 그은 구간{result ? ` · ${result.length}봉` : ''}
              <button
                type="button"
                aria-label="구간 해제"
                onClick={() => setSeededRange(null)}
                className="text-accent hover:opacity-70"
              >
                ✕
              </button>
            </span>
            <span className="min-w-0 flex-1 truncate text-2xs text-fg-dim">
              길이는 그은 구간이 정한다
            </span>
          </div>
        ) : (
        <div className="flex items-center gap-sm">
          <div className="flex items-center overflow-hidden rounded border border-border">
            <button
              type="button"
              aria-label="봉수 줄이기"
              disabled={length <= MIN_LENGTH}
              onClick={() => setLength((n) => Math.max(MIN_LENGTH, n - 1))}
              className="bg-bg-input px-sm py-[3px] text-fg hover:bg-bg-input-hover disabled:text-fg-dimmer disabled:hover:bg-bg-input"
            >
              −
            </button>
            <span className="border-x border-border px-sm py-[3px] font-data text-xs font-semibold tabular-nums">
              {length}봉
            </span>
            <button
              type="button"
              aria-label="봉수 늘리기"
              disabled={length >= MAX_LENGTH}
              onClick={() => setLength((n) => Math.min(MAX_LENGTH, n + 1))}
              className="bg-bg-input px-sm py-[3px] text-fg hover:bg-bg-input-hover disabled:text-fg-dimmer disabled:hover:bg-bg-input"
            >
              +
            </button>
          </div>
          <span className="min-w-0 flex-1 truncate text-2xs text-fg-dim">
            {mode === 'now' ? '봉수를 바꾸면 즉시 다시 찾는다' : '과거 전체는 봉수마다 다시 계산한다'}
          </span>
        </div>
        )}
      </div>

      <div className="flex items-center gap-sm px-md pt-sm">
        <span className="text-2xs text-fg-dim">무엇으로</span>
        <SegmentedControl aria-label="비교 축">
          {[
            { on: false, label: '캔들 모양만' },
            { on: true, label: '거래량 함께' },
          ].map((o) => {
            const sel = withVolume === o.on;
            return (
              <button
                key={o.label}
                type="button"
                aria-pressed={sel}
                onClick={() => setWithVolume(o.on)}
                className={`px-2 py-[3px] text-2xs ${sel ? 'bg-tint-selection text-accent' : 'text-fg-dim hover:bg-bg-input-hover'}`}
              >
                {o.label}
              </button>
            );
          })}
        </SegmentedControl>
      </div>

      {mode === 'history' && (
        <div className="flex items-center gap-sm px-md pt-sm">
          <span className="text-2xs text-fg-dim">한 종목에서</span>
          <SegmentedControl aria-label="종목당 매치 수">
            {[
              { v: 1, label: '가장 닮은 1자리' },
              { v: 5, label: '나온 자리 전부' },
            ].map((o) => {
              const on = perCode === o.v;
              return (
                <button
                  key={o.v}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setPerCode(o.v)}
                  className={`px-2 py-[3px] text-2xs ${on ? 'bg-tint-selection text-accent' : 'text-fg-dim hover:bg-bg-input-hover'}`}
                >
                  {o.label}
                </button>
              );
            })}
          </SegmentedControl>
        </div>
      )}

      <div className="px-md py-sm">
        <SegmentedControl aria-label="패턴 검색 범위" className="w-full">
          {MODES.map((m) => {
            const on = mode === m.key;
            return (
              <button
                key={m.key}
                type="button"
                aria-pressed={on}
                onClick={() => setMode(m.key)}
                className={`flex-1 px-2 py-[3px] text-xs ${on ? 'bg-tint-selection text-accent' : 'text-fg-dim hover:bg-bg-input-hover'}`}
              >
                {m.label}
              </button>
            );
          })}
        </SegmentedControl>
      </div>

      {!subject ? (
        <RailState>차트에서 종목을 고르면 그 봉 패턴으로 찾는다.</RailState>
      ) : isError ? (
        <RailState tone="error">패턴 검색에 실패했다: {(error as Error)?.message ?? '알 수 없는 오류'}</RailState>
      ) : isPending ? (
        <RailState>찾는 중…</RailState>
      ) : !result ? (
        <RailState>
          {seededRange
            ? '그은 구간에 해당하는 일봉이 없다.'
            : `이 종목은 ${length}봉을 채울 이력이 없다.`}
        </RailState>
      ) : (
        <>
          <div className="px-md pb-xs font-data text-2xs text-fg-dimmer">
            {mode === 'now'
              ? `${result.universe.toLocaleString()}종목 비교 · ${Math.round(result.elapsed_ms)}ms`
              : `${result.dist.sample.toLocaleString()}개 구간 비교 · ${Math.round(result.elapsed_ms)}ms`}
          </div>
          <RailDrawerBody>
            {result.matches.length === 0 ? (
              <RailState>조건에 맞는 매치가 없다.</RailState>
            ) : (
              result.matches.map((row) => (
                <MatchRow
                  key={`${row.code}-${row.from_date}`}
                  row={row}
                  mode={mode}
                  dist={result.dist}
                  onOpen={onOpen}
                />
              ))
            )}
          </RailDrawerBody>
          {result.baseline && (
            <div className="flex flex-col gap-[2px] border-t border-border-strong px-md py-sm">
              <span className="text-2xs font-semibold uppercase text-fg-dim">이후 20일 · 항상 표시</span>
              {summary && (
                <span className="flex justify-between font-data text-2xs text-fg">
                  <span>매치 상위 {summary.n}개</span>
                  <span>
                    {formatPct(summary.median)} · 승률 {summary.winRate.toFixed(0)}%
                  </span>
                </span>
              )}
              <span className="flex justify-between font-data text-2xs text-fg-dim">
                <span>전체 구간 베이스라인</span>
                <span>
                  {formatPct(result.baseline.fwd_median_pct)} · 승률{' '}
                  {result.baseline.fwd_win_rate_pct.toFixed(0)}%
                </span>
              </span>
            </div>
          )}
        </>
      )}
    </RailDrawer>
  );
}
