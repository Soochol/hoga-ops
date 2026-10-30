import { useState } from 'react';
import { PanelCard, SegmentedControl, ToolbarButton } from '../ui/PageShell';
import { compareFunds, percent, type EtfIndex, type ExplorerPrefs, type OverlapView } from './model';

export function EtfComparison({ index, prefs, onChange, onToggle }: {
  index: EtfIndex; prefs: ExplorerPrefs;
  onChange: (patch: Partial<ExplorerPrefs>) => void; onToggle: (code: string) => void;
}) {
  const [pagination, setPagination] = useState({ signature: '', limit: 12 });
  const selected = prefs.compare.map(c => index.funds.get(c)!);
  const pair = prefs.pair?.every(c => prefs.compare.includes(c)) ? prefs.pair : prefs.compare.slice(0, 2);
  const a = index.funds.get(pair[0]), b = index.funds.get(pair[1]);
  const overlap = a && b ? compareFunds(a, b) : null;
  const pairs = selected.flatMap((left, i) => selected.slice(i + 1).map(right => ({ left, right, result: compareFunds(left, right) })));
  const signature = `${pair.join(':')}:${prefs.view}`, limit = pagination.signature === signature ? pagination.limit : 12;
  const rows = overlap ? [...(prefs.view === 'common' ? overlap.common : prefs.view === 'left' ? overlap.leftOnly : overlap.rightOnly)]
    .sort((x, y) => Math.max(overlap.leftWeights.get(y) ?? 0, overlap.rightWeights.get(y) ?? 0)
      - Math.max(overlap.leftWeights.get(x) ?? 0, overlap.rightWeights.get(x) ?? 0) || x.localeCompare(y)) : [];
  return <PanelCard as="section" className="etf-panel etf-comparison" aria-label="ETF 겹침 비교">
    <div className="etf-between"><div><h2>함께 담으면 얼마나 겹칠까</h2><small>ETF 2–4개 · 직접 편입 국내 주식 기준</small></div><ToolbarButton onClick={() => onChange({ compare: [], pair: null })}>비교 비우기</ToolbarButton></div>
    <div className="etf-chips" aria-label="비교에 담긴 ETF">{selected.map(f => <span key={f.code}>{f.name}<button aria-label={`${f.name} 비교에서 제외`} onClick={() => onToggle(f.code)}>×</button></span>)}</div>
    {!overlap || !a || !b ? <p className="etf-empty">목록에서 ETF를 선택하고 ‘비교에 추가’를 눌러 2개 이상 담으세요.</p> : <>
      <div className="etf-pairs" role="group" aria-label="ETF 조합 선택">{pairs.map(({ left, right, result }) => <button key={`${left.code}:${right.code}`} aria-label={`${left.name}와 ${right.name} 겹침 비교`} aria-pressed={pair.includes(left.code) && pair.includes(right.code)} onClick={() => onChange({ pair: [left.code, right.code] })}>
        <span>{left.name}<br />× {right.name}</span><b>{percent(result.overlapBps)}</b><small>공통 {result.common.length}종목 · 구성 중복 비중</small>
      </button>)}</div>
      <div className="etf-between etf-pair-label"><b>A · {a.name}</b><b>B · {b.name}</b></div>
      <SegmentedControl aria-label="겹침 종목 범위">{(['common', 'left', 'right'] as OverlapView[]).map(view => <button key={view} aria-pressed={prefs.view === view} onClick={() => onChange({ view })}>
        {view === 'common' ? `공통 ${overlap.common.length}종목` : view === 'left' ? `A에만 ${overlap.leftOnly.length}종목` : `B에만 ${overlap.rightOnly.length}종목`}
      </button>)}</SegmentedControl>
      <div className="etf-table-wrap"><table><caption>각 ETF 전체 대비 공시 비중</caption><thead><tr><th>종목</th><th>A 편입 비중</th><th>B 편입 비중</th></tr></thead><tbody>{rows.slice(0, limit).map(code => <tr key={code}><th scope="row">{index.snapshot.stocks[code].name}<small>{code}</small></th><td>{overlap.leftWeights.has(code) ? percent(overlap.leftWeights.get(code)!) : '—'}</td><td>{overlap.rightWeights.has(code) ? percent(overlap.rightWeights.get(code)!) : '—'}</td></tr>)}</tbody></table></div>
      {rows.length === 0 && <p className="etf-empty">해당 종목이 없습니다.</p>}
      {rows.length > limit && <ToolbarButton onClick={() => setPagination({ signature, limit: limit + 20 })}>비교 종목 더 보기 ＋</ToolbarButton>}
      <p className="etf-note">구성 중복 비중: 공통 종목마다 두 ETF의 더 작은 비중을 합산합니다. 현금·다른 ETF·파생상품 등은 제외하며, 수익률 상관관계를 뜻하지 않습니다.</p>
    </>}
  </PanelCard>;
}
