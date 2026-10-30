import { regularSessionOpenMs, regularSessionCloseMs } from '../liveDateTime';

/** The selected day's axis stops at the current minute, capped at its close. */
export function majorIndicesTimeAxis(date: string, now: number, width: number, minSpacing = 64) {
  const start = regularSessionOpenMs(date);
  const end = Math.max(start, Math.min(now, regularSessionCloseMs(date)));
  const span = end - start;
  if (span === 0) return { start, end, ticks: [start] };
  if (width < minSpacing) return { start, end, ticks: [end] };
  const step = ([15, 30, 60].find(minutes => minutes * 60_000 / span * width >= minSpacing) ?? 60) * 60_000;
  const ticks = [start];
  for (let time = start + step; time < end; time += step) {
    const position = (time - start) / span * width;
    const previousPosition = (ticks[ticks.length - 1] - start) / span * width;
    if (position - previousPosition >= minSpacing && width - position >= minSpacing) ticks.push(time);
  }
  ticks.push(end);
  return { start, end, ticks };
}
