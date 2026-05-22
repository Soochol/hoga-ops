import { useState, useEffect, useRef } from 'react';
import { useSymbols, useSymbolSearch } from './useSymbols';
import type { SymbolHit, SymbolsCacheStatus } from '../api/types';

export interface SymbolSearchProps {
  value: SymbolHit | null;
  onChange: (hit: SymbolHit | null) => void;
}

const STATUS_LABEL: Record<SymbolsCacheStatus, string> = {
  loading: '⏳',
  fresh: '●',
  stale: '⏱',
  unavailable: '!',
};
const STATUS_COLOR: Record<SymbolsCacheStatus, string> = {
  loading: 'var(--fg-dim)',
  fresh: 'var(--up)',
  stale: 'var(--warn)',
  unavailable: 'var(--down)',
};

export function SymbolSearch({ value, onChange }: SymbolSearchProps) {
  const { data } = useSymbols();
  const cacheStatus: SymbolsCacheStatus = data?.status ?? 'loading';
  const [text, setText] = useState(value ? `${value.name} ${value.code}` : '');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const query = text.trim();
  const hits = useSymbolSearch(query, 20);
  // F3 (design review): explicit empty-state dropdown when query has chars but
  // no matches. Without this, users wonder if their input is broken.
  const dropdownVisible = open && query.length >= 1 && cacheStatus !== 'unavailable';
  const isEmpty = dropdownVisible && hits.length === 0;

  useEffect(() => { setHighlight(0); }, [query]);
  // Sync displayed text when parent resets selection (e.g. form reset after Start).
  useEffect(() => {
    if (value === null) setText('');
    else setText(`${value.name} ${value.code}`);
  }, [value]);

  const select = (hit: SymbolHit) => {
    onChange(hit);
    setText(`${hit.name} ${hit.code}`);
    setOpen(false);
  };

  // BUG-001 fallback: when the symbol cache is unavailable (KRX auth missing,
  // network blip, etc.), the user is told to enter a 6-digit code directly —
  // but the dropdown is gated off, so there's no way to commit the typed code
  // to a SymbolHit. Enter key promotes a 6-digit numeric query to a placeholder
  // SymbolHit. name='—' marks it as unverified; the form proceeds.
  const promoteUnverifiedCode = () => {
    if (cacheStatus !== 'unavailable') return false;
    if (!/^\d{6}$/.test(query)) return false;
    select({
      code: query,
      name: '—',
      market: 'KOSPI',
      captured_count: 0,
      captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0 },
    });
    return true;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      if (dropdownVisible && hits.length > 0) {
        e.preventDefault();
        select(hits[highlight]);
        return;
      }
      if (promoteUnverifiedCode()) {
        e.preventDefault();
        return;
      }
    }
    if (!dropdownVisible) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, hits.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Escape') { setOpen(false); }
  };

  return (
    <div style={{ position: 'relative', fontFamily: 'Geist Sans, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={(e) => { setText(e.target.value); setOpen(true); onChange(null); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="종목명 또는 6자리 코드"
          style={{
            flex: 1,
            background: 'var(--bg-input)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            color: 'var(--fg)',
            padding: '8px 10px',
            fontSize: 13,
          }}
        />
        <span
          data-testid="symbol-cache-status"
          data-status={cacheStatus}
          title={`Symbols cache: ${cacheStatus}`}
          style={{ color: STATUS_COLOR[cacheStatus], fontSize: 14, lineHeight: 1 }}
        >
          {STATUS_LABEL[cacheStatus]}
        </span>
      </div>
      {cacheStatus === 'unavailable' && (
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--fg-dim)' }}>
          종목 목록 미가용 — 6자리 코드 입력 후 <kbd style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 3, padding: '0 4px', fontFamily: 'inherit' }}>Enter</kbd> 로 확정.
        </div>
      )}
      {dropdownVisible && (
        <div
          role="listbox"
          style={{
            position: 'absolute', zIndex: 10,
            top: '100%', left: 0, right: 0, marginTop: 4,
            background: 'var(--bg-card)',
            border: '1px solid var(--border-strong)',
            borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            maxHeight: 320, overflowY: 'auto',
          }}
        >
          {isEmpty ? (
            // F3: empty state — tells the user the input is processed but matched nothing.
            <div style={{
              padding: '12px 10px',
              font: '400 12px "Geist Sans", sans-serif',
              color: 'var(--fg-dim)',
            }}>
              검색 결과가 없습니다. 종목명 또는 6자리 코드를 확인하세요.
            </div>
          ) : (
            hits.map((h, i) => (
              <SymbolRow key={h.code} hit={h} highlighted={i === highlight} onClick={() => select(h)} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function SymbolRow({ hit, highlighted, onClick }: { hit: SymbolHit; highlighted: boolean; onClick: () => void }) {
  const breakdown = `Complete ${hit.captured_breakdown.complete} · Partial ${hit.captured_breakdown.source_partial} · Incomplete ${hit.captured_breakdown.client_incomplete}`;
  const countText = hit.captured_count > 0 ? `${hit.captured_count} complete` : 'no complete data';
  return (
    <div
      role="option"
      aria-selected={highlighted}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      style={{
        padding: '8px 10px',
        background: highlighted ? 'rgba(20,184,166,0.10)' : 'transparent',
        display: 'grid',
        gridTemplateColumns: '1fr auto auto auto',
        gap: 10,
        alignItems: 'center',
        cursor: 'pointer',
      }}
    >
      <span style={{ font: '400 13px "Geist Sans", sans-serif', color: 'var(--fg)' }}>{hit.name}</span>
      <span style={{ font: '500 11px "Geist Mono", monospace', color: 'var(--fg-dim)', fontVariantNumeric: 'tabular-nums' }}>{hit.code}</span>
      <span style={{
        border: '1px solid var(--border-strong)', borderRadius: 4, padding: '0 4px',
        font: '600 8.5px "Geist Sans", sans-serif', letterSpacing: '0.06em',
        color: 'var(--fg-dim)',
      }}>{hit.market}</span>
      <span
        title={breakdown}
        style={{
          font: '500 10px "Geist Mono", monospace',
          color: hit.captured_count > 0 ? 'var(--accent)' : 'var(--fg-dimmer)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {countText}
      </span>
    </div>
  );
}
