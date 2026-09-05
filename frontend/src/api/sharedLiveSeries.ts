/** 종목·거래일당 버퍼/WS 구독/150ms flush 하나. 마지막 소비자가 떠나면 회수한다.
 * 등록은 React의 subscribe(커밋)에서만 한다. 렌더 중 중단된 창은 버퍼를 남기지 않는다.
 */
import type { LiveSeriesData, LiveSeriesResponse } from './liveSeries';
import { subscribeLive } from './ws';
import { LiveSnapshotBuffer, type RawSnapshot, type SnapshotKind } from '../live/liveSnapshotBuffer';
import { liveVenueAcceptsFrame, type LiveFrameVenue } from '../live/liveVenuePolicy';
import type { ObSnapshot, TradeSnapshot } from '../live/bucketHogaSeries';
import type { LiveVenueOption } from '../state/liveVenue';

export const LIVE_FLUSH_MS = 150;
type Frames = Pick<LiveSeriesData, 'ob' | 'trade' | 'broker' | 'program' | 'afterHours' | 'expected'>;
type Raw = Record<SnapshotKind, readonly RawSnapshot[]>;
const KINDS = ['ob', 'trade', 'broker', 'program', 'ah', 'expected'] as const;
const EMPTY: readonly never[] = Object.freeze([]);
const EMPTY_RAW: Raw = { ob: EMPTY, trade: EMPTY, broker: EMPTY, program: EMPTY, ah: EMPTY, expected: EMPTY };
const EMPTY_FRAMES: Frames = { ob: EMPTY, trade: EMPTY, broker: EMPTY, program: EMPTY, afterHours: EMPTY, expected: EMPTY };

export function pickLastKnownOb(latched: ObSnapshot | undefined, served: ObSnapshot | undefined): ObSnapshot | undefined {
  if (latched === undefined) return served;
  if (served === undefined) return latched;
  return served.t_ms > latched.t_ms ? served : latched;
}

function sameFrames(a: readonly RawSnapshot[], b: readonly RawSnapshot[]): boolean {
  return a.length === b.length && a.every((frame, i) => frame === b[i]);
}

function frameKey(frame: RawSnapshot): string {
  // 두 전송 경로의 JSON 객체 키 순서는 달라도 같은 프레임이다. 배열 순서는 유지한다.
  return JSON.stringify(frame, (_key, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    }
    return value;
  });
}

/** 시각은 이벤트 ID가 아니다(키움 HHMMSS는 같은 초에 여러 체결/호가를 보낸다).
 * 같은 payload가 반복된 개수만큼만 REST/WS 겹침을 제거한다. 서로 다른 프레임과
 * 동일한 체결의 반복은 보존하고, 같은 시각에서는 현재 WS 상태가 마지막에 온다.
 */
function mergeInitial(current: readonly RawSnapshot[], initial: readonly RawSnapshot[]): RawSnapshot[] {
  if (!current.length) return [...initial];
  if (!initial.length) return [...current];
  const counts = new Map<string, number>();
  for (const frame of current) {
    const key = frameKey(frame);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const missing = initial.filter((frame) => {
    const key = frameKey(frame);
    const count = counts.get(key) ?? 0;
    if (!count) return true;
    counts.set(key, count - 1);
    return false;
  });
  return [...missing, ...current].sort((a, b) => a.t_ms - b.t_ms);
}

type View = { raw: Raw; filtered: Raw; frames: Frames; lastOb?: ObSnapshot };

class SharedSeries {
  private buffer = new LiveSnapshotBuffer();
  private raw: Raw = EMPTY_RAW;
  private views = new Map<LiveVenueOption, View>();
  private hydrated = new WeakSet<LiveSeriesResponse>();
  private served = new Map<LiveVenueOption, ObSnapshot | undefined>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  readonly listeners = new Set<() => void>();

  start(code: string): void {
    this.unsubscribe = subscribeLive(code, (entry) => {
      this.buffer.push(entry);
      if (this.timer === null) this.timer = setTimeout(() => this.publish(), LIVE_FLUSH_MS);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    if (this.timer !== null) clearTimeout(this.timer);
  }

  private publish(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.raw = {
      ob: this.buffer.get('ob'), trade: this.buffer.get('trade'), broker: this.buffer.get('broker'),
      program: this.buffer.get('program'), ah: this.buffer.get('ah'), expected: this.buffer.get('expected'),
    };
    for (const listener of [...this.listeners]) listener();
  }

  hydrate(initial: LiveSeriesResponse, venue: LiveVenueOption): void {
    const served = (initial.last_ob ?? undefined) as ObSnapshot | undefined;
    const fresh = !this.hydrated.has(initial);
    if (!fresh && this.served.get(venue) === served) return;
    this.served.set(venue, served);
    if (fresh) {
      this.hydrated.add(initial);
      const data = {
        ob: initial.snapshots, trade: initial.trades, broker: initial.brokers,
        program: initial.programs ?? [], ah: initial.after_hours ?? [], expected: initial.expected ?? [],
      };
      const merged: Partial<Record<SnapshotKind, RawSnapshot[]>> = {};
      for (const kind of KINDS) {
        // REST의 자유 형식 payload는 kind별 버퍼 경계에서만 좁힌다.
        merged[kind] = mergeInitial(this.buffer.get(kind), data[kind] as RawSnapshot[]);
      }
      this.buffer.hydrate(merged);
    }
    this.publish();
  }

  read(venue: LiveVenueOption): Frames {
    const prev = this.views.get(venue);
    if (prev?.raw === this.raw) return prev.frames;
    const filtered = { ...EMPTY_RAW };
    for (const kind of KINDS) {
      if (prev && prev.raw[kind] === this.raw[kind]) {
        filtered[kind] = prev.filtered[kind];
      } else {
        const rows = this.raw[kind].filter((f) => liveVenueAcceptsFrame(venue, f.venue as LiveFrameVenue | undefined));
        filtered[kind] = prev && sameFrames(prev.filtered[kind], rows) ? prev.filtered[kind] : rows;
      }
    }
    // 수집기가 만든 kind별 wire shape를 이 경계에서만 좁힌다(liveSeries의 기존 계약).
    const obRows = filtered.ob as readonly ObSnapshot[];
    const lastOb = obRows.length ? obRows[obRows.length - 1] : prev?.lastOb;
    const fallback = pickLastKnownOb(lastOb, this.served.get(venue));
    let ob = obRows;
    if (!ob.length && fallback && liveVenueAcceptsFrame(venue, fallback.venue)) {
      ob = prev?.frames.ob.length === 1 && prev.frames.ob[0] === fallback ? prev.frames.ob : [fallback];
    }
    let frames: Frames = { ob, trade: filtered.trade as readonly TradeSnapshot[], broker: filtered.broker, program: filtered.program,
      afterHours: filtered.ah, expected: filtered.expected };
    if (prev && Object.keys(frames).every((k) => frames[k as keyof Frames] === prev.frames[k as keyof Frames])) {
      frames = prev.frames;
    }
    this.views.set(venue, { raw: this.raw, filtered, frames, lastOb });
    return frames;
  }
}

const entries = new Map<string, SharedSeries>();
const keyFor = (code: string, date: string) => `${date}:${code}`;

export function subscribeLiveSeries(code: string, date: string, listener: () => void): () => void {
  if (!code) return () => {};
  const key = keyFor(code, date);
  let entry = entries.get(key);
  if (!entry) {
    entry = new SharedSeries();
    entries.set(key, entry);
    entry.start(code);
  }
  // 같은 callback을 두 번 구독해도 한 cleanup이 다른 구독을 없애지 않게 감싼다.
  const notify = () => listener();
  entry.listeners.add(notify);
  return () => {
    entry.listeners.delete(notify);
    if (!entry.listeners.size) {
      entry.stop();
      if (entries.get(key) === entry) entries.delete(key);
    }
  };
}

export function readLiveSeries(code: string, date: string, venue: LiveVenueOption): Frames {
  return entries.get(keyFor(code, date))?.read(venue) ?? EMPTY_FRAMES;
}

export function hydrateLiveSeries(code: string, date: string, venue: LiveVenueOption, initial: LiveSeriesResponse): void {
  if (initial.code === code) entries.get(keyFor(code, date))?.hydrate(initial, venue);
}
