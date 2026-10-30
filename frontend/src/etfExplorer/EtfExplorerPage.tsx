import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PanelCard, PageState, ToolbarButton } from '../ui/PageShell';
import { persistJson, readJsonObject } from '../state/persist';
import { EtfLibrary } from './EtfLibrary';
import { EtfSummary, HoldingBars, StockHoldings } from './EtfHoldings';
import { EtfComparison } from './EtfComparison';
import { buildIndex, loadSnapshot, MAX_COMPARE, PREFS_KEY, restorePrefs, searchFunds, type EtfSnapshot, type ExplorerPrefs } from './model';
import './etfExplorer.css';

export default function EtfExplorerPage() {
  const query = useQuery({ queryKey: ['etf-explorer', 'snapshot', 1], queryFn: loadSnapshot, staleTime: Infinity, retry: false });
  return <div className="etf-explorer h-full min-h-0 overflow-y-auto" data-testid="etf-explorer-page">
    {query.isPending ? <PageState>ETF 구성 자료를 불러오는 중…</PageState>
      : query.isError ? <PageState tone="error"><p>{query.error.message}</p><ToolbarButton onClick={() => void query.refetch()}>다시 불러오기</ToolbarButton></PageState>
        : <ExplorerContent snapshot={query.data} />}
  </div>;
}

function ExplorerContent({ snapshot }: { snapshot: EtfSnapshot }) {
  const index = useMemo(() => buildIndex(snapshot), [snapshot]);
  const [prefs, setPrefs] = useState(() => restorePrefs(readJsonObject(PREFS_KEY), index));
  const [page, setPage] = useState(0), [stock, setStock] = useState<string | null>(null), [notice, setNotice] = useState('');
  useEffect(() => persistJson(PREFS_KEY, prefs), [prefs]);
  const funds = useMemo(() => searchFunds(index, { style: prefs.style, issuer: prefs.issuer, query: prefs.query }), [index, prefs.style, prefs.issuer, prefs.query]);
  const detail = useRef<HTMLDivElement>(null);
  const selected = index.funds.get(prefs.code)!;
  const active = snapshot.funds.filter(f => f.style === 'active');
  const ready = snapshot.funds.filter(f => f.status === 'ready');
  const filter = (patch: Partial<ExplorerPrefs>) => { setPrefs(p => ({ ...p, ...patch })); setPage(0); };
  const pick = (code: string) => { setPrefs(p => ({ ...p, code })); setStock(null); setNotice(''); };
  const change = (patch: Partial<ExplorerPrefs>) => { setPrefs(p => ({ ...p, ...patch })); setNotice(''); };
  const toggleCompare = (code: string) => {
    if (!prefs.compare.includes(code) && prefs.compare.length >= MAX_COMPARE) {
      setNotice('최대 4개 ETF까지 비교할 수 있습니다. 비교에 담긴 ETF 하나를 먼저 제외하세요.');
      return;
    }
    setPrefs(p => ({ ...p, compare: p.compare.includes(code) ? p.compare.filter(c => c !== code) : [...p.compare, code] }));
    setNotice('');
  };
  return <div className="etf-content">
    <header className="etf-between etf-page-header"><div><h1>ETF 탐색</h1><p>ETF의 구성부터, 종목의 연결까지.</p></div><div className="etf-stamp"><b>{snapshot.funds.length}개 ETF · 고유 주식 {Object.keys(snapshot.stocks).length}개</b><span>패시브 {snapshot.funds.length - active.length}개 · 액티브 {active.length}개 · 구성 {snapshot.holdingsAsOf}</span><span>저장된 조사 자료 · 자동 갱신 미연결</span></div></header>
    <div className="etf-workspace">
      <EtfLibrary funds={funds} allFunds={snapshot.funds} prefs={prefs} page={page} onPage={setPage} onFilter={filter} onPick={pick} />
      <div className="etf-detail" ref={detail} aria-label="선택 ETF 상세">
        <EtfSummary fund={selected} selected={prefs.compare.includes(selected.code)} priceAsOf={snapshot.priceAsOf} largestName={snapshot.stocks[selected.holdings[0].code].name} onCompare={() => toggleCompare(selected.code)} />
        {notice && <p className="etf-note" role="status">{notice}</p>}
        <HoldingBars fund={selected} index={index} onStock={setStock} />
        <StockHoldings key={selected.code} fund={selected} index={index} stock={stock} onStock={setStock} onPick={code => { pick(code); detail.current?.scrollIntoView({ block: 'start' }); }} />
      </div>
    </div>
    <EtfComparison index={index} prefs={prefs} onChange={change} onToggle={toggleCompare} />
    <PanelCard className="etf-panel etf-method"><details><summary>기준일과 자료 범위</summary>
      <p>구성 {snapshot.holdingsAsOf} · 검증 가격 {snapshot.priceAsOf}. 조사한 {snapshot.funds.length}개 ETF의 고정 자료이며 전체 상장 ETF 목록은 아닙니다. 자동 갱신은 아직 연결하지 않았습니다.</p>
      <p>공탐 원점수는 현재 {ready.length}개 ETF에서 계산 가능합니다. 검증 대기 {snapshot.funds.filter(f => f.status === 'price_capture_required').length}개·상장 이력 부족 {snapshot.funds.filter(f => f.status === 'insufficient_listing_history').length}개도 구성 조회와 겹침 비교는 가능합니다.</p>
      <p>구성은 공통 API 자료 기준입니다. 패시브 {snapshot.funds.filter(f => f.style === 'passive' && f.issuerMatched).length}개·액티브 {active.filter(f => f.issuerMatched).length}개는 운용사 원본과 대조했습니다. 나머지 액티브는 원본 대조 대기입니다. 공시 비중을 그대로 사용하며 현금·다른 ETF·파생상품 등은 국내 주식 비교에서 제외합니다. 별도 자산의 음수 비중도 공시된 부호를 유지합니다.</p>
    </details></PanelCard>
  </div>;
}
