/** 히트맵 캡처 결손 판정 (ADR-0142).
 *
 * 기준일을 **달력이 아니라 마커의 최댓값**에서 뽑는다. 히트맵 전 종목은 같은 17:00
 * 런에서 함께 적재되므로 정상이면 마커가 한 날짜로 수렴한다 — 그 최댓값보다 뒤처진
 * 종목이 곧 결손이다.
 *
 * 달력(마지막 거래일)을 기준으로 삼지 않는 이유: 장중에는 오늘 캡처가 아직 안 돌았으므로
 * 전 종목이 "미수집"이 되어 271개 경고가 뜬다. 그건 정보가 아니라 소음이다. 마커 최댓값
 * 기준이면 "다른 종목은 다 됐는데 이 종목만 안 됐다" 라는, 실제로 조치가 필요한 상태만
 * 잡힌다. 히트맵이 통째로 하루 밀리면 최댓값도 함께 밀려 0건이 되는데, 그 경우는 개별
 * 종목 문제가 아니라 런 자체의 문제라 캡처 큐/보관함이 보고할 사안이다.
 */
export interface HeatmapCaptureLag {
  /** 마커 최댓값(YYYYMMDD). 마커가 하나도 없으면 null. */
  latest: string | null;
  /** latest 보다 뒤처지거나 마커가 아예 없는 코드. latest 가 null 이면 빈 집합
   *  (기준이 없으면 누구도 뒤처졌다고 말할 수 없다). */
  lagging: Set<string>;
}

export function computeCaptureLag(
  markers: Record<string, string> | undefined,
  codes: readonly string[],
): HeatmapCaptureLag {
  const map = markers ?? {};
  let latest: string | null = null;
  for (const date of Object.values(map)) {
    if (latest === null || date > latest) latest = date;
  }
  const lagging = new Set<string>();
  if (latest !== null) {
    for (const code of codes) {
      const date = map[code];
      if (date === undefined || date < latest) lagging.add(code);
    }
  }
  return { latest, lagging };
}

/** 행 툴팁 문구. 결손 여부와 무관하게 마지막 수집일을 말해 준다. */
export function captureLagTitle(
  markers: Record<string, string> | undefined,
  code: string,
): string {
  const date = markers?.[code];
  if (date === undefined) return '수집 이력 없음';
  return `마지막 수집 ${date.slice(4, 6)}/${date.slice(6, 8)}`;
}
