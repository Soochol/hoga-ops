import { useEffect, useState } from 'react';
import { useStockDates } from '../api/stock-dates';
import { StockDateGroupList } from '../inventory/StockDateGroupList';
import { StockDateGroupDetail } from '../inventory/StockDateGroupDetail';
import { useStockDateGroups } from '../inventory/useStockDateGroups';
import { PageContainer } from '../layout/PageContainer';

export default function Inventory() {
  const { data: rows = [], isLoading } = useStockDates();
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const unfilteredGroups = useStockDateGroups(rows, '');

  useEffect(() => {
    if (selectedCode !== null || unfilteredGroups.length === 0) return;
    setSelectedCode(unfilteredGroups[0].code);
  }, [unfilteredGroups, selectedCode]);

  if (isLoading) {
    return <div className="p-8 text-fg-dim">Loading inventory…</div>;
  }
  if (rows.length === 0) {
    return <div className="p-8 text-fg-dim">캡처된 데이터가 없습니다.</div>;
  }

  return (
    <PageContainer
      className="grid gap-md"
      style={{ gridTemplateColumns: 'var(--sidebar-w) 1fr' }}
    >
      <StockDateGroupList rows={rows} selectedCode={selectedCode} onSelect={setSelectedCode} />
      <StockDateGroupDetail rows={rows} selectedCode={selectedCode} />
    </PageContainer>
  );
}
