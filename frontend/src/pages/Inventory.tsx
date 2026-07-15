import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useStockDates } from '../api/stock-dates';
import { StockDateGroupList } from '../inventory/StockDateGroupList';
import { StockDateGroupDetail } from '../inventory/StockDateGroupDetail';
import { useStockDateGroups, selectGroup } from '../inventory/useStockDateGroups';
import { PageContainer } from '../layout/PageContainer';
import { PageState, PanelCard } from '../ui/PageShell';

function InventoryStateShell({ children }: { children: ReactNode }) {
  return (
    <PageContainer className="grid grid-cols-[minmax(0,42rem)] content-start">
      <PanelCard borderless data-testid="inventory-page-primary">
        <PageState>{children}</PageState>
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
    return <InventoryStateShell>Loading inventory…</InventoryStateShell>;
  }
  if (rows.length === 0) {
    return <InventoryStateShell>캡처된 데이터가 없습니다.</InventoryStateShell>;
  }

  return (
    <PageContainer
      className="grid gap-md"
      style={{ gridTemplateColumns: 'var(--sidebar-w) 1fr' }}
    >
      <PanelCard borderless data-testid="inventory-list-pane" className="flex min-h-0 flex-col overflow-hidden">
        <StockDateGroupList rows={rows} selectedCode={selectedCode} onSelect={setSelectedCode} />
      </PanelCard>
      <PanelCard borderless data-testid="inventory-detail-pane" className="flex min-h-0 flex-col overflow-hidden">
        <StockDateGroupDetail group={selectedGroup} />
      </PanelCard>
    </PageContainer>
  );
}
