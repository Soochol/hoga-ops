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
const ABSENT_REASONS = new Set(['venue_unsupported', 'source_missing', 'stock_date_missing']);

export interface HogaMissingNoticeInput {
  missingDates: readonly RangeMissingDate[] | undefined;
  venue: LiveVenueOption;
  /** 이 범위에 호가 지표 포인트가 **하나라도** 있나. 전 구간 결손과 일부 결손의
   *  문구가 다르다 — 일부인데 "없음" 이라고 하면 보이는 데이터와 모순된다. */
  hasAnyHogaPoints: boolean;
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
}: HogaMissingNoticeInput): string | null {
  if (!missingDates || missingDates.length === 0) return null;

  const absent = missingDates.some((m) => ABSENT_REASONS.has(m.reason));
  if (!absent) {
    // 전부 손상 — 결손과 달리 재캡처 여지가 있으므로 다르게 말한다.
    return hasAnyHogaPoints ? '호가 기록 일부 손상' : '호가 기록 손상';
  }

  // venue 이름을 넣는 건 KRX 가 아닐 때뿐이다. KRX 에서 "KRX 호가 기록 없음" 은
  // 시장을 원인으로 오해하게 만든다 — 그 경우 원인은 그날 캡처가 없다는 것이다.
  const scope = venue === 'KRX' ? '호가 기록' : `${LIVE_VENUE_LABELS[venue]} 호가 기록`;
  return hasAnyHogaPoints ? `${scope} 없는 구간 포함` : `${scope} 없음`;
}
