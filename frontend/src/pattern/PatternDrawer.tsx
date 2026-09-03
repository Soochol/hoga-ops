import { useCallback, useEffect, useMemo, useState } from 'react';
import { RailDrawer, RailDrawerBody, RailDrawerHeader, RailState } from '../ui/RailShell';
import { SegmentedControl } from '../ui/PageShell';
import { useLivePageStore, isMinuteTimeframe } from '../state/livePage';
import { useJumpToLive, wantsNewTab, type JumpModifiers } from '../live/useJumpToLive';
import { moveToAdjacentQuoteRow } from '../rightrail/quoteRowNav';
import {
  regularSessionCloseMs,
  regularSessionOpenMs,
  subtractDaysKst,
} from '../live/liveDateTime';
import { isPatternSearchableTimeframe, usePatternQueryStore } from './patternQuery';
import { PatternConditionChips } from './PatternConditionChips';
import { PatternSavesView } from './PatternSavesView';
import {
  suggestPatternSaveName,
  useCreatePatternSave,
  useDeletePatternSave,
  useUpdatePatternSave,
  usePatternSaves,
} from './usePatternSaves';
import type { PatternSave } from '../api/screener';
import {
  DEFAULT_CONDITIONS,
  PERIODS,
  mergeByHeadroom,
  sinceFor,
  exclusionKey,
  isExcludedRow,
  visibleRows,
  withWholeCodeExcluded,
  type PatternConditions,
  defaultConditionsFor,
} from './patternConditions';
import { activationTarget, useWorkspaceStore } from '../state/workspace';
import type { PatternExclusion, PatternMatchRow, PatternSearchMode } from '../api/screener';
import { CandleThumb } from './CandleThumb';
import { PatternMatchRowMenu } from './PatternMatchRowMenu';
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
/** 구간 이동의 대상. 매치 행과 **검색 기준 구간**이 같은 경로를 타므로 행 전체가 아니라
 *  이동에 필요한 넷만 요구한다. */
type RangeTarget = Pick<PatternMatchRow, 'code' | 'name' | 'from_date' | 'to_date'>;

function patternRangeFocus(row: RangeTarget, timeframe: PatternTimeframe) {
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
    savedTimeframe: timeframe,
    // 몇 년 전 구간이라 **분봉이 디스크에 없다** — 분봉 창이 이 날짜로 얼면 화면이
    // 통째로 빈다(사용자 신고 2026-09-02). 저장뷰와 달리 「분봉 벽」이라는 표현이
    // 애초에 존재하지 않는 구간이다.
    //
    // ⚠ 이름은 `dailyOnly` 지만 게이트는 **「분봉 제외」**다
    // (`savedRangeFocus.ts`: `!(dailyOnly && isMinuteTimeframe(tf))`). 주봉 매치도
    // 분봉엔 없으므로 그 뜻 그대로 맞다 — 넓힐 필요가 없다.
    dailyOnly: true,
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
/** 매치 구간이 착지할 차트 창 — 같은 그룹에서 **이미 캘린더 봉(D·W·M)인** 창을 고른다.
 *
 *  `kind === 'chart'` 만 보면 zOrder 최상위가 분봉 창일 때 **그 창을 일봉으로 갈아엎는다**
 *  (사용자 신고 2026-09-02: 일봉·분봉 두 창을 띄웠는데 매치를 누르니 둘 다 일봉이 됐다).
 *  분봉 창은 사용자가 그 봉을 보려고 띄운 것이고, 패턴 구간은 거기서 볼 수 있는 것도
 *  아니다(몇 년 전이라 분봉이 없다).
 *
 *  캘린더 봉 창이 하나도 없으면 `null` — **봉을 바꾸지 않고** 종목만 옮긴다. 분봉만
 *  띄운 화면에서는 그게 할 수 있는 전부다.
 */
/** 지금 화면이 보고 있는 **캘린더 봉**. 패널을 열 때 검색의 봉 단위를 여기서 시드한다 —
 *  주봉 차트를 보다 열면 주봉 검색이 자연스럽다.
 *
 *  ⚠ 시드일 뿐 **추적이 아니다.** 화면 차트를 계속 따라가면 매치를 눌러 차트가 바뀔
 *  때마다 결과가 다시 계산돼 두 번째 매치를 볼 수 없다(기준 종목이 불변인 것과 같은
 *  이유). 시드 후에는 칩으로만 바뀐다. */
function chartTimeframeSeed(
  ws: ReturnType<typeof useWorkspaceStore.getState>,
): PatternTimeframe | null {
  const id = patternLandingChart(ws);
  const tf = ws.windows.find((w) => w.id === id)?.chart?.timeframe;
  return tf && isPatternSearchableTimeframe(tf) ? tf : null;
}


function patternLandingChart(ws: ReturnType<typeof useWorkspaceStore.getState>): string | null {
  const target = activationTarget(ws);
  if (target.kind !== 'window') return null;
  const group = target.window.group;
  for (let i = ws.zOrder.length - 1; i >= 0; i -= 1) {
    const win = ws.windows.find((w) => w.id === ws.zOrder[i]);
    const tf = win?.chart?.timeframe;
    // 봉이 아직 안 정해진 창(`chart` 가 비었다)은 캘린더 봉으로 칠 수 없다 — 건너뛴다.
    if (win?.kind === 'chart' && win.group === group && tf && !isMinuteTimeframe(tf)) {
      return win.id;
    }
  }
  return null;
}

/** 저장된 `since`(날짜) → 화면의 기간 키. 저장은 날짜가 정본이고 화면은 상대 기간이라,
 *  되돌릴 때 **가장 가까운 키**를 고른다(정확히 일치하는 키가 없어도 화면이 서야 한다). */
function periodKeyFor(since: string | null): PatternConditions['period'] {
  if (!since) return 'all';
  let best: PatternConditions['period'] = 'all';
  let bestGap = Number.POSITIVE_INFINITY;
  for (const p of PERIODS) {
    const cand = sinceFor(p.key) ?? null;
    if (cand === null) continue;
    const gap = Math.abs(Number(cand) - Number(since));
    if (gap < bestGap) { bestGap = gap; best = p.key; }
  }
  return best;
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

/** 행의 신원. **렌더 `key=` 와 선택 키를 한 함수에서** 뽑는다 — 두 곳에 따로 쓰면
 *  어긋나도 아무 신호가 없다(선택이 조용히 안 걸린다).
 *  종목 코드만으로는 모자란다: `per_code>1` 이면 같은 종목이 여러 자리로 나오고,
 *  유연 검색이면 같은 자리가 길이별로 나올 수 있다. */
function rowKey(row: PatternMatchRow, matchLen: number) {
  return `${row.code}-${row.from_date}-${matchLen}`;
}

function MatchRow({
  row,
  mode,
  dist,
  onOpen,
  onMenu,
  selected = false,
  lengthBadge = null,
  maPeriods = [],
}: {
  row: PatternMatchRow;
  mode: PatternSearchMode;
  dist: { p50: number; p95: number; p99: number; p99_99: number | null };
  onOpen: (e: JumpModifiers) => void;
  /** 우클릭 · ⋯ 버튼이 함께 부른다. **우클릭만 두면 터치·키보드에서 닿지 않는다** —
   *  `StudyViewRowMenu` 가 둘을 함께 두는 것과 같은 근거. */
  onMenu: (x: number, y: number) => void;
  /** 방금 눌러서 차트가 가 있는 행인가. 「어디를 보고 있는지」를 목록이 말한다. */
  selected?: boolean;
  /** 유연 검색에서 이 매치가 나온 길이. 기준과 다를 수 있어 화면이 말해 줘야 한다. */
  lengthBadge?: number | null;
  /** 이평 프리셋의 기간들. 썸네일이 그 선을 함께 그려야 왜 매치됐는지 보인다. */
  maPeriods?: number[];
}) {
  const forward = row.forward_pct;
  return (
    // ⚠ `<button>` 이 아니라 `role="button"` 인 div 다 — 안에 ⋯ 버튼을 넣어야 하는데
    //   버튼 중첩은 HTML 위반이다(`QuoteRow` 도 같은 이유로 li + role).
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onContextMenu={(e) => { e.preventDefault(); onMenu(e.clientX, e.clientY); }}
      // ↑↓ 로 인접 행 이동 + 즉시 종목 전환. 규칙(스코프·경계에서 멈춤·click 재사용)은
      // 관심종목/히트맵/스크리너/순위와 **한 함수**를 공유한다.
      onKeyDown={(e) => {
        if (moveToAdjacentQuoteRow(e.key, e.currentTarget)) { e.preventDefault(); return; }
        // div 는 Enter/Space 를 클릭으로 바꿔 주지 않는다 — 버튼을 포기한 대가다.
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(e); }
      }}
      data-quote-row=""
      aria-current={selected ? 'true' : undefined}
      className="group grid w-full cursor-pointer grid-cols-[1fr_5.25rem_3.5rem] items-center gap-sm border-b border-grid px-md py-xs text-left outline-none hover:bg-bg-input-hover focus-visible:bg-bg-input-hover"
      style={{
        // 선택 표식은 **배경 틴트만** — 좌측 accent 바를 다시 넣지 말 것(DESIGN.md 의
        // 리스트 행 규칙, 2026-07-23 우측 레일 전체 통일). `QuoteRow` 가 기준이다.
        // 클래스(`bg-tint-selection`)가 아니라 인라인인 이유도 거기와 같다: 클래스면
        // `hover:bg-bg-input-hover` 가 이겨서 **눌린 행이 마우스를 올리는 순간 풀린 것처럼
        // 보인다**.
        background: selected ? 'var(--tint-selection)' : undefined,
      }}
    >
      <span className="flex min-w-0 items-center gap-1">
        <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-fg">{row.name || row.code}</span>
        <span className="block truncate font-data text-2xs text-fg-dimmer">
          {mode === 'history' ? formatRange(row.from_date, row.to_date) : row.code}
          {lengthBadge != null && (
            <span className="ml-1.5 rounded-full border border-border px-1 text-[9px] text-fg-dim">
              {lengthBadge}봉으로
            </span>
          )}
        </span>
        </span>
        {/* 우클릭과 **같은 메뉴**를 연다. 터치·키보드에서는 이쪽만 닿는다. */}
        <button
          type="button"
          // ⚠ 이름에 **종목명을 넣지 않는다** — 행 자체의 접근 이름과 겹쳐
          //   `getByRole('button', { name: /종목/ })` 가 둘을 잡는다. 날짜로 구별한다.
          aria-label={`${formatRange(row.from_date, row.to_date)} 매치 메뉴`}
          onClick={(e) => { e.stopPropagation(); onMenu(e.clientX, e.clientY); }}
          className="shrink-0 rounded px-1 text-2xs text-fg-dimmer opacity-0 hover:bg-bg-input-hover hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
        >
          ⋯
        </button>
      </span>
      <CandleThumb bars={row.bars} tail={row.tail} ma={row.ma} maPeriods={maPeriods} height={34} />
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
    </div>
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
  const [perCode, setPerCode] = useState(5);
  /** 기간·결과 수·유사도·거래대금·ETF. **기간만 서버로 간다** — 나머지는 받아 둔
   *  목록을 자르므로 팝오버가 개수를 미리 셀 수 있다(`patternConditions` 주석). */
  const [conditions, setConditions] = useState<PatternConditions>(DEFAULT_CONDITIONS);
  /** 결과 화면 ↔ 저장 목록. 실측 125개 규모라 팝오버가 아니라 **화면 전환**이다. */
  const [showSaves, setShowSaves] = useState(false);
  const [saveDraft, setSaveDraft] = useState<string | null>(null);
  const savesQuery = usePatternSaves();
  const createSave = useCreatePatternSave();
  const removeSave = useDeletePatternSave();
  const updateSave = useUpdatePatternSave();
  /**
   * 지금 화면이 **어느 저장을 불러온 상태인가**. 제외는 저장에 남으므로 이 값이 없으면
   * 뺄 곳이 없다(메뉴 항목이 비활성).
   *
   * 조건을 손으로 바꿔도 **지우지 않는다** — 제외는 (종목, 시작일) 쌍이라 조건과 무관하고,
   * 봉수를 하나 만졌다고 기능이 꺼지면 답답하다. **기준 종목이 바뀔 때만** 지운다:
   * 그건 다른 검색이라 그 저장의 제외를 이어받을 이유가 없다.
   */
  const [loadedSaveId, setLoadedSaveId] = useState<string | null>(null);
  /** 화면의 제외 목록. 저장의 사본이고, 뮤테이션이 디스크에 남긴다. */
  const [excluded, setExcluded] = useState<PatternExclusion[]>([]);
  /** 열린 행 메뉴의 커서 좌표 + 대상. */
  const [rowMenu, setRowMenu] = useState<
    { x: number; y: number; row: PatternMatchRow } | null
  >(null);
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
    // 봉 단위도 **같은 순간에** 시드한다 — 기준 종목과 한 묶음이다. 공장 조건이
    // timeframe 을 따라가므로(주봉은 기간이 3년) 조건 전체를 갈아 끼운다.
    const tf = chartTimeframeSeed(useWorkspaceStore.getState());
    if (tf && tf !== DEFAULT_CONDITIONS.timeframe) setConditions(defaultConditionsFor(tf));
  }, [subject, activeCode, activeInstrument]);

  useEffect(() => {
    if (!pendingSeed) return;
    const seed = consumeSeed();
    if (!seed) return;
    // 차트에서 그은 구간은 **새 검색**이라 그 종목이 새 기준이고, 저장과의 연결도 끊긴다.
    setLoadedSaveId(null);
    setExcluded([]);
    setSubject({ code: seed.code, label: seed.label ?? seed.code });
    setSeededRange({ from: seed.from, to: seed.to });
    // 그은 창의 봉 단위가 곧 그 구간의 단위다 — 주봉 5개를 일봉으로 세면 20봉대가
    // 되어 다른 질문에 답한다(#1715).
    setConditions((prev) =>
      prev.timeframe === seed.timeframe ? prev : defaultConditionsFor(seed.timeframe));
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
    conditions,
  });

  /** 방금 눌러서 차트가 가 있는 행(`rowKey`). 목록이 「어디를 보고 있는지」를 말한다. */
  const [openedKey, setOpenedKey] = useState<string | null>(null);

  const result = useMemo(
    // 구간을 건네받았으면 **그 구간이 곧 길이**라 서버가 결과를 하나만 준다.
    () => (seededRange ? (data?.results[0] ?? null) : resultForLength(data?.results, length)),
    [data, length, seededRange],
  );
  /** 헤더가 가리키는 「기준 종목 · 그 구간」. 검색이 돌아야 날짜가 정해지므로 `result`
   *  에서 나온다 — 밴드를 그었든(고정 구간) 봉수로 골랐든(최신 창) 서버가 실제로 쓴
   *  구간이 곧 이 값이다. */
  const subjectRange = useMemo<RangeTarget | null>(
    () =>
      result && data
        ? {
            code: data.code,
            name: data.name || data.code,
            from_date: result.query.from_date,
            to_date: result.query.to_date,
          }
        : null,
    [result, data],
  );

  // 새 결과가 오면 선택을 버린다. **아래의 `activeCode` 게이트로는 안 덮이는 구멍이다**:
  // `now` 모드 키의 `from_date` 는 전 종목이 같은 날이라, 주제 A 에서 누른 삼성전자의
  // 키가 주제 B 의 결과에서 **누른 적 없는** 삼성전자 행에 그대로 맞고, 차트도 거기
  // 있으니 게이트마저 통과한다.
  useEffect(() => setOpenedKey(null), [result]);

  /**
   * 화면에 그릴 행 — 유사도 하한과 개수는 **여기서** 적용된다(서버가 아니라).
   *
   * 길이 유연이면 길이별 결과가 여럿 오므로 **여유(corr − p99.99)로 정규화해** 합친다.
   * 원점수로 섞으면 배경 분포가 높은 짧은 길이가 목록을 도배한다(실측).
   */
  /** 제외 키 집합 — 렌더가 매 행마다 `Set.has` 한 번만 하도록. */
  const excludedKeys = useMemo(
    () => new Set(excluded.map((e) => exclusionKey(e))),
    [excluded],
  );
  const shown = useMemo(() => {
    if (conditions.flexBars > 0 && data && data.results.length > 1) {
      // 병합 경로도 **자르기 전에** 제외를 건다(`visibleRows` 와 같은 순서).
      // ⚠ `isExcludedRow` 를 써야 한다 — 자리 키만 보면 **종목 전체 제외가 안 걸린다**.
      //   공장값이 ±2봉이라 이 경로가 기본이고, 그래서 브라우저에서 바로 드러났다.
      return mergeByHeadroom(data.results)
        .filter((m) => m.row.corr >= conditions.simFloor && !isExcludedRow(m.row, excludedKeys))
        .slice(0, conditions.count);
    }
    if (!result) return [];
    return visibleRows(result.matches, conditions, excludedKeys).map((row) => ({
      row, length: result.length, headroom: row.corr - (result.dist.p99_99 ?? result.dist.p99),
    }));
  }, [data, result, conditions, excludedKeys]);
  const summary = useMemo(() => (result ? matchSummary(result.matches) : null), [result]);

  /**
   * 저장 불러오기 — 드로어의 **세 번째 시드 경로**다(패널 열림 · measure 시드 다음).
   *
   * 기준을 덮어쓴다. PR #1692 의 "기준은 화면을 추적하지 않는다" 와 충돌하지 않는 이유는
   * 이것이 **명시적 행위**라서다 — 추적이 아니라 사용자가 고른 교체다.
   *
   * 순서가 있다: 기준·구간을 먼저 세우고 조건을 마지막에 넣는다. 조건이 먼저 들어가면
   * 그 사이 렌더에서 **옛 기준 + 새 조건**으로 한 번 조회가 나간다.
   */
  const loadSave = useCallback((save: PatternSave) => {
    setLoadedSaveId(save.id);
    setExcluded(save.excluded ?? []);

    setSubject({ code: save.code, label: save.stock_name || save.code });
    if (save.window.kind === 'fixed' && save.window.from_date && save.window.to_date) {
      setSeededRange({ from: save.window.from_date, to: save.window.to_date });
    } else {
      setSeededRange(null);
      if (save.window.bars) setLength(save.window.bars);
    }
    setMode(save.conditions.mode);
    setWithVolume(save.conditions.volume_weight > 0);
    setPerCode(save.conditions.per_code);
    setConditions({
      // `since` 는 날짜로 저장되지만 화면은 기간 키를 쓴다 — 가장 가까운 키로 되돌린다.
      period: periodKeyFor(save.conditions.since),
      count: save.conditions.count,
      simFloor: save.conditions.sim_floor,
      minTvEok: save.conditions.min_tv_eok,
      excludeEtf: save.conditions.exclude_etf,
      noOverlap: save.conditions.no_overlap,
      // ★ 부재(`null`)는 **「그 축이 없던 시절의 저장」**이지 「끄기를 골랐다」가 아니다.
      //   공장값을 쓰면 새로 생긴 조건이 옛 저장에도 자동으로 적용된다 — 일부러 끈
      //   저장은 값이 담겨 있으므로 그대로 복원된다.
      flexBars: save.conditions.flex_bars ?? DEFAULT_CONDITIONS.flexBars,
      maPreset: save.conditions.ma_preset ?? DEFAULT_CONDITIONS.maPreset,
    });
    setShowSaves(false);
  }, []);

  /** 종목 + **그 날의 구간**으로 차트를 옮긴다. 매치 행과 헤더의 기준 구간이 이 한
   *  경로를 공유한다 — 아래 순서가 계약이라 두 벌로 두면 조용히 갈린다. */
  const openRange = useCallback(
    (target: RangeTarget, e: JumpModifiers, timeframe: PatternTimeframe) => {
      // 순서가 계약이다(`openSavedRangeInLive` 와 동일): 종목 교체가 "종목이 바뀌면
      // 저장 구간 해제" 트리거를 품고 있어, focus 를 먼저 세우면 그 자리에서 지워진다.
      const ws = useWorkspaceStore.getState();
      const landing = patternLandingChart(ws);
      jump(target.code, target.name || target.code, e);
      // 새 탭은 이 창을 건드리지 않으므로 구간 슬롯도 세우지 않는다.
      if (wantsNewTab(e)) return;
      // 착지 **차트 창**을 일봉으로. 패턴 구간은 일봉이라 분봉 창에 꽂으면 그 날의
      // 분봉을 요구하게 되고, 오래된 날짜면 디스크에 없어 화면이 통째로 빈다.
      if (landing) {
        ws.setChartTimeframe(landing, timeframe);
        // ★ 그 구간의 캔들을 **먼저 불러와야** 한다. `studyDailyViewport` 는 이미 로드된
        //   캔들 안에서 구간을 찾고, 없으면 최신 봉으로 폴백한다 — 저장뷰는 사용자가
        //   이미 본 구간이라 문제가 없었지만 패턴 매치는 **한 번도 안 본 과거**다.
        //   실측: 2018년 매치를 눌러도 차트가 2025-09 에 머물렀다.
        //   일봉은 캔들 수가 늘면 초기 뷰포트를 **다시 적용**하므로(LiveChartRoot 의
        //   `lastAppliedCountRef` 주석) 범위만 늘리면 착지는 기존 기계가 한다.
        ws.extendChartHistoricalRange(landing, subtractDaysKst(target.from_date, CONTEXT_DAYS));
      }
      focusSavedRange(patternRangeFocus(target, timeframe));
    },
    [jump, focusSavedRange],
  );

  /** 저장과의 연결을 끊는다 — **다른 검색이 됐을 때**만 부른다.
   *
   *  ⚠ `subject` 변경을 이펙트로 감시하면 안 된다. `loadSave` 가 기준을 덮어쓰므로
   *  **불러온 바로 그 순간** 이펙트가 돌아 방금 세운 연결을 지운다(실제로 그렇게 짰다가
   *  잡았다). 그래서 「사용자가 기준을 바꾼」 경로에서만 명시적으로 부른다.
   */
  const detachSave = useCallback(() => {
    setLoadedSaveId(null);
    setExcluded([]);
  }, []);

  /** 저장의 현재 payload — 제외를 갱신할 때 통째로 다시 보낸다(`PUT` 이 전체 교체다). */
  const savedById = useMemo(
    () => new Map((savesQuery.data?.saves ?? []).map((sv) => [sv.id, sv])),
    [savesQuery.data],
  );

  /** 제외 목록을 바꾸고 **디스크에도 남긴다**. 화면은 지역 상태가 즉시 반영한다. */
  const commitExcluded = useCallback((next: PatternExclusion[]) => {
    setExcluded(next);
    const save = loadedSaveId ? savedById.get(loadedSaveId) : null;
    if (!save) return;   // 저장을 안 불러온 검색이면 화면 안에서만 산다
    const { id, created_at_ms, updated_at_ms, ...body } = save;
    void created_at_ms; void updated_at_ms;
    updateSave.mutate({ id, body: { ...body, excluded: next } });
  }, [loadedSaveId, savedById, updateSave]);

  const onOpen = useCallback(
    (row: PatternMatchRow, key: string, e: JumpModifiers) => {
      // 새 탭은 **이 창의 차트를 옮기지 않는다** — 그러면 「여기를 보고 있다」도 거짓이라
      // 표식을 세우지 않는다. `now` 분기가 아래에서 곧장 return 하므로 가드는 맨 위다.
      if (!wantsNewTab(e)) setOpenedKey(key);
      // 지금 매치는 종목만 바꾼다 — 그 종목의 '지금' 이 곧 매치 구간이다.
      if (mode === 'now') {
        jump(row.code, row.name || row.code, e);
        return;
      }
      openRange(row, e, data?.timeframe ?? 'D');
    },
    [jump, openRange, mode],
  );

  return (
    <RailDrawer id="right-rail-pattern-panel" testId="pattern-drawer" ariaLabel="봉 패턴 검색">
      <RailDrawerHeader title="패턴" />

      {showSaves ? (
        <PatternSavesView
          saves={savesQuery.data?.saves ?? []}
          onPick={loadSave}
          onDelete={(save) => removeSave.mutate(save.id)}
          onBack={() => setShowSaves(false)}
        />
      ) : (
      <>
      <div className="flex flex-col gap-sm border-b border-border px-md pb-sm">
        {/* 기준 자체가 이동 대상이다 — 매치를 몇 개 열어 본 뒤 «내가 그은 구간» 으로
            돌아오려면 지금까지는 밴드를 다시 긋는 수밖에 없었다. 매치 행과 **같은
            경로**(`openRange`)를 태우므로 착지 규칙이 갈리지 않는다. */}
        <button
          type="button"
          onClick={(e) => subjectRange && openRange(subjectRange, e, data?.timeframe ?? 'D')}
          disabled={!subjectRange}
          aria-label={
            subjectRange
              ? `${subjectRange.name} ${formatRange(subjectRange.from_date, subjectRange.to_date)} 구간으로 차트 이동`
              : undefined
          }
          className="-mx-1 flex items-baseline justify-between gap-sm rounded px-1 py-[2px] text-left hover:bg-bg-input-hover disabled:cursor-default disabled:hover:bg-transparent"
        >
          <span className="truncate text-sm font-semibold text-fg">
            {data?.name || subject?.label || '종목 없음'}
          </span>
          <span className="shrink-0 font-data text-2xs text-fg-dimmer">
            {result ? formatRange(result.query.from_date, result.query.to_date) : ''}
          </span>
        </button>

        <div className="flex items-center gap-xs">
          <button
            type="button"
            onClick={() =>
              setSaveDraft(
                suggestPatternSaveName({
                  stockName: subject?.label ?? activeCode ?? '',
                  window: seededRange
                    ? { kind: 'fixed', from_date: seededRange.from, to_date: seededRange.to }
                    : { kind: 'recent', bars: length },
                  withVolume,
                }),
              )
            }
            disabled={!subject}
            className="rounded border border-border px-2 py-[3px] text-2xs text-fg-dim hover:bg-bg-input-hover hover:text-fg disabled:opacity-40"
          >
            저장
          </button>
          <button
            type="button"
            onClick={() => setShowSaves(true)}
            className="rounded border border-border px-2 py-[3px] text-2xs text-fg-dim hover:bg-bg-input-hover hover:text-fg"
          >
            저장한 검색
            <span className="ml-1 opacity-70">{savesQuery.data?.saves.length ?? 0}</span>
          </button>
        </div>

        {saveDraft !== null && (
          <form
            className="flex flex-col gap-xs rounded border border-border-strong bg-bg-subtle p-sm"
            onSubmit={(e) => {
              e.preventDefault();
              if (!subject) return;
              const name = saveDraft.trim();
              if (!name) return;
              createSave.mutate({
                name,
                code: subject.code,
                stock_name: subject.label,
                window: seededRange
                  ? { kind: 'fixed', bars: null, from_date: seededRange.from, to_date: seededRange.to }
                  : { kind: 'recent', bars: length, from_date: null, to_date: null },
                conditions: {
                  mode,
                  since: sinceFor(conditions.period) ?? null,
                  count: conditions.count,
                  sim_floor: conditions.simFloor,
                  min_tv_eok: conditions.minTvEok,
                  exclude_etf: conditions.excludeEtf,
                  no_overlap: conditions.noOverlap,
                  per_code: perCode,
                  volume_weight: withVolume ? VOLUME_WEIGHT_ON : 0,
                  ma_preset: conditions.maPreset,
                  flex_bars: conditions.flexBars,
                },
                // 새 저장은 화면의 제외를 그대로 가져간다 — 저장 전에 뺀 것이 있으면
                // 그것까지가 「이 검색」이다.
                excluded,
              });
              setSaveDraft(null);
            }}
          >
            <label className="text-2xs text-fg-dim" htmlFor="pattern-save-name">
              이 검색의 이름
            </label>
            <input
              id="pattern-save-name"
              autoFocus
              value={saveDraft}
              onChange={(e) => setSaveDraft(e.target.value)}
              className="rounded border border-border bg-bg-input px-2 py-1 text-xs text-fg"
            />
            <div className="flex justify-end gap-xs">
              <button
                type="button"
                onClick={() => setSaveDraft(null)}
                className="rounded border border-border px-2 py-[3px] text-2xs text-fg-dim hover:bg-bg-input-hover"
              >
                취소
              </button>
              <button
                type="submit"
                className="rounded border border-accent bg-tint-selection px-2 py-[3px] text-2xs text-accent"
              >
                저장
              </button>
            </div>
          </form>
        )}

        {activeCode && subject && activeCode !== subject.code && (
          <button
            type="button"
            onClick={() => {
              detachSave();
              setSubject({ code: activeCode, label: activeInstrument?.label ?? activeCode });
            }}
            className="self-start rounded border border-border px-2 py-[3px] text-2xs text-fg-dim hover:bg-bg-input-hover hover:text-fg"
          >
            기준을 «{activeInstrument?.label ?? activeCode}» 로 바꾸기
          </button>
        )}

        {result && (
          <CandleThumb
            bars={result.query.bars}
            ma={result.query.ma}
            maPeriods={result.ma_periods}
            height={56}
          />
        )}

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
          <PatternConditionChips
            conditions={conditions}
            onChange={setConditions}
            rows={result.matches}
            p9999={result.dist.p99_99}
            excluded={excluded}
            onRestore={(e) => commitExcluded(
              excluded.filter((x) => exclusionKey(x) !== exclusionKey(e)),
            )}
            onRestoreAll={() => commitExcluded([])}
          />
          <div className="px-md pb-xs pt-sm font-data text-2xs text-fg-dimmer">
            {mode === 'now'
              ? `${result.universe.toLocaleString()}종목 비교 · ${Math.round(result.elapsed_ms)}ms`
              : `${result.dist.sample.toLocaleString()}개 구간 중 ${shown.length}개 · ${Math.round(result.elapsed_ms)}ms`}
          </div>
          <RailDrawerBody quoteNav>
            {shown.length === 0 ? (
              <RailState>
                {conditions.simFloor > 0
                  ? `유사도 ${conditions.simFloor.toFixed(2)} 이상인 구간이 없다 — 하한을 낮추거나 기간을 넓혀 보라.`
                  : conditions.period !== 'all'
                    ? '이 기간에 닮은 구간이 없다 — 기간을 넓혀 보라.'
                    : '조건에 맞는 매치가 없다.'}
              </RailState>
            ) : (
              shown.map(({ row, length: matchLen }) => {
                const key = rowKey(row, matchLen);
                return (
                <MatchRow
                  key={key}
                  row={row}
                  mode={mode}
                  dist={result.dist}
                  // **저장값이 아니라 실효 조건을 그린다** — 사용자가 목록 밖에서(헤더 검색·
                  // 관심종목) 종목을 바꾸면 차트는 이미 딴 데 있으므로 표식이 거짓말이 된다.
                  selected={openedKey === key && row.code === activeCode}
                  onOpen={(e) => onOpen(row, key, e)}
                  onMenu={(x, y) => setRowMenu({ x, y, row })}
                  // 유연 검색에서만 붙는다 — 7봉을 그었는데 10봉 매치가 나오면
                  // 사용자가 그 이유를 알아야 한다.
                  lengthBadge={conditions.flexBars > 0 ? matchLen : null}
                  maPeriods={result.ma_periods}
                />
                );
              })
            )}
          </RailDrawerBody>
          {rowMenu && (
            <PatternMatchRowMenu
              x={rowMenu.x}
              y={rowMenu.y}
              label={`${rowMenu.row.name || rowMenu.row.code} ${formatRange(rowMenu.row.from_date, rowMenu.row.to_date)}`}
              stockName={rowMenu.row.name || rowMenu.row.code}
              onExcludeRange={() => commitExcluded([
                ...excluded,
                {
                  code: rowMenu.row.code,
                  from_date: rowMenu.row.from_date,
                  stock_name: rowMenu.row.name || rowMenu.row.code,
                },
              ])}
              onExcludeCode={() => commitExcluded(withWholeCodeExcluded(excluded, {
                code: rowMenu.row.code,
                from_date: null,
                stock_name: rowMenu.row.name || rowMenu.row.code,
              }))}
              onClose={() => setRowMenu(null)}
            />
          )}
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
      </>
      )}
    </RailDrawer>
  );
}
