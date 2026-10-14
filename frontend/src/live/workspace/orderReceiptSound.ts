const DURATION_SECONDS = 0.15;
const PEAK_GAIN = 0.18;
let context: AudioContext | null = null;
const notifiedCommands = new Set<string>();

async function readyContext(): Promise<AudioContext | null> {
  if (typeof window === 'undefined' || !window.AudioContext) return null;
  if (!context || context.state === 'closed') context = new window.AudioContext();
  if (context.state === 'suspended') await context.resume();
  return context.state === 'running' ? context : null;
}

/** Start/resume during the user gesture, before waiting for the order response. */
export function prepareOrderReceiptSound(): void {
  void readyContext().catch(() => { /* Audio availability never affects orders. */ });
}

/** A soft, fixed-volume 150ms pluck, shared by preview and accepted orders. */
export async function playOrderReceiptSound(): Promise<boolean> {
  try {
    const audio = await readyContext();
    if (!audio) return false;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    const start = audio.currentTime;
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(1100, start);
    oscillator.frequency.exponentialRampToValueAtTime(600, start + 0.08);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(PEAK_GAIN, start + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + DURATION_SECONDS - 0.01);
    gain.gain.linearRampToValueAtTime(0, start + DURATION_SECONDS);
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    oscillator.start(start);
    oscillator.stop(start + DURATION_SECONDS);
    return true;
  } catch {
    return false;
  }
}

/** Shared across windows/remounts; checking the same command cannot sound again. */
export function notifyOrderReceiptAccepted(account: number, commandId: string): void {
  const key = `${account}:${commandId}`;
  if (notifiedCommands.has(key)) return;
  notifiedCommands.add(key);
  void playOrderReceiptSound();
}
