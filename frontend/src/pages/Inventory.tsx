import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useStockDates } from '../api/stock-dates';
import { StockDateGroupList } from '../inventory/StockDateGroupList';
import { StockDateGroupDetail } from '../inventory/StockDateGroupDetail';
import { useStockDateGroups, selectGroup } from '../inventory/useStockDateGroups';
import { PageContainer } from '../layout/PageContainer';
import { PageState, PanelCard } from '../ui/PageShell';

function InventoryStateShell({ children }: { children: ReactNode }) {
  return (
    <PageContainer className="grid grid-cols-[minmax(0,42rem)] content-start !pb-0">
      <PanelCard borderless flat data-testid="inventory-page-primary">
        <PageState>{children}</PageState>
      </PanelCard>
    </PageContainer>
  );
}

/** 로딩 스켈레톤 — 재고 스캔은 실측 ~10초짜리 표면이라 맨 텍스트 한 줄로는 죽은
 *  화면으로 읽힌다. 로드 후와 같은 grid(좌 리스트 / 우 상세)를 미리 그려 완료
 *  시점에 레이아웃 점프가 없게 한다. 막대는 토큰(bg-bg-subtle)만 사용. */
function InventoryLoadingSkeleton() {
  return (
    <PageContainer
      className="grid gap-md !pb-0"
      style={{ gridTemplateColumns: 'var(--sidebar-w) 1fr' }}
    >
      <PanelCard
        borderless
        flat
        data-testid="inventory-loading"
        role="status"
        aria-label="캡처 재고를 불러오는 중"
        className="flex min-h-0 flex-col overflow-hidden"
      >
        <div className="px-sm py-sm text-sm text-fg-dim">캡처 재고를 불러오는 중…</div>
        <div className="animate-pulse motion-reduce:animate-none space-y-sm px-sm" aria-hidden>
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="h-9 rounded bg-bg-subtle" />
          ))}
        </div>
      </PanelCard>
      <PanelCard borderless flat aria-hidden className="flex min-h-0 flex-col overflow-hidden">
        <div className="animate-pulse motion-reduce:animate-none space-y-sm px-sm pt-sm">
          <div className="h-6 w-1/3 rounded bg-bg-subtle" />
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className="h-6 rounded bg-bg-subtle" />
          ))}
        </div>
      </PanelCard>
    </PageContainer>
  );
}

export default function Inventory() {
  const { data: rows = [], isLoading } = useStockDates();
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const unfilteredGroups = useStockDateGroups(rows, '');

  useEffect(() => {
    if (selectedCode !== null || unfilteredGroups.length === 0) return;
    setSelectedCode(unfilteredGroups[0].code);
  }, [unfilteredGroups, selectedCode]);

  // Resolve the detail group here (single owner of default-to-first), so the
  // detail panel takes a ready group instead of re-grouping the same rows.
  const selectedGroup = useMemo(
    () => selectGroup(unfilteredGroups, selectedCode),
    [unfilteredGroups, selectedCode],
  );

  if (isLoading) {
    return <InventoryLoadingSkeleton />;
  }
  if (rows.length === 0) {
    return <InventoryStateShell>캡처된 데이터가 없습니다.</InventoryStateShell>;
  }

  return (
    <PageContainer
      className="grid gap-md !pb-0"
      style={{ gridTemplateColumns: 'var(--sidebar-w) 1fr' }}
    >
      <PanelCard borderless flat data-testid="inventory-list-pane" className="flex min-h-0 flex-col overflow-hidden">
        <StockDateGroupList rows={rows} selectedCode={selectedCode} onSelect={setSelectedCode} />
      </PanelCard>
      <PanelCard borderless flat data-testid="inventory-detail-pane" className="flex min-h-0 flex-col overflow-hidden">
        <StockDateGroupDetail group={selectedGroup} />
      </PanelCard>
    </PageContainer>
  );
}
