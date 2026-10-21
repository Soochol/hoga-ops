export type OrderSoundKind = 'receipt' | 'buy-fill' | 'sell-fill';

const FILL_SECONDS = 0.5;
const SOFT_CHORD_FREQUENCIES = [440, 554.365, 659.255];
const RADAR_PULSES = [[0, 880], [0.14, 880], [0.28, 1174.66]];

/** Preview and live playback share the same waveform; fills last exactly half a second. */
export function orderSoundSamples(kind: OrderSoundKind, sampleRate: number): Float32Array {
  if (kind !== 'receipt') return fillSamples(kind, sampleRate);
  const frequencies = [880, 660], spacing = 0.17, duration = 0.16;
  const samples = new Float32Array(Math.ceil(sampleRate * ((frequencies.length - 1) * spacing + duration)));
  frequencies.forEach((frequency, note) => {
    for (let i = 0; i < Math.floor(duration * sampleRate); i++) {
      const t = i / sampleRate;
      const envelope = t < 0.008 ? t / 0.008 : t < 0.045 ? 1 : ((duration - t) / (duration - 0.045)) ** 2;
      const phase = 2 * Math.PI * frequency * t;
      samples[Math.round(note * spacing * sampleRate) + i] += 0.45 * envelope
        * (Math.sin(phase) + 0.18 * Math.exp(-22 * t) * Math.sin(2 * phase)) / 1.18;
    }
  });
  return samples;
}

function fillSamples(kind: 'buy-fill' | 'sell-fill', sampleRate: number): Float32Array {
  const raw = new Float64Array(Math.round(FILL_SECONDS * sampleRate));
  let peak = 0;
  for (let i = 0; i < raw.length; i++) {
    const t = i / sampleRate;
    const fade = Math.min(1, (raw.length - 1 - i) / (sampleRate * 0.035)) ** 2;
    let value = 0;
    if (kind === 'buy-fill') {
      // A softly swelling three-note chord.
      const envelope = (1 - Math.exp(-t / 0.018)) * Math.exp(-4.3 * t);
      for (const frequency of SOFT_CHORD_FREQUENCIES) {
        value += Math.sin(2 * Math.PI * frequency * t + 0.08 * Math.sin(2 * Math.PI * 4 * t));
      }
      value *= envelope / SOFT_CHORD_FREQUENCIES.length;
    } else {
      // Two radar pings followed by a higher closing ping.
      for (const [offset, frequency] of RADAR_PULSES) {
        const elapsed = t - offset;
        if (elapsed < 0) continue;
        const pulse = Math.min(1, elapsed / 0.005) * Math.exp(-19 * elapsed);
        const angle = 2 * Math.PI * frequency * elapsed;
        value += pulse * (Math.sin(angle) + 0.1 * Math.sin(3 * angle));
      }
    }
    raw[i] = value * fade;
    peak = Math.max(peak, Math.abs(raw[i]));
  }
  return Float32Array.from(raw, value => value * 0.4 / peak);
}
