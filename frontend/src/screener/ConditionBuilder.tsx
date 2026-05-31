import { useState } from 'react';
import type { ConditionLeaf, ConditionType, ScreenerUniverse } from '../api/screener';
import { CONDITION_CATALOG, CONDITION_ORDER, makeLeaf } from './catalog';
import { ConditionRow } from './ConditionRow';
import { SectionLabel } from './paramForms';

const MARKETS = ['KOSPI', 'KOSDAQ'] as const;

export function ConditionBuilder({ conditions, universe, onConditionsChange, onUniverseChange }: {
  conditions: ConditionLeaf[]; universe: ScreenerUniverse;
  onConditionsChange: (c: ConditionLeaf[]) => void; onUniverseChange: (u: ScreenerUniverse) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const add = (t: ConditionType) => { onConditionsChange([...conditions, makeLeaf(t)]); setMenuOpen(false); };
  const replace = (id: string, next: ConditionLeaf) => onConditionsChange(conditions.map((c) => c.id === id ? next : c));
  const remove = (id: string) => onConditionsChange(conditions.filter((c) => c.id !== id));

  const markets = universe.markets ?? [];
  const toggleMarket = (m: (typeof MARKETS)[number]) => {
    const next = markets.includes(m) ? markets.filter((x) => x !== m) : [...markets, m];
    onUniverseChange({ ...universe, markets: next.length ? next : undefined });
  };

  return (
    <div className="bg-bg-card border rounded-lg p-md flex flex-col gap-sm min-h-0 overflow-auto">
      <div className="relative">
        <button type="button" aria-label="조건 추가" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}
          className="w-full border border-dashed border-border-strong rounded-md text-fg-dim text-sm py-2 hover:bg-bg-input-hover">
          ＋ 조건 추가 ▾
        </button>
        {menuOpen && (
          <ul role="menu" className="absolute z-10 mt-1 w-full bg-bg-subtle border border-border-strong rounded-md shadow-lg overflow-hidden">
            {CONDITION_ORDER.map((t) => (
              <li key={t}><button type="button" role="menuitem" aria-label={CONDITION_CATALOG[t].label} onClick={() => add(t)}
                className="w-full text-left px-3 py-2 text-sm text-fg hover:bg-bg-input-hover">{CONDITION_CATALOG[t].label}</button></li>
            ))}
          </ul>
        )}
      </div>

      {conditions.length > 0 && (
        <div className="text-[10px] tracking-[0.06em] text-fg-dimmer text-center">모두 충족 · AND</div>
      )}
      {conditions.map((leaf) => (
        <ConditionRow key={leaf.id} leaf={leaf} onChange={(n) => replace(leaf.id, n)} onRemove={() => remove(leaf.id)} />
      ))}

      <div className="mt-auto pt-md border-t flex flex-col gap-sm">
        <SectionLabel>전역 사전필터</SectionLabel>
        <div className="flex gap-px p-[2px] bg-bg-input rounded-md w-fit">
          {MARKETS.map((m) => {
            const active = markets.includes(m);
            return <button key={m} type="button" aria-label={m} aria-pressed={active} onClick={() => toggleMarket(m)}
              className={`px-2.5 py-[0.15rem] rounded-sm font-mono text-xs transition-colors ${active ? 'bg-accent text-accent-fg' : 'text-fg-dim hover:bg-bg-input-hover'}`}>{m}</button>;
          })}
        </div>
        <label className="flex items-center gap-2 text-sm text-fg cursor-pointer select-none">
          <input type="checkbox" checked={!!universe.exclude_etf}
            onChange={(e) => onUniverseChange({ ...universe, exclude_etf: e.target.checked || undefined })}
            className="accent-[var(--accent)]" />ETF 제외</label>
        <label className="flex items-center gap-2 text-sm text-fg cursor-pointer select-none">
          <input type="checkbox" checked={!!universe.exclude_halted}
            onChange={(e) => onUniverseChange({ ...universe, exclude_halted: e.target.checked || undefined })}
            className="accent-[var(--accent)]" />거래정지 제외</label>
      </div>
    </div>
  );
}
