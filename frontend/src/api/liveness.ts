/**
 * Liveness thresholds for the WebSocket connection surface (ADR-0053).
 * Ordering invariant (all in ms): SERVER_PING < LIVE_STALE < WATCHDOG < STATUS_STALE.
 * SERVER_PING mirrors hoga/api/ws.py::_PING_TIMEOUT_S (30s) by hand (ADR-0004).
 * Each consumer threshold must exceed the server ping so a connected-but-idle
 * socket stays "live" between pings.
 */
export const SERVER_PING_MS = 30_000;       // mirror of backend _PING_TIMEOUT_S
export const LIVE_STALE_MS = 35_000;        // /live LIVE● pill flips to 재연결 중
export const WATCHDOG_TIMEOUT_MS = 45_000;  // ws.ts force-closes a silently-dead socket
export const STATUS_STALE_MS = 60_000;      // nav StatusDot flips to yellow
