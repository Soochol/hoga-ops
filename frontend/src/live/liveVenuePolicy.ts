import { isMinuteTimeframe, type LiveTimeframe } from '../state/livePage';
import { LIVE_VENUE_LABELS, type LiveVenueOption } from '../state/liveVenue';
import type { LiveEffectiveSession } from '../api/livePastCandles';
import {
  isKrxRegularSessionNow,
  realMsToYyyymmdd,
  regularSessionCloseMs,
  regularSessionOpenMs,
} from './liveDateTime';

/**
 * 백엔드가 프레임에 실어 보내는 **시장 태그**. 스냅샷·WS 틱의 `venue` 필드 타입이다.
 *
 * 선택 옵션(`LiveVenueOption`)과 값이 같지만 **다른 것**이다: 하나는 사용자가 고른
 * 것이고 하나는 데이터가 어디서 왔는지다. 지금은 세 값이 일치하지만(그래서
 * `liveVenueAcceptsFrame` 이 단순 비교다) 같은 타입으로 묶으면 그 우연을 계약으로
 * 굳혀 버린다.
 *
 * ⚠ **명명 타입인 것이 요점이다.** 이 유니온은 인라인 리터럴로 6개 파일에 흩어져
 * 있었다(`liveVenuePolicy` · `liveTickOverlay`×2 · `bucketHogaSeries`×2 ·
 * 그리고 지금은 제거된 단별 잔량 증감 모듈×2). `'UN'` 을 추가할 때 하나를 빠뜨려도
 * **타입 에러가 안 난다** —
 * 좁은 쪽이 넓은 쪽에 할당 가능하고, `liveTickOverlay` 는 `as` 캐스팅이라 검사
 * 자체가 없다. 그러면 UN 프레임이 런타임에 조용히 걸러진다.
 */
export type LiveFrameVenue = 'KRX' | 'NXT' | 'UN';

export function liveVenueDisplayLabel(venue: LiveVenueOption): string {
  return LIVE_VENUE_LABELS[venue];
}

export function liveVenueKeepsHogaKrx(venue: LiveVenueOption): boolean {
  return venue !== 'KRX';
}

export function liveVenueUsesExtendedMinuteWindow(venue: LiveVenueOption): boolean {
  return venue !== 'KRX';
}

/**
 * 거래소별 표시 세션 창의 **사람이 읽는 라벨**(`09:00–15:30` / `08:00–20:00`).
 *
 * 시각 자체는 `liveVenueSessionBoundsMs` 가 진실 소스이고 여기는 그 분기를 그대로
 * 타서 문자열만 붙인다 — 전환 비용(x축이 정규장에서 08:00–20:00 로 리플로우된다)을
 * 고르기 **전에** 알리려고 거래소 선택기가 옵션마다 이 라벨을 병기한다.
 *
 * ⚠ 시각을 손으로 다시 적지 말 것. 세션 창이 바뀌면 `liveVenueSessionBoundsMs` 와
 * 이 라벨이 조용히 갈리고, 갈린 쪽이 **선택 화면**이라 사용자가 먼저 본다.
 */
export function liveVenueSessionWindowLabel(venue: LiveVenueOption): string {
  return liveVenueUsesExtendedMinuteWindow(venue) ? '08:00–20:00' : '09:00–15:30';
}

function isKstWeekday(yyyymmdd: string): boolean {
  const y = parseInt(yyyymmdd.slice(0, 4), 10);
  const m = parseInt(yyyymmdd.slice(4, 6), 10);
  const d = parseInt(yyyymmdd.slice(6, 8), 10);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd !== 0 && wd !== 6;
}

/** NXT/Integrated minute display window (08:00-20:00 KST). */
export function extendedVenueSessionOpenMs(yyyymmdd: string): number {
  return regularSessionOpenMs(yyyymmdd) - 60 * 60 * 1000;
}

export function extendedVenueSessionCloseMs(yyyymmdd: string): number {
  return regularSessionOpenMs(yyyymmdd) + 11 * 3600 * 1000;
}

export function liveVenueSessionBoundsMs(
  yyyymmdd: string,
  venue: LiveVenueOption,
): { open_ms: number; close_ms: number } {
  if (!liveVenueUsesExtendedMinuteWindow(venue)) {
    return { open_ms: regularSessionOpenMs(yyyymmdd), close_ms: regularSessionCloseMs(yyyymmdd) };
  }
  return { open_ms: extendedVenueSessionOpenMs(yyyymmdd), close_ms: extendedVenueSessionCloseMs(yyyymmdd) };
}

export function effectiveSessionBoundsByDate(
  effectiveSessions: readonly LiveEffectiveSession[] | undefined,
): Map<string, { open_ms: number; close_ms: number }> {
  const out = new Map<string, { open_ms: number; close_ms: number }>();
  for (const session of effectiveSessions ?? []) {
    if (
      typeof session.date === 'string' &&
      Number.isFinite(session.open_ms) &&
      Number.isFinite(session.close_ms) &&
      session.open_ms < session.close_ms
    ) {
      out.set(session.date, { open_ms: session.open_ms, close_ms: session.close_ms });
    }
  }
  return out;
}

export function isLiveVenueSessionNow(venue: LiveVenueOption, nowMs: number = Date.now()): boolean {
  if (venue === 'KRX') return isKrxRegularSessionNow(nowMs);
  const today = realMsToYyyymmdd(nowMs);
  if (!isKstWeekday(today)) return false;
  const { open_ms, close_ms } = liveVenueSessionBoundsMs(today, venue);
  return nowMs >= open_ms && nowMs <= close_ms;
}

export function liveVenueRefetchInterval(venue: LiveVenueOption): 60_000 | false {
  return isLiveVenueSessionNow(venue) ? 60_000 : false;
}

/**
 * **선택 venue → 이 종목의 유효 venue.** 사용자가 고른 값과 실제로 조회·판정에 쓸
 * 값을 가르는 유일 지점이다.
 *
 * NXT 미상장 종목에 통합(UN)은 **정의상 KRX 와 같다** — 합칠 상대 시장이 없다.
 * 그런데 백엔드는 그 종목에 `_AL` 을 구독하지 않으므로(`coverage.subscription_venues`
 * 가 `("KRX",)` 를 준다) UN 태그 프레임이 **한 건도 생기지 않는다**. 게이트
 * (`liveVenueAcceptsFrame`)는 UN 태그만 받으니 KRX 프레임을 전부 버리고, 결과는
 * 10호가·체결·거래원·틱 등락률이 통째로 빈 화면이다(실측 2026-08-07: WS 15초간
 * 005930 은 UN 프레임 75/585 건, 000440 은 **0 건**).
 *
 * 그래서 여기서 UN 을 KRX 로 되돌린다. 프레임 수용 술어는 그대로 둔 채 **입력 venue
 * 만** 코드별로 정규화하는 것이라 태그 직결 설계(ADR-0140 §5)를 깨지 않는다.
 *
 * 규칙이 좁은 이유:
 *
 * - **`null`/`undefined`(모름)는 강등하지 않는다.** 백엔드가 모름을 fail-open 으로
 *   세 venue 전부 구독하므로(`coverage.py` — "모름은 미상장이 아니다") UN 프레임이
 *   실제로 존재한다. 프론트만 강등하면 있는 데이터를 버린다. 심볼 마스터 도착 전
 *   창에서도 전 코드가 모름이라 **오늘과 동일하게** 동작한다.
 * - **NXT 선택은 건드리지 않는다.** 미상장 종목에 NXT 를 고른 것은 명시적 선택이고,
 *   그때 빈 화면은 정직한 표시다(#1132). UN 만이 "합친 결과를 달라"는 요청이라
 *   해석의 여지가 있다.
 */
export function effectiveLiveVenue(
  selectedVenue: LiveVenueOption,
  nxtEnabled: boolean | null | undefined,
): LiveVenueOption {
  return selectedVenue === 'UN' && nxtEnabled === false ? 'KRX' : selectedVenue;
}

/**
 * venue 정책 **SSOT 술어** — 프레임(체결/호가 스냅샷, 캔들 오버레이 체결, WS 틱)의
 * 시장 태그(`tagVenue`)가 선택된 venue 에 속해 표시·반영돼도 되는지 판정한다.
 * 호가·체결 필터(`filterObByVenue`/`filterTradeByVenue`), 캔들 오버레이
 * (`overlayLiveTrades*`), 현재가 라인, WS 틱 오버레이가 **모두 이 하나를 공유**한다.
 *
 * **태그 직결이다 — 시각을 안 본다**(ADR-0140 §5). 예전엔 UN 에서
 * `tag === liveSubscriptionVenueForMs(tMs)` 로 판정했다. 백엔드가 시분할 구독이라
 * "이 시각엔 이 시장만 정상"이라는 전제가 성립했고, 그 전제로 off-venue 오염을
 * 걸렀다. PR-F 가 세 venue 를 동시 구독하면서 그 전제가 깨졌다 — 이제 같은 시각에
 * 세 시장 프레임이 **정상적으로** 도착한다. 시각 판정을 남겨 두면 정상 데이터의
 * 2/3 을 오염으로 오인해 버린다.
 *
 * 그래서 `tMs` 인자를 없앴다. 시그니처에서 지운 것이 요점이다 — 남겨 두면 호출부가
 * 계속 넘기고, 언젠가 누군가 다시 쓴다.
 *
 * - **KRX**: KRX 태그만. 태그 부재는 구백엔드 하위호환으로 KRX 승격.
 * - **NXT**: NXT 태그만.
 * - **UN**: UN 태그만. ⚠ KRX·NXT 의 합집합이 **아니다** — 키움 `_AL` 이 거래소가
 *   병합한 별도 스트림이라 자기 태그를 달고 온다. 합집합으로 받으면 같은 체결이
 *   KRX·NXT·UN 세 벌로 세어져 거래량이 부풀고, 호가는 두 시장 잔량이 가격대별로
 *   섞인 채 `_AL` 과 겹쳐 이중 계상된다.
 */
export function liveVenueAcceptsFrame(
  selectedVenue: LiveVenueOption,
  tagVenue: LiveFrameVenue | undefined,
): boolean {
  return (tagVenue ?? 'KRX') === selectedVenue;
}

/**
 * 연속 두 호가 스냅샷을 **이어서 diff 해도 되는가** — 같은 거래소(venue)여야 한다.
 * KRX 호가장과 NXT 호가장은 별개 장부라 교차 diff 는 무의미하다(#524 시분할).
 *
 * 단별 잔량 증감 지표(`depthDelta`)와 함께 태어났지만 그 지표가 제거된 뒤에도 남는다 —
 * 사이드바 10호가 카드의 증감 배지(`orderbookDeltaBadges`)가 같은 판정을 쓴다. venue
 * 정책이 실체라서 여기(SSOT)에 둔다.
 */
export function sameDeltaChain(
  prev: { venue?: LiveFrameVenue },
  cur: { venue?: LiveFrameVenue },
): boolean {
  return prev.venue === cur.venue;
}

export function initialVisibleMinuteBarsFor(
  tf: LiveTimeframe,
  _venue: LiveVenueOption,
): number {
  if (!isMinuteTimeframe(tf)) return 300;
  return 300;
}
