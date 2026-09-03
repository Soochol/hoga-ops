import type {
  PatternExclusion, PatternMaPreset, PatternMatchRow, PatternTimeframe,
} from '../api/screener';

/**
 * 패턴 검색의 조건들 (ADR-0166).
 *
 * ## 어느 조건이 어디서 걸리는가 — 이 파일의 요점
 *
 * **기간은 후보 모집단을 바꾸고, 유사도 하한과 결과 수는 이미 뽑은 결과를 자른다.**
 *
 * 그래서 기간만 서버로 가고(재검색), 나머지 둘은 받아 둔 목록을 로컬에서 거른다.
 * 이 구분이 흐려지면 「기간을 좁혔더니 결과가 5개뿐」 같은 오답이 나온다 — 그건
 * 「그 기간 안에서 상위 40개」가 아니라 「전체 상위 40개 중 그 기간에 든 것」이라서다.
 * 실측으로 확인했다: 2025-09 이후로 좁혀도 서버는 40행을 꽉 채운다.
 *
 * 로컬 조건이 팝오버에 **개수 미리보기**를 띄울 수 있는 것도 이 분리 덕이다 —
 * 서버를 다시 부르지 않으므로 즉시 셀 수 있다.
 */

/** 기간 후보. `null` = 전체. 하한을 1년으로 두는 이유는 그보다 짧으면 후보창이 너무
 *  적어(수천 종목 × 수십 봉) 매치 품질이 무너지기 때문이다. */
export const PERIODS = [
  { key: 'all', label: '전체 기간', years: null },
  { key: '5y', label: '최근 5년', years: 5 },
  { key: '4y', label: '최근 4년', years: 4 },
  { key: '3y', label: '최근 3년', years: 3 },
  { key: '2y', label: '최근 2년', years: 2 },
  { key: '1y', label: '최근 1년', years: 1 },
] as const;

export type PeriodKey = (typeof PERIODS)[number]['key'];

/** 유사도 하한 후보. 절대값이지만 팝오버가 **이 검색의 분포와 남는 개수**를 함께
 *  보여주므로 종목마다 다른 뜻을 화면이 메운다. */
export const SIM_FLOORS = [0, 0.88, 0.9, 0.93, 0.95] as const;

/** 결과 수 후보. 서버가 받아 오는 양이자 화면에 그리는 상한이다. */
export const RESULT_COUNTS = [20, 40, 100] as const;

/** 길이 유연 폭 후보. `history` 는 길이당 ~0.6s 라 ±2 가 3초다 — 그 위는 열지 않는다. */
export const FLEX_STEPS = [0, 1, 2] as const;

/** 봉 단위 후보. 값은 `hoga/api/models.py::PatternTimeframe` 의 손 미러다(ADR-0004).
 *
 *  **서버 조건**이다 — 코퍼스 자체가 갈리므로 받아 둔 결과를 자르는 것으로 흉내낼 수
 *  없다(`maPreset` 과 같은 부류). 그래서 로컬 조건이 아니라 여기 있다. */
export const TIMEFRAMES = [
  { key: 'D' as const, label: '일봉', note: '하루 한 봉' },
  { key: 'W' as const, label: '주봉', note: '한 주 한 봉 — 더 긴 흐름을 본다' },
];

/** 수익률 지평(봉). **서버 `forward_days` 의 짝인데 코드는 「봉」을 센다** — 이름이
 *  「일」이라 일봉에서만 우연히 맞았다. 주봉에서 20 을 그대로 보내면 20주(≈5개월)가
 *  되어 후보가 그만큼 잘리고 수익률도 5개월 뒤가 된다.
 *
 *  주봉 8봉 ≈ 2개월로 일봉 20일(≈1개월)과 같은 결의 「이후」다. */
export function forwardBarsFor(timeframe: PatternTimeframe): number {
  return timeframe === 'W' ? 8 : 20;
}

/** 이평 프리셋 후보. **자유 조합을 열지 않는다** — 조합마다 답이 크게 갈리지만(5·20 대비
 *  20·60 은 상위 20 중 3개만 겹친다) 그건 판별력이 아니라 **질문이 바뀌는 것**이고,
 *  체크박스는 그 사실을 화면에서 말해 주지 못한다. 이름이 무엇을 찾는지 말하게 둔다.
 *  값은 `hoga/api/models.py::PatternMaPreset` 의 손 미러다(ADR-0004). */
export const MA_PRESETS = [
  { key: 'off' as const, label: '이평 끄기', note: '캔들 모양만 본다' },
  { key: 'short' as const, label: '단기 5·20', note: '5·20 이평을 낀 자리까지 맞춘다' },
  { key: 'mid' as const, label: '중기 20·60', note: '중기 추세 위의 자리를 맞춘다' },
];

/** 이평 라벨의 **단위**. 프리셋 키는 wire 값이라 못 바꾸지만, 「5·20」이 무엇의 5·20
 *  인지는 timeframe 이 정한다 — 주봉에서는 5주·20주다. 차트도 봉 단위로 그리므로
 *  (`paneSpecsForTimeframe('D') === ('W')`) 매칭과 화면이 어긋나지는 않는다. */
export function maUnitLabel(timeframe: PatternTimeframe): string {
  return timeframe === 'W' ? '주' : '일';
}

/** 제외 키 — **「종목 + 시작일」**이고 길이는 들어가지 않는다.
 *
 *  유연 검색이면 같은 자리가 길이별로 여러 행이 되므로(실측 500행 중 96건), 길이까지
 *  맞춰 빼면 하나만 사라지고 다른 길이가 남아 「지웠는데 또 나온다」가 된다.
 *
 *  `from_date` 가 없으면 **그 종목 전부**를 뜻하는 `code:*` 가 된다.
 *
 *  ⚠ 렌더·저장·비교가 **이 함수 하나**를 쓴다. 두 곳에서 따로 만들면 어긋나도 아무
 *  신호가 없다(제외가 조용히 안 걸린다). */
export function exclusionKey(row: { code: string; from_date?: string | null }): string {
  return `${row.code}:${row.from_date ?? '*'}`;
}

/** 이 행이 제외에 걸리는가 — **자리 키와 종목 키를 둘 다** 본다.
 *
 *  종목 전체 제외(`code:*`)는 그 종목의 모든 날짜를 덮으므로, 자리 키만 검사하면
 *  「종목을 통째로 뺐는데 다른 날짜가 남는다」가 된다. */
export function isExcludedRow(
  row: { code: string; from_date: string },
  excludedKeys: ReadonlySet<string>,
): boolean {
  return excludedKeys.has(`${row.code}:*`) || excludedKeys.has(exclusionKey(row));
}

/** 「이 종목 전부」를 제외 목록에 넣는다 — **그 종목의 자리 제외는 걷어낸다**.
 *
 *  남겨 두면 복원 목록에 같은 종목이 여러 줄로 쌓이고, 「전체」를 되돌려도 옛 자리가
 *  계속 빠진 채로 남아 「되돌렸는데 안 돌아온다」가 된다. */
export function withWholeCodeExcluded(
  list: readonly PatternExclusion[],
  entry: PatternExclusion,
): PatternExclusion[] {
  return [...list.filter((e) => e.code !== entry.code), { ...entry, from_date: null }];
}

export type PatternConditions = {
  period: PeriodKey;
  count: number;
  simFloor: number;
  minTvEok: number;
  excludeEtf: boolean;
  noOverlap: boolean;
  /** ±N봉. 0 이면 기준 길이 하나만 본다. */
  flexBars: number;
  /** 이평선을 매칭 축에 넣을지. **서버 조건**이다 — 유사도 자체가 달라지므로 받아 둔
   *  결과를 자르는 것으로는 흉내낼 수 없다. */
  maPreset: PatternMaPreset;
  /** 봉 단위. **서버 조건**이고 코퍼스 자체가 갈린다.
   *
   *  공장값은 일봉이지만 **패널을 열 때 차트에서 시드**된다(기준 종목과 같은 규칙) —
   *  주봉 차트를 보다 열면 주봉 검색이 자연스럽다. 시드 후에는 칩으로만 바뀐다:
   *  화면 차트를 계속 따라가면 매치를 눌러 차트가 바뀔 때마다 결과가 다시 계산돼
   *  두 번째 매치를 볼 수 없다(기준 종목이 불변인 것과 같은 이유). */
  timeframe: PatternTimeframe;
};

/** 기본값 — 사용자가 실제로 쓰는 조합(2026-09-02 결정, 화면 캡처로 지정).
 *
 *  **「다 보고 싶다」에서 「쓸 만한 것만 넓게」로 옮겼다.** 기간을 1년으로 좁히는 대신
 *  결과를 100개까지 받고 길이를 ±2봉으로 편다. 거래대금 50억은 그 100개가 실제로 볼
 *  만한 종목이 되게 하는 값이다 — 10억이면 목록이 거래가 거의 없는 종목으로 채워진다.
 *  이평 「단기 5·20」까지 켠 채로 시작한다.
 *
 *  ⚠ `flexBars: 2` 는 두 가지를 바꾼다. 서버가 **길이 5개를 돌리고**(`history` 실측
 *  ~3초, `now` ~100ms), 봉수 스크럽이 **로컬 전환이 아니게 된다**(유연은 길이를 하나만
 *  보내므로 — ADR-0166 결정 3 의 전제가 공장값에서 깨진다. `patternKey` 주석 참조). */
export const DEFAULT_CONDITIONS: PatternConditions = {
  period: '1y',
  count: 100,
  simFloor: 0,
  minTvEok: 50,
  excludeEtf: true,
  noOverlap: true,
  flexBars: 2,
  // **이평을 켠 채로 시작한다**(2026-09-02 사용자 결정). 「캔들이 5·20 을 끼고 있는」
  // 형세까지 맞추는 것이 이 도구의 기본 질문이 됐다 — 끄면 정배열/역배열이 우연 수준으로
  // 섞인다(실측 6~14/20 vs 20/20, ADR-0166 결정 11).
  maPreset: 'short',
  timeframe: 'D',
};

/** 그 timeframe 의 공장 조건. **시드 시점에만** 쓴다 — 칩으로 timeframe 을 바꿀 때
 *  적용하면 사용자가 고른 기간이 조용히 사라진다.
 *
 *  주봉이 3년인 이유는 후보창이 얇기 때문이다: 공장 기간 1년이면 일봉 121,920 vs
 *  주봉 **32,662** 라 분포 스트립의 p99.99 가 표본 3.3개 위에 선다(일봉은 12.2개).
 *  3년이면 141,478 / 14.1개다. */
export function defaultConditionsFor(timeframe: PatternTimeframe): PatternConditions {
  return timeframe === 'W'
    ? { ...DEFAULT_CONDITIONS, timeframe, period: '3y' }
    : { ...DEFAULT_CONDITIONS, timeframe };
}

/** 기간 → `since`(YYYYMMDD). 전체면 `undefined` — 서버가 그때 필터를 아예 안 건다. */
export function sinceFor(period: PeriodKey, today = new Date()): string | undefined {
  const spec = PERIODS.find((p) => p.key === period);
  if (!spec?.years) return undefined;
  const d = new Date(today);
  d.setFullYear(d.getFullYear() - spec.years);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 길이별 결과를 **하나의 목록으로** 합친다.
 *
 * ⚠ 원점수로 섞으면 **짧은 길이가 도배한다** — 배경 분포가 길이마다 다르기 때문이다
 * (실측 p99.99: 7봉 0.870 → 14봉 0.832). 원점수 top20 이 {7봉 7 · 8봉 8}로 쏠렸고,
 * **p99.99 대비 「여유」로 정규화**하니 {7:6 · 10:4 · 13:3 · 14:2 …}로 퍼졌다.
 *
 * 그래서 정렬 키가 `corr - p99.99` 다. 화면에 그리는 값은 여전히 `corr` 이고, 어느
 * 길이에서 나온 매치인지는 행의 길이 뱃지가 말한다.
 */
export function mergeByHeadroom(
  results: readonly { length: number; dist: { p99_99: number | null; p99: number }; matches: readonly PatternMatchRow[] }[],
): { row: PatternMatchRow; length: number; headroom: number }[] {
  const merged = results.flatMap((r) => {
    const floor = r.dist.p99_99 ?? r.dist.p99;
    return r.matches.map((row) => ({ row, length: r.length, headroom: row.corr - floor }));
  });
  merged.sort((a, b) => b.headroom - a.headroom);
  return merged;
}

/** 유사도 하한을 적용한 행들. **결과 수는 여기서 자르지 않는다** — 팝오버가 "남는 수"
 *  를 셀 때와 목록을 그릴 때가 같은 함수를 써야 미리보기가 거짓말을 하지 않는다. */
export function passingFloor(rows: readonly PatternMatchRow[], simFloor: number): PatternMatchRow[] {
  return rows.filter((r) => r.corr >= simFloor);
}

/** 화면에 그릴 행 — 하한과 **제외**를 적용하고 개수로 자른다.
 *
 *  ★ 제외는 **자르기 전에** 건다. 뒤에 걸면 100개를 자른 뒤 빼서 95개가 되지만, 앞에서
 *  걸면 다음 후보가 올라와 100개가 유지된다 — 「빼면 그만큼 다른 게 보인다」가 사용자가
 *  기대하는 쪽이고, 서버 재검색 없이 그렇게 된다. */
export function visibleRows(
  rows: readonly PatternMatchRow[],
  { simFloor, count }: { simFloor: number; count: number },
  excludedKeys?: ReadonlySet<string>,
): PatternMatchRow[] {
  const passing = passingFloor(rows, simFloor);
  const kept = excludedKeys?.size
    ? passing.filter((r) => !isExcludedRow(r, excludedKeys))
    : passing;
  return kept.slice(0, count);
}
