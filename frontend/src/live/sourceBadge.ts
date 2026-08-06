import { SOURCE_CAPABILITIES } from '../api/sourceCapabilities';
import type { RangeSegment, SourceName } from '../api/types';

/**
 * 차트가 **어느 소스로 그려졌는지** 한 줄로 (2026-08-07 소스 선호 옵션 폐지의 후반부).
 *
 * 옵션을 없애면서 사용자에게서 **고를 권리**를 뺏었다. 그 대가로 **알 권리**를 준다 —
 * 예전엔 고를 수 있지만 결과를 몰랐고, 이제는 못 고르지만 무엇을 보고 있는지 안다.
 *
 * 특히 완결성 등급 정렬을 폐지했기 때문에 이 배지가 필요하다: 사다리 1순위(키움)가
 * 그날 부분 결손이어도 그대로 이긴다(실측 2026-08-06: 키움 54분 vs hogaplay 401분인
 * 날). 자동으로 소스를 바꾸는 대신 **바뀌지 않았다는 사실**을 보여 준다.
 *
 * ⚠ **기본 소스일 땐 침묵한다.** 항상 띄우면 정보가 아니라 배경이 된다 — 사용자가
 * 알아야 할 것은 "평소와 다른 소스로 그려졌다" 뿐이다.
 */

/** 사다리 1순위. 이것만으로 그려졌으면 배지를 띄우지 않는다. */
const PRIMARY_SOURCE: SourceName = 'kiwoom_live';

/**
 * 소스 문자열 → 표기 라벨. **런타임 문자열 인덱싱이라 폴백이 필수다.**
 *
 * 이 폴백은 예전 `SourceChip` 이 지녔다가 그 컴포넌트와 함께 지워졌는데(#975),
 * `SOURCE_CAPABILITIES` 주석이 "백엔드 문자열로 인덱싱하는 소비자를 다시 만든다면
 * 폴백부터 되살릴 것" 이라고 남겨 뒀다. 이 모듈이 바로 그 소비자다 — 백엔드가
 * `SourceName` 에 없는 값을 보내면 폴백 없이는 `undefined.label` 로 터지고, 그 크래시가
 * 차트 전체를 언마운트시킨 전례가 있다(리뷰 C2).
 */
function sourceLabel(source: string): string {
  return SOURCE_CAPABILITIES[source as SourceName]?.label ?? source;
}

/**
 * 배지 문구. 기본 소스만 쓰였거나 판단할 게 없으면 `null`.
 *
 * 여러 소스가 섞이면(팬으로 과거 구간이 붙는 흔한 경우) **기본이 아닌 것들만** 나열한다
 * — 사용자가 눈여겨볼 대상이 그쪽이고, 전부 나열하면 줄이 길어져 차트를 가린다.
 */
export function deriveSourceBadge(segments: readonly RangeSegment[] | undefined): string | null {
  if (!segments || segments.length === 0) return null;
  const others = [...new Set(
    segments.map((s) => s.source).filter((s): s is SourceName => !!s && s !== PRIMARY_SOURCE),
  )];
  if (others.length === 0) return null;
  return others.map(sourceLabel).join(' · ');
}
