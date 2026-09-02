import { useCallback, useMemo, useState } from 'react';
import { RailDrawer, RailDrawerBody, RailDrawerHeader, RailState } from '../ui/RailShell';
import { SegmentedControl } from '../ui/PageShell';
import { useLivePageStore } from '../state/livePage';
import { useJumpToLive, type JumpModifiers } from '../live/useJumpToLive';
import type { PatternMatchRow, PatternSearchMode } from '../api/screener';
import { CandleThumb } from './CandleThumb';
import { SimilarityStrip } from './SimilarityStrip';
import {
  DEFAULT_FILTERS,
  DEFAULT_LENGTH,
  NOW_LENGTHS,
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
 * 기준 종목은 `activeCode`(포커스 창이 그리는 종목)다. 창을 핀해 두면 결과 클릭이
 * 다른 창으로 가므로 기준 차트가 남는다 — `activationTarget` 이 이미 그 규칙이다.
 */

const MODES: { key: PatternSearchMode; label: string }[] = [
  { key: 'now', label: '지금 닮은 종목' },
  { key: 'history', label: '과거에 이 모양' },
];

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
  const [mode, setMode] = useState<PatternSearchMode>('now');
  const [length, setLength] = useState(DEFAULT_LENGTH);
  const jump = useJumpToLive();

  const { data, isPending, isError, error } = usePatternSearch({
    code: activeCode,
    mode,
    length,
    filters: DEFAULT_FILTERS,
  });

  const result = useMemo(() => resultForLength(data?.results, length), [data, length]);
  const summary = useMemo(() => (result ? matchSummary(result.matches) : null), [result]);

  const onOpen = useCallback(
    (row: PatternMatchRow, e: JumpModifiers) => {
      // v1 은 종목 교체까지다 — 과거 매치의 **그 날로** 가는 이동은 별도 PR 이
      // 필요하다(차트의 `asOfDate` 레버 + 구간 밴드를 저장뷰 freeze 에서 분리).
      jump(row.code, row.name || row.code, e);
    },
    [jump],
  );

  return (
    <RailDrawer id="right-rail-pattern-panel" testId="pattern-drawer" ariaLabel="봉 패턴 검색">
      <RailDrawerHeader title="패턴" />

      <div className="flex flex-col gap-sm border-b border-border px-md pb-sm">
        <div className="flex items-baseline justify-between gap-sm">
          <span className="truncate text-sm font-semibold text-fg">
            {data?.name || activeInstrument?.label || activeCode || '종목 없음'}
          </span>
          <span className="shrink-0 font-data text-2xs text-fg-dimmer">
            {result ? formatRange(result.query.from_date, result.query.to_date) : ''}
          </span>
        </div>

        {result && <CandleThumb bars={result.query.bars} height={56} />}

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
      </div>

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

      {!activeCode ? (
        <RailState>차트에서 종목을 고르면 그 봉 패턴으로 찾는다.</RailState>
      ) : isError ? (
        <RailState tone="error">패턴 검색에 실패했다: {(error as Error)?.message ?? '알 수 없는 오류'}</RailState>
      ) : isPending ? (
        <RailState>찾는 중…</RailState>
      ) : !result ? (
        <RailState>이 종목은 {length}봉을 채울 이력이 없다.</RailState>
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
