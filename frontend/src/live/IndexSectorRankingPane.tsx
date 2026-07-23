import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { BasisMode } from './indexSectorRankingState';
import type { JumpModifiers } from './useJumpToLive';
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
  onOpenStock: (code: string, name: string, e?: JumpModifiers) => void;
  /**
   * 레이아웃 변형.
   * - `docked`(기본): 차트 하단 도킹 — 자체 높이 상태 + 상단 리사이즈 핸들(구 LiveWorkarea).
   * - `fill`: 워크스페이스 데이터 창 채우기 — WindowFrame 이 크기를 소유하므로
   *   자체 높이/핸들 없이 100% 채운다(ADR-0119 PR-D 섹터랭킹 창).
   */
  variant?: 'docked' | 'fill';
}

const DEFAULT_PANE_HEIGHT = 220;
const MIN_PANE_HEIGHT = 140;
const MAX_PANE_HEIGHT = 520;
const PANE_HEIGHT_STORAGE_KEY = 'live.indexSectorRankingPane.v1';

function clampPaneHeight(value: number): number {
  return Math.min(MAX_PANE_HEIGHT, Math.max(MIN_PANE_HEIGHT, value));
}

function readStoredPaneHeight(): number {
  if (typeof window === 'undefined') return DEFAULT_PANE_HEIGHT;
  const raw = window.localStorage.getItem(PANE_HEIGHT_STORAGE_KEY);
  if (raw === null) return DEFAULT_PANE_HEIGHT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_PANE_HEIGHT;
  return clampPaneHeight(parsed);
}

function writeStoredPaneHeight(value: number): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(PANE_HEIGHT_STORAGE_KEY, String(value));
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
      <span className="font-data text-xs" style={{ color: 'var(--fg-dimmer)' }}>
        {rank}
      </span>
      <span className="truncate font-ui text-sm">{sector.folder_name}</span>
      <span className="font-data text-xs text-right" style={{ color: priceColor(sector.change_pct) }}>
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
  onOpenStock: (code: string, name: string, e?: JumpModifiers) => void;
}) {
  return (
    <button
      type="button"
      aria-label={stockButtonLabel(stock)}
      onClick={(e) => onOpenStock(stock.code, stock.name, e)}
      className="grid w-full items-center text-left"
      style={{
        gridTemplateColumns: '32px minmax(0, 1fr) 72px',
        gap: 'var(--space-sm)',
        minHeight: 30,
        padding: 'var(--space-xs) var(--space-sm)',
        color: 'var(--fg)',
      }}
    >
      <span className="font-data text-xs" style={{ color: 'var(--fg-dimmer)' }}>
        {rank}
      </span>
      <span className="truncate font-ui text-sm">{stock.name}</span>
      <span className="font-data text-xs text-right" style={{ color: priceColor(stock.change_pct) }}>
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
  variant = 'docked',
}: Props) {
  const [state, dispatch] = useReducer(
    reduceIndexSectorRankingState,
    initialIndexSectorRankingUiState,
  );
  const [height, setHeight] = useState(readStoredPaneHeight);
  const resizeStartRef = useRef<{ y: number; height: number } | null>(null);

  const startResize = useCallback((clientY: number) => {
    resizeStartRef.current = { y: clientY, height };
  }, [height]);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      const start = resizeStartRef.current;
      if (!start) return;
      setHeight(() => {
        const next = clampPaneHeight(start.height + start.y - event.clientY);
        writeStoredPaneHeight(next);
        return next;
      });
    };
    const handleMouseUp = () => {
      resizeStartRef.current = null;
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

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

  const fill = variant === 'fill';

  return (
    <section
      data-testid="index-sector-ranking-pane"
      className="flex min-h-0 flex-col"
      style={{
        // fill: WindowFrame 이 크기를 소유 → 100% 채움. docked: 자체 높이 상태.
        height: fill ? '100%' : height,
        // fill 은 창 자체 테두리가 있어 상단 구분선 불필요.
        borderTop: fill ? undefined : '1px solid var(--border)',
        // fill(워크스페이스 데이터 창)은 다른 창과 동일하게 --bg-card(테마 카드색).
        // flat 창 프레임(--bg)이 비쳐 회색으로 갈리던 것을 통일. docked 는 유지.
        background: fill ? 'var(--bg-card)' : 'var(--bg)',
      }}
    >
      {!fill && (
        <div
          role="separator"
          aria-label="섹터 랭킹 높이 조절"
          aria-orientation="horizontal"
          aria-valuemin={MIN_PANE_HEIGHT}
          aria-valuemax={MAX_PANE_HEIGHT}
          aria-valuenow={height}
          tabIndex={0}
          onMouseDown={(event) => {
            event.preventDefault();
            startResize(event.clientY);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowUp') {
              setHeight((current) => {
                const next = clampPaneHeight(current + 20);
                writeStoredPaneHeight(next);
                return next;
              });
              event.preventDefault();
            } else if (event.key === 'ArrowDown') {
              setHeight((current) => {
                const next = clampPaneHeight(current - 20);
                writeStoredPaneHeight(next);
                return next;
              });
              event.preventDefault();
            }
          }}
          style={{
            height: 8,
            cursor: 'ns-resize',
            display: 'grid',
            placeItems: 'center',
            color: 'var(--fg-dimmer)',
            background: 'var(--bg)',
            flexShrink: 0,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 36,
              height: 3,
              borderTop: '1px solid var(--border-strong)',
              borderBottom: '1px solid var(--border-strong)',
            }}
          />
        </div>
      )}
      <div
        className="flex items-center gap-sm"
        style={{
          minHeight: 34,
          padding: '0 var(--space-sm)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <span className="font-ui text-sm" style={{ color: 'var(--fg)' }}>
          {formatDate(basisDate)} 기준 · {basisMode === 'pinned' ? '날짜 고정' : basisMode === 'latest' ? '최신' : basisMode}
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
