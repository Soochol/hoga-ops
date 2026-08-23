import type { RangeMissingDate } from '../api/types';
import { LIVE_VENUE_LABELS, type LiveVenueOption } from '../state/liveVenue';

/**
 * 호가 파생 pane 이 빈 **이유**를 한 줄로 (#1133).
 *
 * 이게 없으면 사용자는 빈 pane 을 **고장으로 읽는다.** 실제로는 그 시장·그 날의 호가
 * 기록이 없을 뿐이고, 그건 소급해서 만들 수 없는 정상 상태다 — 호가 스냅샷은 벤더가
 * 과거를 주지 않아 "그 순간 받아 두지 않으면 영원히 없는" 데이터이기 때문이다.
 * (캔들은 벤더 REST 에서 언제든 다시 받으므로 같은 화면에서 **캔들만 정상**으로
 * 그려진다 — 그 비대칭이 특히 고장처럼 보인다.)
 *
 * venue 축이 이 안내를 필요하게 만들었다: NXT·통합은 `kiwoom_live` 가 저장을 시작한
 * 날부터만 존재하므로 그 이전 구간은 전부 빈다. 그전까지는 백엔드가 **KRX 데이터를
 * 그 시장 것처럼** 돌려주고 있어서 빈 화면 자체가 없었다 — 즉 이 안내는 정직해진
 * 대가로 생긴 화면을 설명한다.
 *
 * 순수 함수로 둔 이유는 문구 결정이 **분기 다섯 개**라 렌더와 섞으면 테스트가
 * 마운트를 요구하기 때문이다.
 */

/** 데이터가 원리적으로 없는 사유 — "고장" 이 아니라 "원래 없음". */
const ABSENT_REASONS = new Set([
  'venue_unsupported', 'source_missing', 'stock_date_missing',
  // hogaplay 가 그날을 통째로 못 준다(ADR-0021). venue 결손과 같은 부류다 —
  // 소급 복구가 안 되고 사용자가 할 수 있는 일이 없다는 점에서 동일하다.
  'no_upstream_data',
]);

/**
 * `/live` 에서는 **말하지 않을** 사유.
 *
 * `not_captured` 는 "아직 캡처하지 않았다" 이고, 임의 종목을 탐색하는 평소 화면에서는
 * 그게 정상 상태다 — 실측(2026-08-16) 90일 창에서 한 종목이 22일까지 미캡처였다. 그걸
 * 배너로 말하면 상시 켜져 의미를 잃고, 정작 진짜 결손이 왔을 때 묻힌다.
 *
 * **사용자가 구간을 명시적으로 정했을 때만** 뜻이 있다. 그 조건은 `/study` 가 소유하다가
 * (2026-08-23 페이지 삭제) **저장 구간이 걸린 차트 창**으로 옮겨왔다 — 근거가 페이지가
 * 아니라 구간의 성격이었으므로 조건은 그대로다(`ChartWindow` 의 `showNotCapturedNotice`).
 */
const IGNORED_REASONS = new Set(['not_captured']);

/** `20251218` → `12/18`. 차트 위 한 줄이라 연도는 뺀다(조회 구간이 곧 맥락). */
function monthDay(yyyymmdd: string): string {
  return `${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}`;
}

/**
 * 스크린리더용 뒷문장. 시각 문구는 한 줄이어야 차트를 안 가리므로 "왜" 는 여기서 말한다.
 *
 * 사유마다 갈리는 이유: #1133 의 기본 문구는 **호가 pane 전용** 맥락이라
 * "캔들만 표시됩니다" 라고 하는데, 업스트림 결손은 캔들까지 없어 그 말이 **틀린다**.
 */
export function deriveHogaMissingDetail(
  missingDates: readonly RangeMissingDate[] | undefined,
): string {
  const reasons = missingDates ?? [];
  if (reasons.some((m) => m.reason === 'no_upstream_data')) {
    return '그날은 캔들과 호가가 모두 없어 차트에서 빠집니다.';
  }
  // 미캡처만 남았다면 **행동 가능한** 상태다 — 그 점을 말해야 안내가 쓸모를 갖는다.
  if (reasons.length > 0 && reasons.every((m) => m.reason === 'not_captured')) {
    return '아직 캡처하지 않은 날입니다. 캡처하면 채워집니다.';
  }
  return '이 구간은 호가 지표를 만들 데이터가 없어 캔들만 표시됩니다.';
}

export interface HogaMissingNoticeInput {
  missingDates: readonly RangeMissingDate[] | undefined;
  venue: LiveVenueOption;
  /** 이 범위에 호가 지표 포인트가 **하나라도** 있나. 전 구간 결손과 일부 결손의
   *  문구가 다르다 — 일부인데 "없음" 이라고 하면 보이는 데이터와 모순된다. */
  hasAnyHogaPoints: boolean;
  /**
   * `not_captured` 를 말할 것인가. **저장 구간이 걸린 창만 켠다.**
   *
   * 조회 구간을 사용자가 **명시적으로 정한** 화면에서만 뜻이 있다. `/live` 는 임의
   * 종목을 탐색하는 자리라 미캡처가 정상 상태이고(실측 2026-08-16: 90일 창에서 한
   * 종목 22일), 거기서 켜면 배너가 상시 들어와 진짜 결손이 묻힌다.
   */
  includeNotCaptured?: boolean;
}

/**
 * 표시할 문구. 안내가 필요 없으면 `null`.
 *
 * 사유가 섞여 있으면 **결손을 우선**한다 — 손상(`meta_unreadable`)은 재캡처로 고칠 수
 * 있는 일시적 상태이고 결손은 아니라서, 사용자가 먼저 알아야 할 쪽이 결손이다.
 */
export function deriveHogaMissingNotice({
  missingDates,
  venue,
  hasAnyHogaPoints,
  includeNotCaptured = false,
}: HogaMissingNoticeInput): string | null {
  if (!missingDates || missingDates.length === 0) return null;

  // ⚠ 무시 사유를 **분류보다 먼저** 걷어낸다. 뒤에 두면 `not_captured` 만 담긴 목록이
  // 아래 `!absent` 분기로 떨어져 "손상" 이 뜬다 — 침묵이 아니라 오진이다.
  const relevant = missingDates.filter((m) => !IGNORED_REASONS.has(m.reason));
  if (relevant.length === 0) {
    // 결손이 없고 미캡처만 남았다 — 저장 구간 창은 여기서 말하고 평소 창은 침묵한다.
    if (!includeNotCaptured) return null;
    const n = missingDates.filter((m) => m.reason === 'not_captured');
    if (n.length === 1) return `${monthDay(n[0].date)} 미캡처`;
    if (n.length > 1) return `미캡처 ${n.length}일`;
    return null;
  }

  // 업스트림 결손은 **가장 구체적인 사유**라 먼저 말한다. venue 결손("이 시장엔 원래
  // 없음")과 달리 특정 날짜를 지목할 수 있고, 희소해서(전체 429거래일 중 4일) 지목이
  // 실제로 유용하다. "호가 기록 없음" 으로 뭉치면 절반만 맞는 말이 된다 — 그날은
  // 호가만이 아니라 캔들까지 전부 없다.
  const upstream = relevant.filter((m) => m.reason === 'no_upstream_data');
  if (upstream.length === 1) return `${monthDay(upstream[0].date)} 업스트림 데이터 없음`;
  if (upstream.length > 1) return `업스트림 데이터 없음 ${upstream.length}일`;

  const absent = relevant.some((m) => ABSENT_REASONS.has(m.reason));
  if (!absent) {
    // 전부 손상 — 결손과 달리 재캡처 여지가 있으므로 다르게 말한다.
    return hasAnyHogaPoints ? '호가 기록 일부 손상' : '호가 기록 손상';
  }

  // venue 이름을 넣는 건 KRX 가 아닐 때뿐이다. KRX 에서 "KRX 호가 기록 없음" 은
  // 시장을 원인으로 오해하게 만든다 — 그 경우 원인은 그날 캡처가 없다는 것이다.
  const scope = venue === 'KRX' ? '호가 기록' : `${LIVE_VENUE_LABELS[venue]} 호가 기록`;
  return hasAnyHogaPoints ? `${scope} 없는 구간 포함` : `${scope} 없음`;
}
