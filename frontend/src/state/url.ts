import type { TabSelection } from './tabs';

export type ParsedReplayUrl = { tabs: TabSelection[]; active: number };

/**
 * Parse the `?tabs=...&active=N` part of a URL search string.
 * Bad entries are silently dropped (they are a UI mistake, not a system error).
 * If `?tabs=` is missing or empty, returns { tabs: [], active: 0 }.
 */
export function parseReplayUrl(search: string): ParsedReplayUrl {
  const sp = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const raw = sp.get('tabs');
  const activeRaw = sp.get('active');
  if (!raw) return { tabs: [], active: 0 };
  const tabs: TabSelection[] = [];
  for (const segment of raw.split(',')) {
    const [code, fromDate, toDate] = segment.split(':');
    if (!isValidCode(code) || !isValidDate(fromDate) || !isValidDate(toDate)) continue;
    tabs.push({ code, fromDate, toDate });
  }
  let active = Number(activeRaw);
  if (!Number.isFinite(active) || active < 0 || active >= tabs.length) active = 0;
  return { tabs, active };
}

/** Build `?tabs=...&active=N` from the current selections + active index. */
export function emitReplayUrl(tabs: (TabSelection | null)[], activeIdx: number): string {
  const real = tabs.filter((t): t is TabSelection => !!t);
  if (real.length === 0) return '';
  // Find the active index AMONG REAL TABS (skip empty tabs)
  let realActive = 0;
  let realCount = 0;
  for (let i = 0; i < tabs.length; i++) {
    if (!tabs[i]) continue;
    if (i === activeIdx) {
      realActive = realCount;
      break;
    }
    realCount += 1;
  }
  const tabStr = real.map((t) => `${t.code}:${t.fromDate}:${t.toDate}`).join(',');
  return `?tabs=${tabStr}&active=${realActive}`;
}

function isValidCode(s: unknown): s is string {
  return typeof s === 'string' && /^\d{6}$/.test(s);
}
function isValidDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{8}$/.test(s);
}
