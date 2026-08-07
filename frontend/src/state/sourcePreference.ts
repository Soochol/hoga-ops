/**
 * 소스 선호 — **옵션 하나로 축소됐다가(2026-08-07 오전) 옵트인으로 되살아났다(같은 날 오후).**
 *
 * 예전엔 사용자가 셋 중 하나를 골랐다(hogaplay 우선 · 실시간 WS 우선 · 완결성 우선).
 * 그 선택지가 **venue 비교를 깨뜨린다**는 것이 폐지 이유였다: hogaplay 는 KRX 만 덮으므로
 * 그것이 1순위면 KRX 만 hogaplay 로 계산되고 NXT·통합은 키움으로 계산된다 — 시장을
 * 토글하면 소스도 함께 바뀌어, 값 차이가 시장 차이인지 업스트림 차이인지 알 수 없다.
 *
 * 되살린 근거는 **폐지 근거의 사실 기반이 같은 날 뒤집혔다**는 것이다. 사다리 주석은
 * "hogaplay 0~25건/일, 죽어가는 폴백" 을 전제했는데 ADR-0142 가 hogaplay 를 271종목/일 로
 * 되돌렸다. 폐지 사유 자체는 유효하므로 **기본값이 아니라 옵트인**으로 둔다:
 * 기본은 비교 가능성, 옵션은 해상도(실측 최대 145배), 소스 배지가 무엇을 보는지 알린다.
 *
 * 저장돼 있던 옛 설정(`chart.sourcePreference.v1`)은 **읽지 않는다** — 대부분 고른 적 없는
 * 기본값이었다. 새 설정은 백엔드 `live_settings.krx_prefer_hogaplay` 에 산다(REST 우회
 * 토글과 같은 저장소라 같은 패널에서 저장 위치가 갈리지 않는다).
 */
import { useLiveSettings } from '../api/liveSettings';

/** 백엔드 `ordered_sources` 가 인식하는 유일한 옵트인 토큰. */
export const HOGAPLAY_SOURCE_PREF = 'hogaplay';

/** 기본 사다리(키움 고정)를 뜻하는 값. 백엔드는 이 토큰을 특별 취급하지 않고,
 *  `"hogaplay"` 가 아닌 모든 문자열과 똑같이 기본 사다리로 수렴시킨다. */
export const ORDERFLOW_SOURCE_PREF = 'kiwoom_live';

/** 배관에 남은 타입.
 *
 * 리터럴 유니온으로 좁히지 **않는다** — 이 값은 URL·쿼리 키의 자리를 채우는 문자열이고,
 * 백엔드가 모르는 값을 조용히 기본 사다리로 수렴시킨다(구 URL 호환). 좁히면 그 자리
 * 구조를 검증하는 테스트들이 임의 문자열을 못 쓰게 되는데, 그건 정책 의미가 아니라
 * **배관 모양**을 보는 테스트라 제약할 이유가 없다. */
export type SourcePreference = string;

/**
 * 설정에서 파생한 현재 소스 선호. **설정이 아직 로드되지 않았으면 `undefined`.**
 *
 * `undefined` 를 기본값으로 메우지 않는 것이 요점이다. 메우면 옵션을 켜 둔 사용자가
 * 콜드 마운트마다 kiwoom 키로 한 번 조회하고 곧바로 hogaplay 키로 다시 조회해서
 * **차트가 눈에 띄게 갈아끼워진다**(쿼리 키에 `source_pref` 가 들어가므로 캐시가 갈린다).
 * 호출부는 이 값이 정해질 때까지 쿼리를 비활성화한다 — 설정은 첫 로드 후 캐시되므로
 * 이 게이트는 세션당 한 번만 걸린다.
 */
export function useOrderflowSourcePref(): SourcePreference | undefined {
  const { data } = useLiveSettings();
  if (data === undefined) return undefined;
  return data.krx_prefer_hogaplay ? HOGAPLAY_SOURCE_PREF : ORDERFLOW_SOURCE_PREF;
}
