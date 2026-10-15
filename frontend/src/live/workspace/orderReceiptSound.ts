const PEAK_GAIN = 0.45;
const NOTE_SECONDS = 0.16;
const SECOND_NOTE_AT = 0.17;
const MAX_START_DELAY_MS = 800;
const RESUME_TIMEOUT_MS = 250;
const RETRY_DELAY_MS = 80;
let context: AudioContext | null = null;
let chime: { audio: AudioContext; buffer: AudioBuffer } | null = null;
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
          timer = setTimeout(() => reject(new Error('resume-timeout')), Math.max(0, Math.min(RESUME_TIMEOUT_MS, deadline - Date.now())));
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

/** Share focus/visibility listeners across enabled windows; recovery never replays old receipts. */
let recoverySubscribers = 0;
function recover() {
  if (document.visibilityState !== 'hidden') prepareOrderReceiptSound();
}
export function subscribeOrderReceiptSoundRecovery(): () => void {
  if (recoverySubscribers++ === 0) {
    window.addEventListener('focus', recover);
    document.addEventListener('visibilitychange', recover);
  }
  return () => {
    if (--recoverySubscribers === 0) {
      window.removeEventListener('focus', recover);
      document.removeEventListener('visibilitychange', recover);
    }
  };
}

function chimeBuffer(audio: AudioContext): AudioBuffer {
  if (chime?.audio === audio) return chime.buffer;
  const buffer = audio.createBuffer(1, Math.ceil(audio.sampleRate * (SECOND_NOTE_AT + NOTE_SECONDS)), audio.sampleRate);
  const samples = buffer.getChannelData(0);
  for (const [offset, frequency] of [[0, 880], [SECOND_NOTE_AT, 660]]) {
    for (let i = 0; i < Math.floor(NOTE_SECONDS * audio.sampleRate); i++) {
      const t = i / audio.sampleRate;
      const envelope = t < 0.008 ? t / 0.008 : t < 0.045 ? 1 : ((NOTE_SECONDS - t) / (NOTE_SECONDS - 0.045)) ** 2;
      const phase = 2 * Math.PI * frequency * t;
      samples[Math.round(offset * audio.sampleRate) + i] = PEAK_GAIN * envelope
        * (Math.sin(phase) + 0.18 * Math.exp(-22 * t) * Math.sin(2 * phase)) / 1.18;
    }
  }
  chime = { audio, buffer };
  return buffer;
}

/** One source contains both notes, so retry cannot duplicate a partially started chime. */
export async function playOrderReceiptSound(): Promise<boolean> {
  const deadline = Date.now() + MAX_START_DELAY_MS;
  for (let attempt = 0; attempt < 2; attempt++) {
    const audio = await readyContext(deadline);
    if (audio && Date.now() < deadline) {
      let source: AudioBufferSourceNode | undefined;
      try {
        source = audio.createBufferSource();
        source.buffer = chimeBuffer(audio);
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

/** Deduplicate concurrent calls, and remember only successfully started notifications. */
export function notifyOrderReceiptAccepted(account: number, commandId: string): Promise<boolean> {
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
