// frontend/src/chart/drawing/duplicate.ts
//
// Duplicate a drawing with a small offset (Ctrl/Cmd+D). The pixel→data offset
// is computed by the overlay (it owns the coordinate closures); this module
// owns the pure parts: a representative anchor to offset from, and the clone
// itself (new id + translated geometry).

import { nanoid } from 'nanoid';
import type { Drawing } from './types';
import { translateDrawing, type TimeShift } from './translate';

/** A representative (realMs, price) to derive the pixel offset from. Either
 *  coordinate may be null for shapes that lack it (hline has no time, vline no
 *  price) — the caller then leaves that axis's delta at 0. */
export function refCoords(d: Drawing): { realMs: number | null; price: number | null } {
  switch (d.kind) {
    case 'hline':
      return { realMs: null, price: d.price };
    case 'vline':
      return { realMs: d.realMs, price: null };
    case 'trendline':
    case 'rect':
    case 'measure':
      return { realMs: d.a.realMs, price: d.a.price };
    case 'text':
      return { realMs: d.at.realMs, price: d.at.price };
    case 'pencil':
      return { realMs: d.points[0]?.realMs ?? null, price: d.points[0]?.price ?? null };
  }
}

/** Clone `d` shifted by (dMs, dPrice) with a fresh id. Reuses translateDrawing
 *  so every kind's geometry moves consistently. `dMs` takes the function form
 *  for gap-aware virtual-domain shifts (see TimeShift): a flat real-ms offset
 *  computed off the ref vertex would strand the OTHER vertices inside an
 *  inter-session gap whenever the ref's +14px crosses a session boundary. */
export function cloneWithOffset(d: Drawing, dMs: TimeShift, dPrice: number): Drawing {
  return { ...d, ...translateDrawing(d, dMs, dPrice), id: nanoid(8) } as Drawing;
}
