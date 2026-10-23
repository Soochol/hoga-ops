/**
 * Single WebSocket transport (ADR-0053). Replaces the two SSE EventSources.
 * Multiplexes global app events (ch:'event') and code-tagged per-code live
 * snapshots (ch:'live') over one connection per tab; demuxes by ch/code and
 * (un)subscribes codes via {action, code}. Backoff reconnect; liveness stamped
 * on every frame; one-shot connected/disconnected on state transitions.
 */
import { wsUrl } from './client';
import { WATCHDOG_TIMEOUT_MS } from './liveness';
import type { PushEvent, LiveSnapshotEntry } from './types';
import type { UsStockCandleEvent } from './usStockRealtime';

type Frame =
  | { ch: 'event'; data: PushEvent }
  | { ch: 'live'; code: string; data: LiveSnapshotEntry }
  | { ch: 'live_batch'; code: string; data: SequencedEntry[]; latest: SequencedEntry[]; dropped: number; queue_age_ms: number }
  | { ch: 'subscribed'; code: string }
  | { ch: 'heartbeat' };

type SequencedEntry = LiveSnapshotEntry & { seq: number };
const _latestSubs = new Map<string, Set<(d: LiveSnapshotEntry) => void>>();
const _latestSeq = new Map<string, number>();
const _partialHistory = new Set<string>();
const _historyListeners = new Set<() => void>();
const _dispatchMs: number[] = [];
const _limitedSubscriptions = new Set<string>();
const _admissionListeners = new Set<() => void>();
export function liveSubscriptionLimited(code: string): boolean { return _limitedSubscriptions.has(code); }
export function subscribeLiveAdmissionStatus(listener: () => void): () => void {
  _admissionListeners.add(listener);
  return () => { _admissionListeners.delete(listener); };
}
function clearAdmission(code?: string): void {
  const changed = code === undefined ? _limitedSubscriptions.size > 0 : _limitedSubscriptions.has(code);
  if (code === undefined) _limitedSubscriptions.clear();
  else _limitedSubscriptions.delete(code);
  if (changed) _admissionListeners.forEach(listener => listener());
}
let _lastReceivedAt = 0;
/** Browser monotonic clock, for correlation with React/DOM performance traces. */
export function wsLastReceivedAt(): number { return _lastReceivedAt; }
export function wsDispatchTimings(): readonly number[] { return [..._dispatchMs]; }
export function historyPartial(code: string): boolean { return _partialHistory.has(code); }
export function subscribeHistoryStatus(listener: () => void): () => void {
  _historyListeners.add(listener);
  return () => { _historyListeners.delete(listener); };
}
function markHistoryPartial(code: string): void {
  if (!_partialHistory.has(code)) {
    _partialHistory.add(code);
    _historyListeners.forEach((notify) => notify());
  }
  // Each new gap can require another refresh. The UI flag is sticky, while
  // eventStream coalesces recovery requests rather than suppressing them forever.
  emitEvent({ type: 'live_history_gap', code });
}
function deliverLatest(code: string, entry: SequencedEntry): void {
  const key = `${code}:${entry.venue ?? 'KRX'}:${entry.kind}`;
  if (entry.seq <= (_latestSeq.get(key) ?? -1)) return;
  _latestSeq.set(key, entry.seq);
  const { seq: _seq, ...data } = entry;
  _latestSubs.get(code)?.forEach((fn) => fn(data));
}

let _ws: WebSocket | null = null;
let _opening = false;
let _connected = false;
let _connectedAt = 0;
export function wsConnectedAt(): number { return _connectedAt; }
let _lastHeartbeatMs = 0;
let _reconnectMs = 500;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _livenessTimer: ReturnType<typeof setInterval> | null = null;
const RECONNECT_MAX_MS = 10_000;

const _eventSubs = new Set<(e: PushEvent) => void>();
const _liveSubs = new Map<string, Set<(d: LiveSnapshotEntry) => void>>();
const _usSubs = new Map<string, { exchange: string; symbol: string; handlers: Set<(event: UsStockCandleEvent) => void> }>();
const _usReleaseTimers = new Map<string, ReturnType<typeof setTimeout>>();

function emitEvent(e: PushEvent): void { _eventSubs.forEach((fn) => fn(e)); }
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
      if (_ws !== sock) return;
      _connectedAt = Date.now();
      _lastHeartbeatMs = Date.now();
      _reconnectMs = 500;
      if (!_connected) { _connected = true; emitEvent({ type: 'connected' }); }
      for (const code of _liveSubs.keys()) send({ action: 'subscribe', code, protocol: 2 });
      for (const { exchange, symbol } of _usSubs.values()) send({ action: 'subscribe_us_stock', exchange, symbol });
    };
    sock.onmessage = (e: MessageEvent) => {
      if (_ws !== sock) return; // queued callbacks from a retired connection are not current evidence
      _lastHeartbeatMs = Date.now(); // ANY frame proves liveness
      const started = performance.now();
      _lastReceivedAt = started;
      let frame: Frame;
      try { frame = JSON.parse(e.data) as Frame; } catch { return; }
      if (frame.ch === 'event') {
        if (frame.data.type === 'us_stock_candles') _usSubs.get(frame.data.instrument_key)?.handlers.forEach(fn => fn(frame.data as UsStockCandleEvent));
        if (frame.data.type === 'live_subscription_limit' && _liveSubs.has(frame.data.code)) {
          _limitedSubscriptions.add(frame.data.code);
          _admissionListeners.forEach(listener => listener());
        }
        emitEvent(frame.data);
      } else if (frame.ch === 'live') {
        _latestSubs.get(frame.code)?.forEach((fn) => fn(frame.data));
        _liveSubs.get(frame.code)?.forEach((fn) => fn(frame.data));
      } else if (frame.ch === 'live_batch') {
        // Current values are published first. The history path receives every
        // retained tick in order, without injecting coalesced latest snapshots.
        for (const entry of frame.latest) deliverLatest(frame.code, entry);
        if (frame.dropped > 0) markHistoryPartial(frame.code);
        for (const { seq: _seq, ...entry } of frame.data) {
          _liveSubs.get(frame.code)?.forEach((fn) => fn(entry));
        }
      }
      _dispatchMs.push(performance.now() - started);
      if (_dispatchMs.length > 256) _dispatchMs.shift();
    };
    sock.onclose = () => {
      if (_ws !== sock) return;
      clearAdmission();
      if (_connected) for (const code of _liveSubs.keys()) markHistoryPartial(code);
      _latestSeq.clear();
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
  if (!_eventSubs.size && !_liveSubs.size && !_usSubs.size) return;
  if (_reconnectTimer !== null) return;
  const delay = _reconnectMs;
  _reconnectMs = Math.min(_reconnectMs * 2, RECONNECT_MAX_MS);
  _reconnectTimer = setTimeout(() => { _reconnectTimer = null; void open(); }, delay);
}

export function subscribeEvents(handler: (e: PushEvent) => void): () => void {
  _eventSubs.add(handler);
  void open();
  return () => { _eventSubs.delete(handler); };
}

export function subscribeUsStock(exchange: string, symbol: string, handler: (event: UsStockCandleEvent) => void): () => void {
  const key = `us-stock:${exchange}:${symbol}`;
  const pendingRelease = _usReleaseTimers.get(key);
  if (pendingRelease) { clearTimeout(pendingRelease); _usReleaseTimers.delete(key); }
  let entry = _usSubs.get(key);
  if (!entry) {
    entry = { exchange, symbol, handlers: new Set() };
    _usSubs.set(key, entry);
    send({ action: 'subscribe_us_stock', exchange, symbol });
  }
  entry.handlers.add(handler);
  void open();
  return () => {
    entry.handlers.delete(handler);
    if (!entry.handlers.size) {
      _usReleaseTimers.set(key, setTimeout(() => {
        _usReleaseTimers.delete(key);
        if (entry.handlers.size || _usSubs.get(key) !== entry) return;
        _usSubs.delete(key);
        send({ action: 'unsubscribe_us_stock', exchange, symbol });
      }, 5000));
    }
  };
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
  if (first) {
    clearAdmission(code);
    send({ action: 'subscribe', code, protocol: 2 });
  }
  return () => {
    const s = _liveSubs.get(code);
    if (!s) return;
    s.delete(handler);
    if (s.size === 0) {
      clearAdmission(code);
      _liveSubs.delete(code);
      _partialHistory.delete(code);
      for (const key of _latestSeq.keys()) if (key.startsWith(`${code}:`)) _latestSeq.delete(key);
      _historyListeners.forEach((notify) => notify());
      send({ action: 'unsubscribe', code });
    }
  };
}

/** Shares the same upstream code subscription while consuming only latest state. */
export function subscribeLiveLatest(code: string, handler: (d: LiveSnapshotEntry) => void): () => void {
  let subscribers = _latestSubs.get(code);
  if (!subscribers) { subscribers = new Set(); _latestSubs.set(code, subscribers); }
  subscribers.add(handler);
  const release = subscribeLive(code, () => {});
  return () => {
    subscribers.delete(handler);
    if (!subscribers.size) _latestSubs.delete(code);
    release();
  };
}

export function __resetForTests(): void {
  if (_reconnectTimer !== null) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  if (_livenessTimer !== null) { clearInterval(_livenessTimer); _livenessTimer = null; }
  _ws?.close();
  _ws = null;
  _opening = false;
  _connected = false;
  _connectedAt = 0;
  _lastHeartbeatMs = 0;
  _reconnectMs = 500;
  _eventSubs.clear();
  _liveSubs.clear();
  _usSubs.clear();
  _usReleaseTimers.forEach(clearTimeout); _usReleaseTimers.clear();
  _latestSubs.clear(); _latestSeq.clear(); _partialHistory.clear(); _historyListeners.clear();
  _dispatchMs.length = 0;
  _limitedSubscriptions.clear(); _admissionListeners.clear();
  _lastReceivedAt = 0;
}
