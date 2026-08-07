import { useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
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
  const { data: rows = [], isLoading, isError, refetch } = useStockDates();
  // 딥링크: ?code= 로 특정 종목을 바로 연다(/capture 와 대칭). 선택이 바뀌면
  // URL 에도 반영해 새로고침·공유가 선택을 보존한다.
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedCode, setSelectedCode] = useState<string | null>(
    () => searchParams.get('code'),
  );
  const selectCode = (code: string) => {
    setSelectedCode(code);
    setSearchParams({ code }, { replace: true });
  };
  const unfilteredGroups = useStockDateGroups(rows, '');

  /**
   * 실제로 열려 있는 종목. `?code=` 가 없거나 존재하지 않는 종목을 가리키면 첫
   * 그룹으로 폴백한다.
   *
   * **effect 로 state 를 맞추지 않고 파생한다.** 종전엔 `useEffect` 가 폴백 값을
   * `setSelectedCode` 로 써 넣었는데, 그건 한 프레임 늦다 — 첫 렌더는 `selectedCode`
   * 가 null 이라 `selectGroup` 이 null 을 돌려주고 상세 패널이 "종목을 선택하세요" 를
   * 그렸다가 다음 렌더에 바뀐다. 파생이면 그 깜빡임이 구조적으로 없고
   * `react-hooks/set-state-in-effect` 도 같이 풀린다. 사용자 클릭 경로(`selectCode`)
   * 는 그대로 state + URL 을 쓴다.
   */
  const effectiveCode = useMemo(() => {
    if (selectedCode !== null && unfilteredGroups.some((g) => g.code === selectedCode)) {
      return selectedCode;
    }
    return unfilteredGroups[0]?.code ?? null;
  }, [unfilteredGroups, selectedCode]);

  // Resolve the detail group here (single owner of default-to-first), so the
  // detail panel takes a ready group instead of re-grouping the same rows.
  const selectedGroup = useMemo(
    () => selectGroup(unfilteredGroups, effectiveCode),
    [unfilteredGroups, effectiveCode],
  );

  if (isLoading) {
    // main 의 한글 텍스트('불러오는 중')를 스켈레톤이 포섭한다 — 같은 문구 + 2-pane 자리.
    return <InventoryLoadingSkeleton />;
  }
  if (isError) {
    // 에러를 빈 상태와 구분한다 — 재고 API 는 cold ~37초짜리라 실패·타임아웃이 드물지
    // 않은데, "캡처된 데이터가 없습니다"로 보이면 데이터가 지워졌다고 오독한다.
    return (
      <InventoryStateShell>
        <div role="alert" className="flex items-center gap-3">
          <span className="flex-1" style={{ color: 'var(--error)' }}>
            캡처 재고를 불러오지 못했습니다 · 백엔드 연결을 확인하세요
          </span>
          <button type="button" onClick={() => refetch()}
            className="rounded-lg px-3 py-[7px] text-sm bg-transparent text-fg-dim hover:bg-bg-input-hover hover:text-fg">
            다시 시도
          </button>
        </div>
      </InventoryStateShell>
    );
  }
  if (rows.length === 0) {
    return <InventoryStateShell>캡처된 데이터가 없습니다</InventoryStateShell>;
  }

  return (
    <PageContainer
      className="grid gap-md !pb-0"
      style={{ gridTemplateColumns: 'var(--sidebar-w) 1fr' }}
    >
      <PanelCard borderless flat data-testid="inventory-list-pane" className="flex min-h-0 flex-col overflow-hidden">
        <StockDateGroupList rows={rows} selectedCode={effectiveCode} onSelect={selectCode} />
      </PanelCard>
      <PanelCard borderless flat data-testid="inventory-detail-pane" className="flex min-h-0 flex-col overflow-hidden">
        <StockDateGroupDetail group={selectedGroup} />
      </PanelCard>
    </PageContainer>
  );
}
