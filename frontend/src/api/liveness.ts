/**
 * Liveness thresholds for the WebSocket connection surface (ADR-0053).
 * Ordering invariant (all in ms): SERVER_PING < LIVE_STALE < WATCHDOG < STATUS_STALE.
 * SERVER_PING mirrors hoga/api/ws.py::_PING_TIMEOUT_S (30s) by hand (ADR-0004).
 * Each consumer threshold must exceed the server ping so a connected-but-idle
 * socket stays "live" between pings.
 */
export const SERVER_PING_MS = 30_000;       // mirror of backend _PING_TIMEOUT_S
// 실제 소비처는 TitleBarSymbolRow 의 수집 상태 도트(ADR-0067)다. 예전 주석은 이걸
// "LIVE● pill" 로 지목했지만 그 pill 은 capture_reason 축이라 이 임계와 무관하고,
// 이제 '재연결 중' 을 낼 수조차 없다(그 reason 을 백엔드가 안 낸다).
export const LIVE_STALE_MS = 35_000;        // 타이틀바 수집 도트가 '재연결 중' 으로 뒤집히는 임계
export const WATCHDOG_TIMEOUT_MS = 45_000;  // ws.ts force-closes a silently-dead socket
export const STATUS_STALE_MS = 60_000;      // nav StatusDot flips to yellow
