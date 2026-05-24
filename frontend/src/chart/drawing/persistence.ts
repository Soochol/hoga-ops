// frontend/src/chart/drawing/persistence.ts
import type { Drawing } from './types';

const PREFIX = 'replay.drawings.v1.';
const VERSION = 1;

export function storageKey(code: string): string {
  return `${PREFIX}${code}`;
}

type Wrapper = { v: number; items: unknown };

export function loadDrawings(code: string): Drawing[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(storageKey(code));
  } catch {
    return [];
  }
  if (raw == null) return [];
  let parsed: Wrapper;
  try {
    parsed = JSON.parse(raw) as Wrapper;
  } catch {
    return [];
  }
  if (parsed == null || parsed.v !== VERSION) return [];
  if (!Array.isArray(parsed.items)) return [];
  // Trust the in-payload shape (own writer). v1 readers do not validate
  // every Drawing field — that would couple persistence to types.ts.
  return parsed.items as Drawing[];
}

export function saveDrawings(code: string, items: Drawing[]): void {
  const wrapper: Wrapper = { v: VERSION, items };
  try {
    localStorage.setItem(storageKey(code), JSON.stringify(wrapper));
  } catch {
    // Quota exceeded or storage unavailable — ignore. Drawings remain in
    // memory; user simply loses them on reload.
  }
}
