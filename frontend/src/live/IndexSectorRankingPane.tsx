import { useMemo, useReducer } from 'react';
import type { ReactNode } from 'react';
import type { BasisMode } from './indexSectorRankingState';
import {
  initialIndexSectorRankingUiState,
  reduceIndexSectorRankingState,
  sectorIdentityKey,
  resolveActiveSectorId,
} from './indexSectorRankingState';
import type {
  IndexSectorRankingResponse,
  IndexSectorRankingSector,
  IndexSectorRankingStock,
} from '../api/indexSectorRankings';

interface Props {
  basisDate: string | null;
  basisMode: BasisMode;
  ranking: IndexSectorRankingResponse | undefined;
  isLoading: boolean;
  error: unknown;
  onClearDatePin: () => void;
  onOpenStock: (code: string, name: string) => void;
}

function formatDate(date: string | null): string {
  if (!date || date.length !== 8) return '날짜 없음';
  return `${date.slice(0, 4)}/${date.slice(4, 6)}/${date.slice(6, 8)}`;
}

function formatPct(value: number | null): string {
  if (value === null) return '-';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function priceColor(value: number | null): string {
  if (value === null || value === 0) return 'var(--fg-dim)';
  return value > 0 ? 'var(--price-up)' : 'var(--price-down)';
}

function sectorButtonLabel(rank: number, sector: IndexSectorRankingSector): string {
  return `${rank}위 ${sector.folder_name} ${formatPct(sector.change_pct)}`;
}

function stockButtonLabel(stock: IndexSectorRankingStock): string {
  return `${stock.name} ${stock.code} ${formatPct(stock.change_pct)}`;
}

function SectorButton({
  sector,
  rank,
  active,
  onPreview,
  onPin,
}: {
  sector: IndexSectorRankingSector;
  rank: number;
  active: boolean;
  onPreview: (sectorKey: string | null) => void;
  onPin: (sectorKey: string | null) => void;
}) {
  return (
    <button
      type="button"
      aria-label={sectorButtonLabel(rank, sector)}
      aria-pressed={active}
      onMouseEnter={() => onPreview(sectorIdentityKey(sector.folder_id))}
      onMouseLeave={() => onPreview(null)}
      onFocus={() => onPreview(sectorIdentityKey(sector.folder_id))}
      onBlur={() => onPreview(null)}
      onClick={() => onPin(sectorIdentityKey(sector.folder_id))}
      className="grid w-full items-center text-left"
      style={{
        gridTemplateColumns: '32px minmax(0, 1fr) 72px',
        gap: 'var(--space-sm)',
        minHeight: 32,
        padding: 'var(--space-xs) var(--space-sm)',
        border: active ? '1px solid var(--accent)' : '1px solid transparent',
        background: active ? 'var(--tint-selection)' : 'transparent',
        color: 'var(--fg)',
      }}
    >
      <span className="font-mono text-xs" style={{ color: 'var(--fg-dimmer)' }}>
        {rank}
      </span>
      <span className="truncate font-ui text-sm">{sector.folder_name}</span>
      <span className="font-mono text-xs text-right" style={{ color: priceColor(sector.change_pct) }}>
        {formatPct(sector.change_pct)}
      </span>
    </button>
  );
}

function StockButton({
  stock,
  rank,
  onOpenStock,
}: {
  stock: IndexSectorRankingStock;
  rank: number;
  onOpenStock: (code: string, name: string) => void;
}) {
  return (
    <button
      type="button"
      aria-label={stockButtonLabel(stock)}
      onClick={() => onOpenStock(stock.code, stock.name)}
      className="grid w-full items-center text-left"
      style={{
        gridTemplateColumns: '32px minmax(0, 1fr) 72px',
        gap: 'var(--space-sm)',
        minHeight: 30,
        padding: 'var(--space-xs) var(--space-sm)',
        color: 'var(--fg)',
      }}
    >
      <span className="font-mono text-xs" style={{ color: 'var(--fg-dimmer)' }}>
        {rank}
      </span>
      <span className="truncate font-ui text-sm">{stock.name}</span>
      <span className="font-mono text-xs text-right" style={{ color: priceColor(stock.change_pct) }}>
        {formatPct(stock.change_pct)}
      </span>
    </button>
  );
}

export function IndexSectorRankingPane({
  basisDate,
  basisMode,
  ranking,
  isLoading,
  error,
  onClearDatePin,
  onOpenStock,
}: Props) {
  const [state, dispatch] = useReducer(
    reduceIndexSectorRankingState,
    initialIndexSectorRankingUiState,
  );

  const sectors = ranking?.sectors ?? [];
  const activeSectorId = resolveActiveSectorId(sectors, state);

  const activeSector = useMemo(
    () => sectors.find((sector) => sectorIdentityKey(sector.folder_id) === activeSectorId) ?? sectors[0] ?? null,
    [activeSectorId, sectors],
  );

  let body: ReactNode = null;
  if (isLoading) {
    body = <div className="p-md text-sm text-fg-dimmer">섹터 랭킹을 불러오는 중입니다.</div>;
  } else if (error) {
    body = (
      <div className="p-md text-sm" style={{ color: 'var(--danger)' }}>
        섹터 랭킹을 불러오지 못했습니다.
      </div>
    );
  } else if (ranking?.source === 'unavailable') {
    body = <div className="p-md text-sm text-fg-dimmer">일봉 랭킹 데이터를 사용할 수 없습니다.</div>;
  } else if (sectors.length === 0) {
    body = <div className="p-md text-sm text-fg-dimmer">히트맵 섹터가 없습니다.</div>;
  } else {
    body = (
      <div
        className="grid min-h-0 flex-1"
        style={{ gridTemplateColumns: 'minmax(180px, 1fr) minmax(0, 2fr)' }}
      >
        <div className="min-h-0 overflow-auto" style={{ borderRight: '1px solid var(--border)' }}>
          {sectors.map((sector, index) => {
            return (
              <SectorButton
                key={sector.folder_id ?? `sector-${index}`}
                sector={sector}
                rank={index + 1}
                active={sectorIdentityKey(sector.folder_id) === activeSectorId}
                onPreview={(sectorKey) => dispatch({ type: 'preview_sector', sectorKey })}
                onPin={(sectorKey) => dispatch({ type: 'toggle_sector_pin', sectorKey })}
              />
            );
          })}
        </div>

        <div className="min-h-0 overflow-auto">
          {(activeSector?.stocks ?? []).map((stock, index) => (
            <StockButton key={stock.code} stock={stock} rank={index + 1} onOpenStock={onOpenStock} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <section
      data-testid="index-sector-ranking-pane"
      className="flex min-h-0 flex-col"
      style={{
        height: 220,
        borderTop: '1px solid var(--border)',
        background: 'var(--bg)',
      }}
    >
      <div
        className="flex items-center gap-sm"
        style={{
          minHeight: 34,
          padding: '0 var(--space-sm)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <span className="font-ui text-sm" style={{ color: 'var(--fg)' }}>
          {formatDate(basisDate)} 기준 · {basisMode === 'pinned' ? '날짜 고정' : basisMode}
        </span>
        {basisMode === 'pinned' && (
          <button
            type="button"
            className="ml-auto text-xs text-fg-dimmer"
            onClick={onClearDatePin}
          >
            고정 해제
          </button>
        )}
      </div>
      {body}
    </section>
  );
}
