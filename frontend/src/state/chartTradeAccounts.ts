import { create } from 'zustand';
import { persistJson, readJsonObject } from './persist';

const KEY = 'hoga.chart.trade.accounts.v1';
const validRef = (value: unknown): value is string => typeof value === 'string' && /^acc_[a-f0-9]{32}$/.test(value);
const raw = readJsonObject(KEY);
const byWindow: Record<string, string> = Object.fromEntries(Object.entries(raw?.byWindow ?? {})
  .filter(([id, ref]) => id && !['__proto__', 'constructor', 'prototype'].includes(id) && validRef(ref)).slice(-1024));

/** Account identity is remembered per window, independently of display presets/new-window defaults. */
export const useChartTradeAccounts = create<{
  byWindow: Record<string, string>;
  select: (windowId: string, accountRef: string) => void;
}>((set) => ({
  byWindow,
  select: (windowId, accountRef) => {
    if (!windowId || ['__proto__', 'constructor', 'prototype'].includes(windowId) || (accountRef && !validRef(accountRef))) return;
    set(state => {
      const next = { ...state.byWindow };
      delete next[windowId];
      if (accountRef) next[windowId] = accountRef;
      const bounded = Object.fromEntries(Object.entries(next).slice(-1024));
      persistJson(KEY, { schema_version: 1, byWindow: bounded });
      return { byWindow: bounded };
    });
  },
}));
