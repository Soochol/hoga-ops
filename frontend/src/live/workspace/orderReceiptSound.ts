import type { TradingAccountId } from '../../api/trading';
import { orderSoundSamples, type OrderSoundKind } from './orderSoundTone';
const MAX_START_DELAY_MS = 800;
const RESUME_TIMEOUT_MS = 250;
const RETRY_DELAY_MS = 80;
let context: AudioContext | null = null;
let chimes: { audio: AudioContext; buffers: Map<OrderSoundKind, AudioBuffer> } | null = null;
const notifiedCommands = new Set<string>();
const pendingCommands = new Map<string, Promise<boolean>>();

interface SoundDiagnostic { atMs: number; event: string; state: string; error?: string }
const diagnostics: SoundDiagnostic[] = [];
function record(event: string, error?: unknown) {
  diagnostics.push({ atMs: Date.now(), event, state: context?.state ?? 'unavailable',
    ...(error == null ? {} : { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }) });
  if (diagnostics.length > 30) diagnostics.shift();
}
/** Bounded local diagnostics; no account, symbol, or order identifiers are recorded. */
export function getOrderReceiptSoundDiagnostics(): readonly SoundDiagnostic[] {
  return diagnostics.map(entry => ({ ...entry }));
}

async function readyContext(deadline: number): Promise<AudioContext | null> {
  try {
    if (typeof window === 'undefined' || !window.AudioContext) { record('unsupported'); return null; }
    if (!context || context.state === 'closed') context = new window.AudioContext({ latencyHint: 'interactive' });
    const audio = context;
    if (audio.state !== 'running') {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Invoke resume on every gesture, even if a previous, blocked resume is pending.
        await Promise.race([audio.resume(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('resume-timeout')), Math.max(0, deadline - Date.now()));
        })]);
      } finally { clearTimeout(timer); }
    }
    if (Date.now() >= deadline) { record('expired'); return null; }
    if (audio.state !== 'running') { record('not-running'); return null; }
    return audio;
  } catch (error) {
    record('prepare-failed', error);
    return null;
  }
}

/** Start/resume during the user gesture, before waiting for the order response. */
export function prepareOrderReceiptSound(): void {
  void readyContext(Date.now() + RESUME_TIMEOUT_MS);
}

/** Prepare on user interaction as well as focus/visibility recovery. Never replay old receipts. */
let recoverySubscribers = 0;
function recover() {
  if (document.visibilityState !== 'hidden') prepareOrderReceiptSound();
}
export function subscribeOrderReceiptSoundRecovery(): () => void {
  if (recoverySubscribers++ === 0) {
    window.addEventListener('focus', recover);
    document.addEventListener('visibilitychange', recover);
    // Capture runs before order handlers, including children that stop propagation.
    // Keep listening after the first gesture so idle/interrupted audio can recover.
    window.addEventListener('pointerdown', recover, true);
    window.addEventListener('keydown', recover, true);
  }
  return () => {
    if (--recoverySubscribers === 0) {
      window.removeEventListener('focus', recover);
      document.removeEventListener('visibilitychange', recover);
      window.removeEventListener('pointerdown', recover, true);
      window.removeEventListener('keydown', recover, true);
    }
  };
}

function chimeBuffer(audio: AudioContext, kind: OrderSoundKind): AudioBuffer {
  if (chimes?.audio !== audio) chimes = { audio, buffers: new Map() };
  const cached = chimes.buffers.get(kind);
  if (cached) return cached;
  const samples = orderSoundSamples(kind, audio.sampleRate);
  const buffer = audio.createBuffer(1, samples.length, audio.sampleRate);
  buffer.getChannelData(0).set(samples);
  chimes.buffers.set(kind, buffer);
  return buffer;
}

/** One source contains the complete sound, so retry cannot duplicate a partially started chime. */
export async function playOrderSound(kind: OrderSoundKind): Promise<boolean> {
  const deadline = Date.now() + MAX_START_DELAY_MS;
  for (let attempt = 0; attempt < 2; attempt++) {
    // Allow a fresh resume attempt after 250ms, but let the final attempt use
    // the remaining budget. Two fixed 250ms waits used to abandon slow startup
    // at 580ms, even when audio became ready within the 800ms receipt window.
    const audio = await readyContext(attempt === 0 ? Math.min(deadline, Date.now() + RESUME_TIMEOUT_MS) : deadline);
    if (audio && Date.now() < deadline) {
      let source: AudioBufferSourceNode | undefined;
      try {
        source = audio.createBufferSource();
        source.buffer = chimeBuffer(audio, kind);
        source.connect(audio.destination);
        source.onended = () => source?.disconnect();
        if (audio.state !== 'running' || Date.now() >= deadline) throw new Error('audio-not-ready');
        source.start(audio.currentTime + 0.02);
        record('play-started');
        return true;
      } catch (error) {
        source?.disconnect();
        record('play-failed', error);
      }
    }
    if (attempt === 0 && Date.now() + RETRY_DELAY_MS < deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    } else break;
  }
  console.warn('[order-receipt-sound] playback unavailable', getOrderReceiptSoundDiagnostics().at(-1));
  return false;
}

export function playOrderReceiptSound(): Promise<boolean> {
  return playOrderSound('receipt');
}

// Shared across windows: each cumulative fill is announced only once per tab.
const notifiedFills = new Map<string, number>();
export function notifyOrderFill(account: TradingAccountId, code: string, orderId: string,
  side: 'BUY' | 'SELL', filled: number): void {
  const key = JSON.stringify([account, code, orderId]);
  if (filled <= (notifiedFills.get(key) ?? 0)) return;
  notifiedFills.delete(key);
  notifiedFills.set(key, filled);
  while (notifiedFills.size > 2000) notifiedFills.delete(notifiedFills.keys().next().value!);
  void playOrderSound(side === 'BUY' ? 'buy-fill' : 'sell-fill');
}

/** Deduplicate concurrent calls, and remember only successfully started notifications. */
export function notifyOrderReceiptAccepted(account: TradingAccountId, commandId: string): Promise<boolean> {
  const key = `${account}:${commandId}`;
  if (notifiedCommands.has(key)) return Promise.resolve(true);
  const pending = pendingCommands.get(key);
  if (pending) return pending;
  const playback = playOrderReceiptSound().then(started => {
    if (started) notifiedCommands.add(key);
    return started;
  }).finally(() => pendingCommands.delete(key));
  pendingCommands.set(key, playback);
  return playback;
}
