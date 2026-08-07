import { SOURCE_CAPABILITIES } from '../api/sourceCapabilities';
import type { RangeSegment, SourceName } from '../api/types';

/**
 * 차트가 **무엇으로 그려졌는지** 한 줄로 — 소스와 결손.
 *
 * 소스 선호 옵션을 없애면서 사용자에게서 **고를 권리**를 뺏었고, 그 대가로 **알 권리**를
 * 줬다. 그런데 초판은 소스 이름만 냈고, 그 결과 `sources.py` 가 약속한 "승자와 **완결
 * 상태**를 표시한다" 의 **절반이 비어 있었다**.
 *
 * 그 절반이 실제 사고를 조용히 통과시켰다 — 2026-08-06 000660 은 키움이 정규장 6.5시간 중
 * **5시간 31분**을 놓친 채 그려졌는데, 사다리 1순위였으므로 배지가 침묵했다. 사용자가
 * 화면을 보고 직접 발견할 때까지 시스템은 아무 말도 하지 않았다.
 *
 * ## 트리거가 둘이다 (서로 독립)
 *
 * 1. **비기본 소스** — 평소와 다른 소스로 그려졌다
 * 2. **결손 ≥ {@link GAP_FLOOR_MS}** — 소스가 무엇이든 구멍이 크다
 *
 * 초판의 "기본 소스일 땐 침묵" 규율은 (1)에만 해당한다. 완결성은 소스 정체성과 **직교**
 * 하므로 키움이 이겼어도 크게 비었으면 말해야 한다.
 *
 * ## 왜 5분인가 — 임계는 실측으로 정했다
 *
 * 결손은 **날짜 단위로 뭉친다**(종목별 산발이 아니라 그날 캡처 세션 사고). 2026-08-07
 * 실측, kiwoom_live 존재 기간 13거래일:
 *
 * - 건강일(완전 ≥90%) 5일: 5분 임계 점등률 **0.98%** — 사실상 안 뜬다
 * - 사고일 8일: 점등률 **87.8%** — 그날 거의 전 종목이 뜬다
 *
 * 즉 5분은 "상시 점등 배경 소음" 과 "사고 검출" 사이를 정확히 가른다. 더 낮추면 건강일
 * 잡음이 늘고, 더 높이면 30분~2시간대 사고(전체의 24%)를 놓친다.
 *
 * ## 자동으로 소스를 바꾸지 않는 이유
 *
 * "결손 있으면 더 완전한 소스로 갈아탄다" 는 검토했고 **기각했다**. `is_partial` 은
 * 이진값이라 3분 구멍과 4시간 구멍을 구분하지 못한다 — 실측상 hogaplay 가 "결손" 으로
 * 찍힌 992칸의 중앙 결손은 **정규장의 2.9%** 이고, 그 중 26.8%(5분 이하)에서는 hogaplay 가
 * **100%** 더 촘촘하다(중앙 24,005행 vs 2,402행). 등급만 보고 뒤집으면 21,603행을 버린다.
 * 그래서 **고르지 않고 보여 준다**(ADR-0129 "조용히 메꾸지 않고 드러낸다").
 */

/** 사다리 1순위. 이것만으로 그려졌으면 소스 트리거는 침묵한다. */
const PRIMARY_SOURCE: SourceName = 'kiwoom_live';

/** 결손 트리거 하한 5분. 근거는 모듈 주석의 건강일/사고일 점등률 실측. */
export const GAP_FLOOR_MS = 5 * 60 * 1000;

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

/** 결손 표기 — 분 단위 반올림. 60분 이상은 "N시간 M분". */
function formatGap(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${totalMin}분`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}시간` : `${h}시간 ${m}분`;
}

/**
 * 세그먼트들의 결손 합계(ms). **아는 값만 더한다.**
 *
 * `gap_ms` 가 `null`/`undefined` 인 세그먼트(구 백엔드·판독 실패)는 **0 으로 치지 않고
 * 건너뛴다** — 모르는 것을 "없음" 으로 바꾸면 배지가 조용해진다. 전부 모르면 `null`.
 */
function totalGapMs(segments: readonly RangeSegment[]): number | null {
  let total = 0;
  let known = false;
  for (const s of segments) {
    if (s.gap_ms == null) continue;
    known = true;
    total += s.gap_ms;
  }
  return known ? total : null;
}

/**
 * 배지 문구. 두 트리거 중 하나도 걸리지 않으면 `null`.
 *
 * 여러 소스가 섞이면(팬으로 과거 구간이 붙는 흔한 경우) **기본이 아닌 것들만** 나열한다
 * — 사용자가 눈여겨볼 대상이 그쪽이고, 전부 나열하면 줄이 길어져 차트를 가린다.
 * 결손 때문에 떴을 때는 기본 소스 이름도 함께 낸다: 이미 배지가 떴으니 "무엇이 얼마나
 * 비었는지" 를 한 줄로 주는 편이 낫다.
 */
export function deriveSourceBadge(segments: readonly RangeSegment[] | undefined): string | null {
  if (!segments || segments.length === 0) return null;

  const others = [...new Set(
    segments.map((s) => s.source).filter((s): s is SourceName => !!s && s !== PRIMARY_SOURCE),
  )];
  const gap = totalGapMs(segments);
  const gapLit = gap !== null && gap >= GAP_FLOOR_MS;

  if (others.length === 0 && !gapLit) return null;

  const names = others.length > 0
    ? others.map(sourceLabel)
    // 결손만으로 떴다 — 어느 소스가 비었는지 밝힌다.
    : [...new Set(segments.map((s) => s.source).filter((s): s is SourceName => !!s))]
        .map(sourceLabel);

  const head = names.join(' · ');
  if (!gapLit) return head;
  const tail = `결손 ${formatGap(gap)}`;
  return head ? `${head} · ${tail}` : tail;
}
