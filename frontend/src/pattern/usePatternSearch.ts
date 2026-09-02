import { useQuery } from '@tanstack/react-query';
import { searchPattern, type PatternLengthResult, type PatternSearchMode } from '../api/screener';
import { sinceFor, type PatternConditions } from './patternConditions';

/**
 * 봉 패턴 검색 훅 (ADR-0166).
 *
 * **두 모드의 대접이 다른 것이 이 훅의 요점이다** — 성능 차이가 30배라서다.
 *
 * | | 서버 | 이 훅 |
 * |---|---|---|
 * | `now` | 15ms/길이 | 봉수 **전 범위를 한 번에** 받아 스크럽이 로컬 전환이 된다 |
 * | `history` | ~420ms | 길이 하나만, 사용자가 탭을 열 때만 |
 *
 * `now` 가 길이를 묶어 받으므로 스테퍼를 움직여도 **네트워크 왕복이 없다**. 이걸
 * 길이마다 요청하게 두면 연타가 그대로 요청 폭주가 되고, 스크럽이라는 동작 자체가
 * 성립하지 않는다.
 */

/**
 * 「거래량 함께」의 비중.
 *
 * ⚠ **이 숫자를 화면에 노출하지 않는다.** 계약은 "거래량 함께" 이지 0.3 이 아니다 —
 * 값을 조정해도 화면 약속이 깨지지 않아야 한다. 슬라이더로 열지 않는 이유도 같다
 * (연속값은 쿼리 캐시 키를 폭발시킨다).
 */
export const VOLUME_WEIGHT_ON = 0.3;

/** `now` 가 한 번에 받아 두는 봉수 범위 — 서버의 `PATTERN_MAX_LENGTHS`(11) 와 같은 폭. */
export const NOW_LENGTHS = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;
export const DEFAULT_LENGTH = 7;

export type PatternFilters = {
  minTvEok: number;
  excludeEtf: boolean;
  noOverlap: boolean;
};

export const DEFAULT_FILTERS: PatternFilters = {
  minTvEok: 10,
  excludeEtf: true,
  noOverlap: true,
};

export function patternKey(
  code: string | null,
  mode: PatternSearchMode,
  length: number,
  filters: PatternFilters,
  range?: { from: string; to: string } | null,
  perCode = 1,
  volumeWeight = 0,
  conditions?: PatternConditions,
) {
  // now 는 길이를 묶어 받으므로 **키에 길이가 없다** — 스테퍼가 캐시를 무효화하면
  // 묶어 받은 의미가 사라진다.
  //
  // ⚠ **길이 유연이 켜지면 그 전제가 깨진다.** 유연은 `lengths` 를 하나만 보내므로
  //   (두 축을 곱할 수 없다 — ADR-0166 결정 10) 응답이 기준 ±N 범위뿐이고, 그 밖으로
  //   스크럽하면 재검색 없이 **결과가 빈다**. 유연일 때는 길이가 축이다.
  const scrubbed = mode === 'history' || (conditions?.flexBars ?? 0) > 0 ? length : 'all';
  return [
    'pattern-search',
    code,
    mode,
    scrubbed,
    filters.minTvEok,
    filters.excludeEtf,
    filters.noOverlap,
    // 차트에서 건네받은 구간은 **길이를 대신하는 축**이라 키에 들어간다.
    range ? `${range.from}-${range.to}` : null,
    perCode,
    volumeWeight,
    // ⚠ **서버로 가는 조건만** 키에 든다. 유사도 하한은 받아 둔 목록을 자르는 것이라
    //   키에 넣으면 값을 바꿀 때마다 불필요한 재검색이 난다.
    conditions ? sinceFor(conditions.period) ?? 'all' : null,
    conditions?.minTvEok ?? null,
    conditions?.excludeEtf ?? null,
    conditions?.noOverlap ?? null,
    conditions?.count ?? null,
    conditions?.flexBars ?? null,
    // 이평은 **서버 조건**이다 — 유사도 자체가 달라지므로 키에 든다.
    conditions?.maPreset ?? null,
  ] as const;
}

export function usePatternSearch({
  code,
  mode,
  length,
  filters,
  range = null,
  perCode = 1,
  volumeWeight = 0,
  conditions,
  enabled = true,
}: {
  code: string | null;
  mode: PatternSearchMode;
  length: number;
  filters: PatternFilters;
  /** 차트에서 그은 구간. 주면 **그 구간이 곧 길이**이고 `lengths` 는 무시된다. */
  range?: { from: string; to: string } | null;
  /** `history` 전용 — 한 종목에서 남길 매치 수. */
  perCode?: number;
  /** 거래량 축 비중(0~1). 0 이면 서버가 거래량 계산을 아예 돌지 않는다. */
  volumeWeight?: number;
  /** 조건 묶음. **유사도 하한을 뺀 나머지**가 서버로 간다. */
  conditions?: PatternConditions;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: patternKey(code, mode, length, filters, range, perCode, volumeWeight, conditions),
    enabled: enabled && !!code,
    // 코퍼스는 하루 한 번 갱신된다 — 패널을 여닫을 때마다 다시 계산할 이유가 없다.
    staleTime: 5 * 60_000,
    queryFn: () =>
      searchPattern({
        code: code as string,
        mode,
        // 구간을 주면 서버가 길이를 그 구간에서 뽑는다 — `lengths` 는 검증만 통과하면 된다.
        // 길이 유연은 **고른 봉수 하나**를 편다 — 봉수 스크럽(`NOW_LENGTHS`)과 곱하면
        // 55회가 돌고 기준과 무관한 길이가 상위에 온다.
        lengths:
          range || mode === 'history' || (conditions?.flexBars ?? 0) > 0
            ? [length]
            : [...NOW_LENGTHS],
        ...(range ? { from: range.from, to: range.to } : {}),
        top: conditions?.count ?? 20,
        ...(conditions ? { since: sinceFor(conditions.period) } : {}),
        min_tv_eok: conditions?.minTvEok ?? filters.minTvEok,
        exclude_etf: conditions?.excludeEtf ?? filters.excludeEtf,
        no_overlap: conditions?.noOverlap ?? filters.noOverlap,
        flex_bars: conditions?.flexBars ?? 0,
        ma_preset: conditions?.maPreset ?? 'off',
        per_code: perCode,
        volume_weight: volumeWeight,
      }),
  });
}

/** 묶어 받은 결과에서 현재 봉수의 것을 고른다. 없으면 null(그 길이의 창이 계열보다 길다). */
export function resultForLength(
  results: PatternLengthResult[] | undefined,
  length: number,
): PatternLengthResult | null {
  if (!results?.length) return null;
  return results.find((r) => r.length === length) ?? null;
}
