import { useEffect, useMemo, useRef, useState } from 'react';
import { PanelCard, ToolbarButton } from '../ui/PageShell';
import { percent, scoreLabel, styleLabel, totalBps, type EtfFund, type EtfIndex, type MaState } from './model';

function MaLabel({ value }: { value: MaState | undefined }) {
  return <span className={`etf-ma ${value ?? ''}`}>{value === 'above' ? '상회' : value === 'below' ? '하회' : value === 'equal' ? '동일' : '—'}</span>;
}

export function EtfSummary({ fund, selected, priceAsOf, largestName, onCompare }: { fund: EtfFund; selected: boolean; priceAsOf: string; largestName: string; onCompare: () => void }) {
  return <PanelCard as="section" className="etf-panel" aria-label="ETF 요약">
    <div className="etf-between"><div><small className={`etf-style ${fund.style}`}>{styleLabel(fund)} · {fund.code}</small><h2>{fund.name}</h2></div><ToolbarButton tone={selected ? 'secondary' : 'primary'} aria-pressed={selected} onClick={onCompare}>{selected ? '비교에 담김 ✓' : '비교에 추가 ＋'}</ToolbarButton></div>
    <div className="etf-meta"><span>{fund.issuer}</span><span>{fund.benchmark || '비교지수 미제공'}</span><span>{fund.issuerMatched ? '운용사 원본 대조 완료' : '공통 API 확인 · 원본 대조 대기'}</span></div>
    <div className="etf-stats">
      <div><span>직접 편입 국내 주식</span><b>{fund.holdings.length}<em> 종목</em></b><small>공시 비중 합계 {percent(totalBps(fund.holdings))}</small></div>
      <div><span>상위 {Math.min(5, fund.holdings.length)}종목 비중</span><b>{percent(totalBps(fund.holdings.slice(0, 5)))}</b><small>최대 {largestName} {percent(fund.holdings[0].weightBps)}</small></div>
      <div><span>공탐 원점수</span><b className={fund.score === null ? 'etf-pending' : ''}>{scoreLabel(fund)}</b><small>{fund.score === null ? '구성종목 조회 가능' : `${priceAsOf} 종가 기준`}</small></div>
    </div>
  </PanelCard>;
}

export function HoldingBars({ fund, index, onStock }: { fund: EtfFund; index: EtfIndex; onStock: (code: string) => void }) {
  return <PanelCard as="section" className="etf-panel" aria-label="상위 편입 비중">
    <div className="etf-between"><h3>상위 10개 편입 종목</h3><small>ETF 전체 대비 공시 비중</small></div>
    <div className="etf-bars" role="group" aria-label={`${fund.name} 상위 10개 편입 비중`}>
      {fund.holdings.slice(0, 10).map(h => <div className="etf-bar" key={h.code}>
        <button aria-label={`${index.snapshot.stocks[h.code].name} 포함 ETF 보기`} onClick={() => onStock(h.code)}>{index.snapshot.stocks[h.code].name}</button>
        <div className="etf-track" role="progressbar" aria-label={`${index.snapshot.stocks[h.code].name} 편입 비중`} aria-valuenow={h.weightBps / 100} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${h.weightBps / 100}%` }} /></div>
        <span className="etf-number">{percent(h.weightBps)}</span>
      </div>)}
    </div>
    <div className="etf-bar-scale" aria-hidden="true"><span>0%</span><span>50%</span><span>100%</span></div>
    <div className="etf-between etf-secondary"><span>상위 10개 합계 {percent(totalBps(fund.holdings.slice(0, 10)))}</span><span>국내 직접 주식 합계 {percent(totalBps(fund.holdings))}</span></div>
    {fund.otherAssets.length > 0 && <p className="etf-note">별도 자산: {fund.otherAssets.map(a => `${a.name} ${percent(a.weightBps)}`).join(' · ')}</p>}
  </PanelCard>;
}

export function StockHoldings({ fund, index, stock, onStock, onPick }: {
  fund: EtfFund; index: EtfIndex; stock: string | null; onStock: (code: string | null) => void; onPick: (code: string) => void;
}) {
  const [query, setQuery] = useState(''), [sort, setSort] = useState('weight');
  const [limit, setLimit] = useState(12), [reversePage, setReversePage] = useState({ code: '', limit: 6 });
  const reverse = useRef<HTMLDivElement>(null);
  useEffect(() => { if (stock) reverse.current?.scrollIntoView({ block: 'nearest' }); }, [stock]);
  const rows = useMemo(() => fund.holdings.filter(h => `${index.snapshot.stocks[h.code].name} ${h.code}`.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()))
    .sort((a, b) => sort === 'name' ? index.snapshot.stocks[a.code].name.localeCompare(index.snapshot.stocks[b.code].name, 'ko')
      : sort === 'count' ? index.memberships.get(b.code)!.length - index.memberships.get(a.code)!.length || b.weightBps - a.weightBps
        : b.weightBps - a.weightBps || a.code.localeCompare(b.code)), [fund, index, query, sort]);
  const reverseLimit = reversePage.code === stock ? reversePage.limit : 6;
  const reverseRows = stock ? index.memberships.get(stock) ?? [] : [];
  const selectStock = (code: string | null) => onStock(code);
  return <PanelCard as="section" className="etf-panel" aria-label="구성종목 탐색">
    <div className="etf-between"><h3>구성종목 {fund.holdings.length}개</h3><small>이평선 기준 {index.snapshot.priceAsOf}</small></div>
    <div className="etf-tools"><label className="etf-field">구성종목 검색<input type="search" placeholder="종목명 또는 코드" value={query} onChange={e => { setQuery(e.target.value); setLimit(12); }} /></label>
      <label className="etf-field">정렬<select value={sort} onChange={e => { setSort(e.target.value); setLimit(12); }}><option value="weight">편입 비중순</option><option value="name">종목명순</option><option value="count">포함 ETF 수순</option></select></label></div>
    {stock && <div className="etf-reverse" ref={reverse}>
      <div className="etf-between"><div aria-live="polite"><h3>{index.snapshot.stocks[stock].name}를 담은 ETF</h3><small>{stock} · 조사한 {index.snapshot.funds.length}개 중 {reverseRows.length}개 · 액티브 {reverseRows.filter(r => r.fund.style === 'active').length}개</small></div><ToolbarButton onClick={() => selectStock(null)}>닫기</ToolbarButton></div>
      <div className="etf-reverse-list">{reverseRows.slice(0, reverseLimit).map(({ fund: f, weightBps }) => <button key={f.code} className="etf-reverse-row" aria-label={`${f.name} 구성 보기`} onClick={() => onPick(f.code)}><span><b>{f.name}</b><small>{styleLabel(f)} · {f.code}</small></span><span className="etf-number">{percent(weightBps)} ↗</span></button>)}</div>
      {reverseRows.length > reverseLimit && <ToolbarButton onClick={() => setReversePage({ code: stock, limit: reverseLimit + 12 })}>포함 ETF 더 보기 ({reverseLimit} / {reverseRows.length})</ToolbarButton>}
    </div>}
    <div className="etf-table-wrap"><table><caption>종목명 선택 시 해당 종목을 담은 다른 ETF 조회</caption><thead><tr><th>종목</th><th>편입 비중</th><th>20일선</th><th>60일선</th><th>120일선</th><th>포함 ETF</th></tr></thead><tbody>
      {rows.slice(0, limit).map(h => <tr key={h.code} className={stock === h.code ? 'etf-selected-row' : ''}><th scope="row"><button onClick={() => selectStock(h.code)} aria-label={`${index.snapshot.stocks[h.code].name} 포함 ETF 조회`}>{index.snapshot.stocks[h.code].name}</button><small>{h.code}</small></th><td>{percent(h.weightBps)}</td>{[0, 1, 2].map(i => <td key={i}><MaLabel value={index.snapshot.stocks[h.code].states?.[i]} /></td>)}<td><button onClick={() => selectStock(h.code)} aria-label={`${index.snapshot.stocks[h.code].name} 포함 ${index.memberships.get(h.code)!.length}개 ETF 조회`}>{index.memberships.get(h.code)!.length}개 ↗</button></td></tr>)}
    </tbody></table></div>
    {rows.length === 0 && <p className="etf-empty">검색 결과가 없습니다.</p>}
    <div className="etf-pagination"><span>{Math.min(rows.length, limit)} / {rows.length}종목</span>{limit < rows.length && <ToolbarButton onClick={() => setLimit(v => v + 20)}>종목 더 보기 ＋</ToolbarButton>}</div>
    <p className="etf-note">구성은 전체 {index.snapshot.funds.length}개 ETF에서 조회됩니다. 이평선 상태는 검증된 값만 표시하며, 미검증 종목은 ‘—’입니다. 같은 가격은 ‘동일’로 표시합니다.</p>
  </PanelCard>;
}
