/**
 * Single WebSocket transport (ADR-0053). Replaces the two SSE EventSources.
 * Multiplexes global app events (ch:'event') and code-tagged per-code live
 * snapshots (ch:'live') over one connection per tab; demuxes by ch/code and
 * (un)subscribes codes via {action, code}. Backoff reconnect; liveness stamped
 * on every frame; one-shot connected/disconnected on state transitions.
 */
import { wsUrl } from './client';
import { WATCHDOG_TIMEOUT_MS } from './liveness';
import type { SSEEvent, LiveSnapshotEntry } from './types';

type Frame =
  | { ch: 'event'; data: SSEEvent }
  | { ch: 'live'; code: string; data: LiveSnapshotEntry }
  | { ch: 'subscribed'; code: string }
  | { ch: 'heartbeat' };

let _ws: WebSocket | null = null;
let _opening = false;
let _connected = false;
let _lastHeartbeatMs = 0;
let _reconnectMs = 500;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _livenessTimer: ReturnType<typeof setInterval> | null = null;
const RECONNECT_MAX_MS = 10_000;

const _eventSubs = new Set<(e: SSEEvent) => void>();
const _liveSubs = new Map<string, Set<(d: LiveSnapshotEntry) => void>>();

function emitEvent(e: SSEEvent): void { _eventSubs.forEach((fn) => fn(e)); }
export function lastHeartbeat(): number { return _lastHeartbeatMs; }

function wsCtor(): typeof WebSocket | null {
  const W = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  return typeof W === 'function' ? W : null;
}

function send(obj: unknown): void {
  if (_ws && _ws.readyState === 1) _ws.send(JSON.stringify(obj));
}

async function open(): Promise<void> {
  if (_ws || _opening) return;
  const W = wsCtor();
  if (!W) return; // jsdom / unsupported — silent no-op
  _opening = true;
  try {
    const url = await wsUrl('/api/ws');
    if (_ws) return; // raced
    const sock = new W(url);
    sock.onopen = () => {
      _lastHeartbeatMs = Date.now();
      _reconnectMs = 500;
      if (!_connected) { _connected = true; emitEvent({ type: 'connected' }); }
      for (const code of _liveSubs.keys()) send({ action: 'subscribe', code });
    };
    sock.onmessage = (e: MessageEvent) => {
      _lastHeartbeatMs = Date.now(); // ANY frame proves liveness
      let frame: Frame;
      try { frame = JSON.parse(e.data) as Frame; } catch { return; }
      if (frame.ch === 'event') {
        emitEvent(frame.data);
      } else if (frame.ch === 'live') {
        _liveSubs.get(frame.code)?.forEach((fn) => fn(frame.data));
      }
    };
    sock.onclose = () => {
      _ws = null;
      if (_connected) { _connected = false; emitEvent({ type: 'disconnected' }); }
      scheduleReconnect();
    };
    sock.onerror = () => sock.close();
    _ws = sock;
    ensureLivenessWatchdog();
  } finally {
    _opening = false;
  }
}

function ensureLivenessWatchdog(): void {
  if (_livenessTimer !== null) return;
  _livenessTimer = setInterval(() => {
    if (!_ws || _ws.readyState !== 1) return;
    if (_lastHeartbeatMs !== 0 && Date.now() - _lastHeartbeatMs > WATCHDOG_TIMEOUT_MS) {
      _ws.close(); // triggers onclose → disconnected + scheduleReconnect
    }
  }, 10_000);
}

function scheduleReconnect(): void {
  if (!_eventSubs.size && !_liveSubs.size) return;
  if (_reconnectTimer !== null) return;
  const delay = _reconnectMs;
  _reconnectMs = Math.min(_reconnectMs * 2, RECONNECT_MAX_MS);
  _reconnectTimer = setTimeout(() => { _reconnectTimer = null; void open(); }, delay);
}

export function subscribeEvents(handler: (e: SSEEvent) => void): () => void {
  _eventSubs.add(handler);
  void open();
  return () => { _eventSubs.delete(handler); };
}

export function subscribeLive(
  code: string,
  handler: (d: LiveSnapshotEntry) => void,
): () => void {
  let set = _liveSubs.get(code);
  const first = !set;
  if (!set) { set = new Set(); _liveSubs.set(code, set); }
  set.add(handler);
  void open();
  if (first) send({ action: 'subscribe', code });
  return () => {
    const s = _liveSubs.get(code);
    if (!s) return;
    s.delete(handler);
    if (s.size === 0) {
      _liveSubs.delete(code);
      send({ action: 'unsubscribe', code });
    }
  };
}

export function __resetForTests(): void {
  if (_reconnectTimer !== null) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  if (_livenessTimer !== null) { clearInterval(_livenessTimer); _livenessTimer = null; }
  _ws?.close();
  _ws = null;
  _opening = false;
  _connected = false;
  _lastHeartbeatMs = 0;
  _reconnectMs = 500;
  _eventSubs.clear();
  _liveSubs.clear();
}
