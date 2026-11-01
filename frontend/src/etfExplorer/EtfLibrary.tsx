import { useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { PanelCard, SegmentedControl, ToolbarButton } from '../ui/PageShell';
import { styleLabel, type EtfFund, type ExplorerPrefs, type FilterStyle } from './model';

export function EtfLibrary({ funds, allFunds, prefs, page, onPage, onFilter, onPick }: {
  funds: EtfFund[]; allFunds: EtfFund[]; prefs: ExplorerPrefs; page: number;
  onPage: (page: number) => void; onFilter: (patch: Partial<ExplorerPrefs>, autoSelect?: boolean) => void; onPick: (code: string) => void;
}) {
  const pages = Math.max(1, Math.ceil(funds.length / 8)), current = Math.min(page, pages - 1);
  const issuers = [...new Set(allFunds.map(f => f.issuer))].sort((a, b) => a.localeCompare(b, 'ko'));
  const search = useRef<HTMLInputElement>(null), composing = useRef(false);
  const buttons = useRef(new Map<string, HTMLButtonElement>()), pendingFocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    const button = pendingFocus.current ? buttons.current.get(pendingFocus.current) : null;
    if (button) { button.focus(); pendingFocus.current = null; }
  }, [funds, current]);
  const focusResult = (index: number) => {
    const target = Math.max(0, Math.min(funds.length - 1, index)), fund = funds[target];
    if (!fund) return;
    const button = buttons.current.get(fund.code);
    if (button) button.focus();
    else { pendingFocus.current = fund.code; onPage(Math.floor(target / 8)); }
  };
  const searchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); focusResult(event.key === 'ArrowDown' ? current * 8 : Math.min(funds.length - 1, current * 8 + 7));
    } else if (event.key === 'Enter' && funds[current * 8]) { event.preventDefault(); onPick(funds[current * 8].code); }
  };
  const resultKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); focusResult(index + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); focusResult(event.key === 'Home' ? 0 : funds.length - 1);
    } else if (event.key === 'Escape') { event.preventDefault(); search.current?.focus(); }
  };
  const filtered = prefs.style !== 'all' || Boolean(prefs.issuer);
  return <PanelCard as="section" className="etf-library" aria-label="ETF 목록">
    <label className="etf-field">ETF 또는 구성종목 검색<input ref={search} type="search" maxLength={100} value={prefs.query}
      onChange={e => onFilter({ query: e.target.value }, !composing.current)} onKeyDown={searchKey}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={e => { composing.current = false; onFilter({ query: e.currentTarget.value }); }}
      placeholder="예: 삼성전자, 반도체, 444200" aria-describedby="etf-search-help" /></label>
    <p className="etf-note" id="etf-search-help">이름·코드가 정확히 맞으면 바로 열립니다. 여러 결과는 ↑↓로 이동하고 Enter로 여세요.</p>
    <SegmentedControl aria-label="ETF 운용 방식">
      {(['all', 'active', 'passive'] as FilterStyle[]).map(style => <button key={style} aria-pressed={prefs.style === style} onClick={() => onFilter({ style })}>
        {style === 'all' ? '전체' : style === 'active' ? '액티브' : '패시브'} {allFunds.filter(f => style === 'all' || f.style === style).length}
      </button>)}
    </SegmentedControl>
    <label className="etf-field">운용사<select value={prefs.issuer} onChange={e => onFilter({ issuer: e.target.value })}><option value="">전체 운용사</option>{issuers.map(i => <option key={i}>{i}</option>)}</select></label>
    <div className="etf-between etf-secondary" aria-live="polite"><span>{funds.length}개 ETF</span><span>액티브 {funds.filter(f => f.style === 'active').length}개</span></div>
    <div className="etf-fund-list">{funds.slice(current * 8, current * 8 + 8).map((f, i) => <button key={f.code} ref={el => { if (el) buttons.current.set(f.code, el); else buttons.current.delete(f.code); }}
      className="etf-fund" aria-label={`${f.name} 선택`} aria-pressed={f.code === prefs.code} onClick={() => onPick(f.code)} onKeyDown={e => resultKey(e, current * 8 + i)}>
      <b>{f.name}</b><span><small className={`etf-style ${f.style}`}>{styleLabel(f)} · {f.holdings.length}종목</small><small>{f.code}</small></span>
    </button>)}</div>
    {funds.length === 0 && <div className="etf-empty" role="status"><p>검색 결과가 없습니다.</p>
      <p className="etf-note">적용 중: {prefs.style === 'all' ? '전체 운용 방식' : prefs.style === 'active' ? '액티브' : '패시브'} · {prefs.issuer || '전체 운용사'}</p>
      {filtered ? <ToolbarButton onClick={() => onFilter({ style: 'all', issuer: '' })}>필터 초기화</ToolbarButton>
        : <p className="etf-note">조사한 {allFunds.length}개 ETF 안에서 검색합니다. 이름이나 코드를 확인해 주세요.</p>}</div>}
    <div className="etf-pagination"><ToolbarButton disabled={current === 0} onClick={() => onPage(current - 1)}>← 이전</ToolbarButton><span>{current + 1} / {pages}</span><ToolbarButton disabled={current === pages - 1} onClick={() => onPage(current + 1)}>다음 →</ToolbarButton></div>
  </PanelCard>;
}
