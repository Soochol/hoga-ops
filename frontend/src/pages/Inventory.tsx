import { useEffect, useMemo, useState } from 'react';
import { useStockDates } from '../api/stock-dates';
import { StockDateGroupList } from '../inventory/StockDateGroupList';
import { StockDateGroupDetail } from '../inventory/StockDateGroupDetail';
import { useStockDateGroups, selectGroup } from '../inventory/useStockDateGroups';
import { PageContainer } from '../layout/PageContainer';
import { PageState } from '../ui/PageShell';

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
    return (
      <PageContainer>
        <PageState>Loading inventory…</PageState>
      </PageContainer>
    );
  }
  if (rows.length === 0) {
    return (
      <PageContainer>
        <PageState>캡처된 데이터가 없습니다.</PageState>
      </PageContainer>
    );
  }

  return (
    <PageContainer
      className="grid gap-md"
      style={{ gridTemplateColumns: 'var(--sidebar-w) 1fr' }}
    >
      <StockDateGroupList rows={rows} selectedCode={selectedCode} onSelect={setSelectedCode} />
      <StockDateGroupDetail group={selectedGroup} />
    </PageContainer>
  );
}
