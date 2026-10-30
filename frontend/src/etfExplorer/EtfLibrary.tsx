import { PanelCard, SegmentedControl, ToolbarButton } from '../ui/PageShell';
import { styleLabel, type EtfFund, type ExplorerPrefs, type FilterStyle } from './model';

export function EtfLibrary({ funds, allFunds, prefs, page, onPage, onFilter, onPick }: {
  funds: EtfFund[]; allFunds: EtfFund[]; prefs: ExplorerPrefs; page: number;
  onPage: (page: number) => void; onFilter: (patch: Partial<ExplorerPrefs>) => void; onPick: (code: string) => void;
}) {
  const pages = Math.max(1, Math.ceil(funds.length / 8)), current = Math.min(page, pages - 1);
  const issuers = [...new Set(allFunds.map(f => f.issuer))].sort((a, b) => a.localeCompare(b, 'ko'));
  return <PanelCard as="section" className="etf-library" aria-label="ETF 목록">
    <label className="etf-field">ETF 또는 구성종목 검색<input type="search" maxLength={100} value={prefs.query} onChange={e => onFilter({ query: e.target.value })} placeholder="예: 삼성전자, 반도체, 444200" /></label>
    <SegmentedControl aria-label="ETF 운용 방식">
      {(['all', 'active', 'passive'] as FilterStyle[]).map(style => <button key={style} aria-pressed={prefs.style === style} onClick={() => onFilter({ style })}>
        {style === 'all' ? '전체' : style === 'active' ? '액티브' : '패시브'} {allFunds.filter(f => style === 'all' || f.style === style).length}
      </button>)}
    </SegmentedControl>
    <label className="etf-field">운용사<select value={prefs.issuer} onChange={e => onFilter({ issuer: e.target.value })}><option value="">전체 운용사</option>{issuers.map(i => <option key={i}>{i}</option>)}</select></label>
    <div className="etf-between etf-secondary" aria-live="polite"><span>{funds.length}개 ETF</span><span>액티브 {funds.filter(f => f.style === 'active').length}개</span></div>
    <div className="etf-fund-list">{funds.slice(current * 8, current * 8 + 8).map(f => <button key={f.code} className="etf-fund" aria-label={`${f.name} 선택`} aria-pressed={f.code === prefs.code} onClick={() => onPick(f.code)}>
      <b>{f.name}</b><span><small className={`etf-style ${f.style}`}>{styleLabel(f)} · {f.holdings.length}종목</small><small>{f.code}</small></span>
    </button>)}</div>
    {funds.length === 0 && <p className="etf-empty">검색 결과가 없습니다.</p>}
    <div className="etf-pagination"><ToolbarButton disabled={current === 0} onClick={() => onPage(current - 1)}>← 이전</ToolbarButton><span>{current + 1} / {pages}</span><ToolbarButton disabled={current === pages - 1} onClick={() => onPage(current + 1)}>다음 →</ToolbarButton></div>
  </PanelCard>;
}
