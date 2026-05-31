import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSymbols, useSymbolSearch, SYMBOLS_QUERY_KEY } from './useSymbols';
import { useCombobox } from '../util/useCombobox';
import { symbolSearchHints } from '../api/upstream-hints';
import { refreshSymbols } from '../api/symbols';
import type { SymbolHit, SymbolsCacheStatus } from '../api/types';

const STALE_NUDGE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

function formatRelativeShort(ms: number): string {
  const delta = Date.now() - ms;
  const days = Math.floor(delta / 86_400_000);
  if (days < 1) return '오늘';
  return `${days}일 전`;
}

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
  fresh: 'var(--success)',
  stale: 'var(--warn)',
  unavailable: 'var(--error)',
};

export function SymbolSearch({ value, onChange }: SymbolSearchProps) {
  const { data } = useSymbols();
  const queryClient = useQueryClient();
  const cacheStatus: SymbolsCacheStatus = data?.status ?? 'loading';
  const reason = data?.reason ?? null;
  const fetchedAtMs = data?.fetched_at_ms ?? null;
  const isStaleByAge =
    fetchedAtMs !== null && Date.now() - fetchedAtMs > STALE_NUDGE_THRESHOLD_MS;
  const showRefresh = cacheStatus === 'unavailable' || cacheStatus === 'stale';

  const hint = (reason && symbolSearchHints[reason])
    ? symbolSearchHints[reason]
    : (
        <>
          종목 목록 미가용 — 6자리 코드 입력 후{' '}
          <kbd className="bg-bg-input border rounded-md px-xs font-[inherit]">Enter</kbd>{' '}
          로 확정.
        </>
      );

  const handleRefresh = async () => {
    await refreshSymbols();
    await queryClient.invalidateQueries({ queryKey: SYMBOLS_QUERY_KEY });
  };
  const [text, setText] = useState(value ? `${value.name} ${value.code}` : '');

  const query = text.trim();
  const hits = useSymbolSearch(query, 20);

  // Sync displayed text when parent resets selection (e.g. form reset after Start).
  useEffect(() => {
    if (value === null) setText('');
    else setText(`${value.name} ${value.code}`);
  }, [value]);

  const select = (hit: SymbolHit) => {
    onChange(hit);
    setText(`${hit.name} ${hit.code}`);
    combo.setOpen(false);
  };

  const combo = useCombobox<SymbolHit>({
    query: text,
    setQuery: (q) => { setText(q); onChange(null); },
    // Gate items to mirror the original `dropdownVisible` Enter guard: an empty
    // query must not let Enter select hits[0] (filterSymbols('') returns all
    // symbols). When unavailable, hits is already [] so no extra gate is needed.
    // Note: we no longer re-check cacheStatus here (the original `dropdownVisible`
    // gate did) — it's safe because the backend guarantees
    // status === 'unavailable' ⇒ empty symbol cache ⇒ hits === [] (see
    // hoga/api/symbols.py; the disk-cache-masking case surfaces as 'stale', not
    // 'unavailable'). If that invariant ever changes, restore the cacheStatus term.
    items: query.length >= 1 ? hits : [],
    onSelect: (hit) => select(hit),
    onEnterEmpty: () => promoteUnverifiedCode(),
  });
  const { inputRef, wrapperRef } = combo;

  // F3 (design review): explicit empty-state dropdown when query has chars but
  // no matches. Without this, users wonder if their input is broken.
  const dropdownVisible = combo.open && query.length >= 1 && cacheStatus !== 'unavailable';
  const isEmpty = dropdownVisible && hits.length === 0;

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
      captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 },
    });
    return true;
  };

  return (
    <div ref={wrapperRef} className="relative font-ui">
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          {...combo.inputProps}
          placeholder="종목명 또는 6자리 코드"
          className="flex-1 bg-bg-input border rounded-lg text-fg py-sm px-sm text-base"
        />
        <span
          data-testid="symbol-cache-status"
          data-status={cacheStatus}
          title={`Symbols cache: ${cacheStatus}`}
          style={{ color: STATUS_COLOR[cacheStatus] }}
          className="text-sm leading-none"
        >
          {STATUS_LABEL[cacheStatus]}
        </span>
      </div>
      {cacheStatus === 'unavailable' && (
        <div className="mt-1.5 text-xs text-fg-dim">
          <p className="m-0">{hint}</p>
          {showRefresh && (
            <button
              type="button"
              onClick={handleRefresh}
              className="mt-1.5 bg-bg-input border border-border rounded-md px-xs py-0.5 text-fg-dim hover:text-fg cursor-pointer font-[inherit] text-xs"
            >
              Refresh
            </button>
          )}
        </div>
      )}
      {dropdownVisible && (
        <div
          role="listbox"
          style={{ boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}
          className="absolute z-10 top-full left-0 right-0 mt-1 bg-bg-card border-border-strong border rounded-lg max-h-80 overflow-y-auto"
        >
          {isEmpty ? (
            // F3: empty state — tells the user the input is processed but matched nothing.
            <div className="py-md px-sm font-normal text-sm text-fg-dim">
              검색 결과가 없습니다. 종목명 또는 6자리 코드를 확인하세요.
              {isStaleByAge && fetchedAtMs !== null && (
                <div className="mt-2 text-xs text-fg-dimmer">
                  Symbol Master가 {formatRelativeShort(fetchedAtMs)} 업데이트되었습니다 —
                  신규 상장 종목이 누락되었을 수 있습니다.{' '}
                  <a href="/settings" className="underline">설정에서 Update</a>
                </div>
              )}
            </div>
          ) : (
            hits.map((h, i) => (
              <SymbolRow key={h.code} hit={h} highlighted={i === combo.highlightedIndex} onClick={() => select(h)} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function SymbolRow({ hit, highlighted, onClick }: { hit: SymbolHit; highlighted: boolean; onClick: () => void }) {
  const breakdown = `Complete ${hit.captured_breakdown.complete} · Partial ${hit.captured_breakdown.source_partial} · Incomplete ${hit.captured_breakdown.client_incomplete} · Invalid ${hit.captured_breakdown.invalid}`;
  const countText = hit.captured_count > 0 ? `${hit.captured_count} complete` : 'no complete data';
  return (
    <div
      role="option"
      aria-selected={highlighted}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      style={{ background: highlighted ? 'var(--tint-selection)' : 'transparent' }}
      className="grid grid-cols-[1fr_auto_auto_auto] gap-2.5 items-center py-sm px-sm cursor-pointer"
    >
      <span className="font-normal text-base text-fg">{hit.name}</span>
      <span className="font-medium text-sm font-mono text-fg-dim tabular-nums">{hit.code}</span>
      <span className="border border-border-strong rounded-md px-xs font-semibold text-badge tracking-wider text-fg-dim">{hit.market}</span>
      <span
        title={breakdown}
        style={{ color: hit.captured_count > 0 ? 'var(--accent)' : 'var(--fg-dimmer)' }}
        className="font-medium text-xs font-mono tabular-nums"
      >
        {countText}
      </span>
    </div>
  );
}
