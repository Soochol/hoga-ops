import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PanelCard, PageState, SegmentedControl, ToolbarButton } from '../ui/PageShell';
import { persistJson, readJsonObject } from '../state/persist';
import { BreadthChart, CHART_COLORS } from './BreadthChart';
import { etfImprovementCounts, loadReport, number, selectedCodes, SELECTION_KEY, signed, type BreadthReport, type Fund, type Value } from './report';
import './breadth.css';

const SECTIONS = [ ['spread', '추이와 확산'], ['etfs', 'ETF 비교'], ['stress', '시장 스트레스'], ['causes', '변화의 원인'] ] as const;
const direction = (v: Value) => v == null || Math.abs(v) < 1e-8 ? '' : v > 0 ? 'breadth-up' : 'breadth-down';

function Metric({ label, value, detail, delta = null }: { label: string; value: ReactNode; detail: ReactNode; delta?: Value }) {
  return <div className="breadth-metric"><span>{label}</span><strong className={direction(delta)}>{value}</strong><small>{detail}</small></div>;
}
function Section({ id, title, eyebrow, children }: { id: string; title: string; eyebrow: string; children: ReactNode }) {
  return <section id={id} className="breadth-section" aria-labelledby={`${id}-title`}>
    <div className="breadth-section-heading"><div><p className="breadth-eyebrow">{eyebrow}</p><h2 id={`${id}-title`}>{title}</h2></div><a href="#breadth-top">기본 그래프 ↑</a></div>
    {children}
  </section>;
}
function Horizon({ value, onChange }: { value: '5' | '20'; onChange: (v: '5' | '20') => void }) {
  return <SegmentedControl aria-label="종목 변화 비교 기간">{(['5', '20'] as const).map(h =>
    <button key={h} aria-pressed={h === value} onClick={() => onChange(h)}>{h}거래일</button>)}</SegmentedControl>;
}
function streak(f: Fund) {
  return f.persistence.streak === null ? '자료 부족' : `${f.persistence.atLeast ? '최소 ' : ''}${f.persistence.streak}일`;
}

export default function BreadthPage() {
  const query = useQuery({ queryKey: ['breadth', 'snapshot', 1], queryFn: loadReport, staleTime: Infinity, retry: false });
  return <div className="breadth-page h-full min-h-0 overflow-y-auto" data-testid="breadth-page">
    {query.isPending ? <PageState>확정 공탐지수 자료를 불러오는 중…</PageState>
      : query.isError ? <PageState tone="error"><p>{query.error.message}</p><ToolbarButton onClick={() => void query.refetch()}>다시 불러오기</ToolbarButton></PageState>
        : <BreadthContent report={query.data} />}
  </div>;
}

function BreadthContent({ report: r }: { report: BreadthReport }) {
  const [selection, setSelection] = useState(() => selectedCodes(readJsonObject(SELECTION_KEY).codes, r.funds));
  const [fundSearch, setFundSearch] = useState('');
  const [windowSize, setWindowSize] = useState(60);
  const [cursor, setCursor] = useState(r.asOf);
  const [horizon, setHorizon] = useState<'5' | '20'>('5');
  const [stressMetric, setStressMetric] = useState<'drawdown' | 'volatility'>('drawdown');
  const [stockSearch, setStockSearch] = useState('');
  const [stockFilter, setStockFilter] = useState('changed');
  const [stockLimit, setStockLimit] = useState(12);
  const [fundSort, setFundSort] = useState('streak');
  const [showBase, setShowBase] = useState(true);
  const mainChart = useRef<HTMLElement>(null);
  useEffect(() => persistJson(SELECTION_KEY, { codes: selection }), [selection]);
  useEffect(() => setStockLimit(12), [stockSearch, stockFilter, horizon]);
  const ready = useMemo(() => r.funds.filter(f => f.status === 'ready'), [r]);
  const etfSpread = useMemo(() => [5, 20].map(h => etfImprovementCounts(r.funds, h)), [r]);
  const selected = useMemo(() => ready.filter(f => selection.includes(f.code)), [ready, selection]);
  const visibleFunds = useMemo(() => r.funds.filter(f => `${f.name} ${f.code}`.toLowerCase().includes(fundSearch.toLowerCase())), [r, fundSearch]);
  const sortedFunds = useMemo(() => [...selected].sort((a, b) => {
    const field = (f: Fund) => fundSort === 'streak' ? f.persistence.streak : fundSort === 'score' ? f.score : fundSort === 'd5' ? f.d5 : f.d20;
    return (field(b) ?? -Infinity) - (field(a) ?? -Infinity) || a.code.localeCompare(b.code);
  }), [selected, fundSort]);
  const change = r.changes[horizon];
  const stockRows = useMemo(() => change.stocks.filter(s => {
    const matches = `${s.name} ${s.code}`.toLowerCase().includes(stockSearch.toLowerCase());
    return matches && (stockFilter === 'all' || (stockFilter === 'positive' ? s.contribution > 0 : stockFilter === 'negative' ? s.contribution < 0 : stockFilter === 'unchanged' ? s.contribution === 0 : s.contribution !== 0));
  }).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution) || a.code.localeCompare(b.code)), [change, stockSearch, stockFilter]);
  const dates = r.dates.slice(-windowSize);
  const baseLine = { label: '전체 477종목', values: r.baseline.line.slice(-windowSize), color: 'var(--ma-5)', dashed: true };
  const focusedDate = dates.includes(cursor) ? cursor : r.asOf;
  const setRange = (size: number) => { setWindowSize(size); setCursor(r.asOf); };
  const toggle = (code: string) => setSelection(prev => prev.includes(code) ? prev.filter(c => c !== code) : [...prev, code]);
  const bothUp = ready.filter(f => (f.d5 ?? 0) > 1e-7 && (f.d20 ?? 0) > 1e-7);
  const validHistory = r.baseline.line.filter(v => v !== null).length;
  return <div className="breadth-content">
    <header id="breadth-top" className="breadth-header">
      <div><p className="breadth-eyebrow">시장 내부의 힘 · ETF 편입 종목 기준</p><h1>공탐지수</h1><p>가격의 반등이 얼마나 넓고 오래 이어지는지, 종목의 움직임으로 확인하세요.</p></div>
      <div className="breadth-asof"><b>{r.asOf} 종가 확정</b><span>저장된 분석 자료 · 자동 갱신 미연결</span></div>
    </header>
    <PanelCard className="breadth-hero">
      <div className="breadth-metrics">
        <Metric label="원점수" value={<>{number(r.baseline.score)}<em> / 100</em></>} detail="477종목 × 3개 이평선의 상회 비율" />
        <Metric label="5거래일 변화" value={`${signed(r.baseline.d5)}점`} delta={r.baseline.d5} detail={`전일 ${signed(r.baseline.d1)}점 · 20거래일 ${signed(r.baseline.d20)}점`} />
        <Metric label="동일 집합의 과거 표본" value={`${r.rarity.original.n}일`} detail="희소성 판단에 표본 부족" />
        <Metric label="지수에 반영한 고유 종목" value={`${r.population}개`} detail={`${ready.length}개 ETF의 ${r.membershipRows}건 편입 관계를 중복 제거`} />
      </div>
      <section ref={mainChart} className="breadth-basic" aria-label="기본 그래프">
        <div className="breadth-bar"><div><h2>전체 원점수 추이</h2><p>0–100점 · 높을수록 이평선 위 종목이 많습니다.</p></div>
          <SegmentedControl aria-label="그래프 표시 기간">{[20, 60, 120, 245].map(v => <button key={v} aria-pressed={windowSize === v} onClick={() => setRange(v)}>{v === 245 ? '1년' : `${v}일`}</button>)}</SegmentedControl>
        </div>
        <BreadthChart dates={dates} lines={[{ ...baseLine, label: '원점수', dashed: false }]} label="전체 원점수 기본 그래프" cursor={focusedDate} onCursor={setCursor} />
        <label className="breadth-cursor">비교 기준일 <input aria-label="그래프 기준 거래일" type="range" min="0" max={dates.length - 1} value={Math.max(0, dates.indexOf(focusedDate))} onChange={e => setCursor(dates[Number(e.target.value)])} /><b>{focusedDate}</b></label>
        <p className="breadth-note">477종목이 모두 계산되는 구간은 {validHistory}거래일입니다. 이전 구간은 선을 그리지 않습니다. 그래프 기간과 커서는 아래 ETF 그래프에도 함께 적용됩니다.</p>
      </section>
    </PanelCard>
    <nav className="breadth-section-nav" aria-label="공탐지수 분석 바로가기">{SECTIONS.map(([id, name], i) => <a key={id} href={`#${id}`}><span>0{i + 1}</span>{name} ↓</a>)}</nav>

    <Section id="spread" eyebrow="01 · 얼마나 넓게 바뀌었나" title="추이와 확산">
      <PanelCard className="breadth-panel">
        <div className="breadth-bar"><div><h3>개선되는 ETF 수의 변화</h3><p>같은 42개 ETF에서 5일·20일 전보다 원점수가 높은 상품 수를 비교합니다.</p></div></div>
        <div className="breadth-metrics breadth-two">
          <Metric label="5거래일 전보다 개선" value={`${etfSpread[0].at(-1)} / ${ready.length}개`} detail="ETF별 원점수 변화가 양수인 상품" />
          <Metric label="20거래일 전보다 개선" value={`${etfSpread[1].at(-1)} / ${ready.length}개`} detail="짧은 반등과 더 긴 기간의 개선을 구분" />
        </div>
        <BreadthChart dates={dates} label="개선되는 ETF 수의 변화 그래프" unit="개 ETF" bounds={[0, ready.length]} cursor={focusedDate} onCursor={setCursor}
          lines={etfSpread.map((values, i) => ({ label: `${i === 0 ? 5 : 20}일 전보다 개선`, values: values.slice(-windowSize), color: CHART_COLORS[i] }))} />
        <p className="breadth-note">42개 모두의 비교 이력이 준비된 날짜만 표시합니다. 5일 비교는 {etfSpread[0].filter(v => v !== null).length}일, 20일 비교는 {etfSpread[1].filter(v => v !== null).length}일로 장기 판단에는 표본이 부족합니다. ETF끼리는 편입 종목이 겹치므로 아래 고유 종목 수와 구분해서 봅니다.</p>
      </PanelCard>
      <PanelCard className="breadth-panel">
        <div className="breadth-bar"><div><h3>실제 종목 확산</h3><p>ETF 중복을 제거한 477종목을, 각각 한 번씩 셉니다.</p></div><Horizon value={horizon} onChange={setHorizon} /></div>
        <div className="breadth-metrics breadth-three">
          <Metric label="이평선 상회 개수 증가" value={`${change.improved}종목`} detail={`전체의 ${number(change.improved / r.population * 100, 1)}% · 개선`} delta={1} />
          <Metric label="이평선 상회 개수 감소" value={`${change.declined}종목`} detail={`전체의 ${number(change.declined / r.population * 100, 1)}% · 악화`} delta={-1} />
          <Metric label="상회 개수 동일" value={`${change.unchanged}종목`} detail={`서로 다른 이평선 변화가 상쇄된 ${change.cancelling}종목 포함`} />
        </div>
        <div className="breadth-spread-bar" role="img" aria-label={`개선 ${change.improved}종목, 악화 ${change.declined}종목, 동일 ${change.unchanged}종목`}>
          <span style={{ flex: change.improved, background: 'var(--price-up)' }} /><span style={{ flex: change.declined, background: 'var(--price-down)' }} /><span style={{ flex: change.unchanged, background: 'var(--border-strong)' }} />
        </div>
        <p className="breadth-note">{change.from} → {change.to} · 각 종목의 ‘20·60·120일선 위에 있는 개수(0–3개)’를 두 시점에서 비교합니다. 기간 중 모든 돌파 횟수를 세는 지표는 아닙니다.</p>
        <BreadthChart dates={change.history.map(d => d.date)} label={`${horizon}거래일 실제 종목 확산 추이`} unit="종목" bounds={[0, r.population]}
          lines={[{ label: '개선', values: change.history.map(d => d.improved), color: 'var(--price-up)' }, { label: '악화', values: change.history.map(d => d.declined), color: 'var(--price-down)' }]} />
        <p className="breadth-note">비교 시점의 477종목 자료가 하나라도 부족하면 해당 날짜는 공백으로 남깁니다.</p>
      </PanelCard>
      <div className="breadth-two">
        <PanelCard className="breadth-panel"><h3>어느 이평선 위에 있나</h3>
          {r.baseline.periods.map(p => <div className="breadth-period" key={p.period}><span>{p.period}일선 위</span><progress max={100} value={p.percent} aria-label={`${p.period}일선 상회 비율`} /><b>{number(p.percent)}%</b><small>{p.above} / 477종목</small></div>)}
          <p className="breadth-note">3개 모두 상회 {r.baseline.allAbove}종목 · 모두 비상회 {r.baseline.noneAbove}종목 · 나머지 {r.population - r.baseline.allAbove - r.baseline.noneAbove}종목은 혼재. 같은 가격은 상회에 포함하지 않습니다.</p>
        </PanelCard>
        <PanelCard className="breadth-panel"><h3>과거 위치는 별도 판단</h3><div className="breadth-rarity"><strong>{number(r.rarity.cohort.lower_pct)}%</strong><span>별도 고정 {r.rarity.cohortSize}종목에서<br />현재보다 낮았던 과거일 비율</span></div>
          <p>350종목 점수 {number(r.rarity.cohortScore)}점 · 과거 {r.rarity.cohort.n.toLocaleString()}일 중 {r.rarity.cohort.lower_count}일이 더 낮았습니다.</p>
          <p className="breadth-note">전체 477종목의 {number(r.baseline.score)}점에 이 비율을 붙이지 않습니다. 전체 집합은 과거 {r.rarity.original.n}일뿐이라 ‘극단적 공포’ 판단을 보류합니다. 현재 편입 종목을 과거에 적용한 분석이며 당시 편입 종목 이력은 아닙니다.</p>
        </PanelCard>
      </div>
    </Section>

    <Section id="etfs" eyebrow="02 · 어디서 회복이 이어지나" title="ETF 비교">
      <PanelCard className="breadth-panel">
        <div className="breadth-metrics breadth-three">
          <Metric label="연속 3거래일 이상 개선" value={`${ready.filter(f => (f.persistence.streak ?? 0) >= 3).length} / ${ready.length}개`} detail="오늘까지 원점수가 매일 상승한 ETF" />
          <Metric label="최근 5거래일 중 3일 이상 개선" value={`${ready.filter(f => (f.persistence.up5 ?? 0) >= 3).length} / ${ready.length}개`} detail="하루 변화가 양수인 날짜의 개수" />
          <Metric label="5일·20일 변화 모두 양수" value={`${bothUp.length}개`} detail={bothUp.map(f => f.name).join(' · ') || '해당 ETF 없음'} />
        </div>
        <div className="breadth-bar"><div><h3>비교할 ETF 선택</h3><p>계산 가능 {ready.length}개 · 확정 입력 검증 대기 {r.funds.filter(f => f.status === 'price_capture_required').length}개 · 상장 기간 부족 {r.funds.filter(f => f.status === 'insufficient_listing_history').length}개</p></div>
          <div className="breadth-actions"><ToolbarButton onClick={() => setSelection(ready.map(f => f.code))}>전체 선택</ToolbarButton><ToolbarButton onClick={() => setSelection([])}>전체 해제</ToolbarButton></div>
        </div>
        <label className="breadth-search">ETF 검색<input value={fundSearch} onChange={e => setFundSearch(e.target.value)} placeholder="ETF 이름 또는 코드" /></label>
        <div className="breadth-fund-picker" role="group" aria-label="ETF 선택 목록">
          {visibleFunds.map(f => <label key={f.code} className={f.status !== 'ready' ? 'breadth-unavailable' : ''}>
            <input type="checkbox" checked={selection.includes(f.code)} disabled={f.status !== 'ready'} onChange={() => toggle(f.code)} />
            <span>{f.name}<small>{f.code} · {f.style === 'active' ? '액티브' : '패시브'} · {f.stockCount}종목</small></span>
            <b>{f.status === 'ready' ? `${number(f.score)}점` : f.status === 'insufficient_listing_history' ? '상장 기간 부족' : '확정 입력 검증 대기'}</b>
          </label>)}
          {visibleFunds.length === 0 && <p>검색 결과가 없습니다.</p>}
        </div>
        <p className="breadth-note">액티브 81개를 포함한 119개 후보 중 현재는 패시브 38개·액티브 4개를 비교합니다. 대기 종목의 저장 일봉은 존재하며, 수정 기준일과 확정 관측 검증을 마쳐야 반영할 수 있습니다.</p>
      </PanelCard>
      <PanelCard className="breadth-panel">
        <div className="breadth-bar"><div><h3>선택한 ETF {selected.length}개</h3><p>3개까지 겹쳐 보기 · 4개부터 같은 0–100점 축으로 나눠 보기</p></div><label className="breadth-check"><input type="checkbox" checked={showBase} onChange={e => setShowBase(e.target.checked)} />전체 원점수 비교</label></div>
        {selected.length === 0 ? <PageState>위 목록에서 비교할 ETF를 선택하세요. 기본 그래프는 계속 표시됩니다.</PageState> : selected.length <= 3
          ? <BreadthChart dates={dates} label="선택 ETF 겹쳐 보기" cursor={focusedDate} onCursor={setCursor} lines={[
            ...selected.map((f, i) => ({ label: f.name, values: f.line.slice(-windowSize), color: CHART_COLORS[i] })), ...(showBase ? [baseLine] : []),
          ]} />
          : <div className="breadth-small-multiples" data-testid="breadth-small-multiples">{selected.map(f => <article key={f.code} className="breadth-mini"><div className="breadth-bar"><h4>{f.name}</h4><b>{number(f.score)}점</b></div><p>{f.style === 'active' ? '액티브 · ' : ''}5일 {signed(f.d5)}점 · 20일 {signed(f.d20)}점 · 연속 개선 {streak(f)}</p>
            <BreadthChart dates={dates} label={`${f.name} 비교 그래프`} height={160} cursor={focusedDate} onCursor={setCursor} compact lines={[{ label: f.name, values: f.line.slice(-windowSize), color: CHART_COLORS[0] }, ...(showBase ? [baseLine] : [])]} />
          </article>)}</div>}
        <div className="breadth-bar breadth-table-heading"><div><h3>회복 지속성</h3><p>선택한 ETF의 수준·변화·지속성을 함께 비교합니다.</p></div><label>정렬 <select aria-label="ETF 비교 정렬" value={fundSort} onChange={e => setFundSort(e.target.value)}><option value="streak">연속 개선</option><option value="score">원점수</option><option value="d5">5일 변화</option><option value="d20">20일 변화</option></select></label></div>
        {selected.length > 0 && <div className="breadth-table-wrap"><table><thead><tr><th>ETF</th><th>원점수</th><th>5일 변화</th><th>20일 변화</th><th>연속 개선</th><th>최근 5일 개선</th></tr></thead><tbody>{sortedFunds.map(f => <tr key={f.code}><th>{f.name}<small>{f.style === 'active' ? '액티브' : '패시브'} · {f.stockCount}종목</small></th><td>{number(f.score)}</td><td className={direction(f.d5)}>{signed(f.d5)}</td><td className={direction(f.d20)}>{signed(f.d20)}</td><td>{streak(f)}</td><td>{number(f.persistence.up5, 0)} / 5일</td></tr>)}</tbody></table></div>}
        <p className="breadth-note">점수 변화의 단위는 ‘점’이며 ETF 수익률이 아닙니다. 연속 개선은 원점수가 직전 거래일보다 높아진 횟수로, 보합이면 끊깁니다. 이력이 상승 도중 시작되면 ‘최소 N일’로 표시합니다. 회복 확률이나 매수 신호로 해석하지 않습니다.</p>
      </PanelCard>
    </Section>

    <Section id="stress" eyebrow="03 · 가격은 얼마나 흔들리고 있나" title="시장 스트레스">
      <PanelCard className="breadth-panel">
        <div className="breadth-bar"><div><h3>{stressMetric === 'drawdown' ? '최근 252거래일 고점 대비 하락률' : '최근 20거래일 실현 변동성'}</h3><p>대표 시장 ETF의 가격 지표 · 원점수에 합산하지 않습니다.</p></div><SegmentedControl aria-label="시장 스트레스 지표"><button aria-pressed={stressMetric === 'drawdown'} onClick={() => setStressMetric('drawdown')}>고점 대비 하락</button><button aria-pressed={stressMetric === 'volatility'} onClick={() => setStressMetric('volatility')}>변동성</button></SegmentedControl></div>
        <div className="breadth-metrics breadth-two">{r.benchmarks.map(b => <Metric key={b.code} label={b.name} value={`${number(b[stressMetric].at(-1))}%`} detail={stressMetric === 'drawdown' ? '252일 최고 종가 대비 현재 종가' : '일별 로그 수익률 표준편차 × √252 · 연율'} />)}</div>
        <BreadthChart dates={dates} unit="%" label="시장 스트레스 비교 그래프" bounds={stressMetric === 'drawdown' ? [-100, 0] : [0, Math.max(100, ...r.benchmarks.flatMap(b => b.volatility.slice(-windowSize).filter((v): v is number => v !== null)))]}
          lines={r.benchmarks.map((b, i) => ({ label: b.name, values: b[stressMetric].slice(-windowSize), color: CHART_COLORS[i] }))} cursor={focusedDate} onCursor={setCursor} />
      </PanelCard>
    </Section>

    <Section id="causes" eyebrow="04 · 원점수는 왜 달라졌나" title="변화의 원인">
      <PanelCard className="breadth-panel">
        <div className="breadth-bar"><div><h3>종목별 점수 기여</h3><p>{change.from} → {change.to} · 원점수 {number(change.beforeScore)} → {number(change.score)}점</p></div><Horizon value={horizon} onChange={setHorizon} /></div>
        <div className="breadth-metrics breadth-three">
          <Metric label="상승 기여 합계" value={`${signed(change.positive)}점`} detail={`${change.improved}종목의 순기여 합계`} delta={change.positive} />
          <Metric label="하락 기여 합계" value={`${signed(change.negative)}점`} detail={`${change.declined}종목의 순기여 합계`} delta={change.negative} />
          <Metric label="전체 원점수 변화" value={`${signed(change.change)}점`} detail="전체 477종목 기여도의 합과 일치" delta={change.change} />
        </div>
        <div className="breadth-table-wrap"><table><caption>이평선별 원점수 변화 분해</caption><thead><tr><th>기준선</th><th>진입</th><th>이탈</th><th>순변화</th><th>점수 기여</th></tr></thead><tbody>{change.periods.map(p => <tr key={p.period}><th>{p.period}일선</th><td>{p.entry}종목</td><td>{p.exit}종목</td><td>{signed(p.net, 0)}종목</td><td className={direction(p.contribution)}>{signed(p.contribution, 4)}점</td></tr>)}</tbody></table></div>
        <div className="breadth-bar breadth-table-heading"><label className="breadth-search">종목 검색<input placeholder="종목명 또는 코드" value={stockSearch} onChange={e => setStockSearch(e.target.value)} /></label><label>기여 방향 <select aria-label="종목 기여 방향" value={stockFilter} onChange={e => setStockFilter(e.target.value)}><option value="changed">기여 변화 있음</option><option value="positive">상승 기여</option><option value="negative">하락 기여</option><option value="unchanged">순기여 0</option><option value="all">전체 종목</option></select></label></div>
        <div className="breadth-table-wrap"><table><caption>기여도 절댓값순 · 동점은 종목 코드순 · {stockRows.length}종목</caption><thead><tr><th>종목</th><th>상회 개수</th><th>20일선</th><th>60일선</th><th>120일선</th><th>원점수 기여</th></tr></thead><tbody>{stockRows.slice(0, stockLimit).map(s => <tr key={s.code}><th>{s.name}<small>{s.code}</small></th><td>{s.before} → {s.now}</td>{s.changes.map((v, i) => <td key={i} className={direction(v)}>{v > 0 ? '진입' : v < 0 ? '이탈' : '유지'}</td>)}<td className={direction(s.contribution)}>{signed(s.contribution, 4)}점</td></tr>)}</tbody></table></div>
        {stockRows.length === 0 && <PageState>조건에 맞는 종목이 없습니다.</PageState>}
        {stockLimit < stockRows.length && <ToolbarButton onClick={() => setStockLimit(v => v + 30)}>종목 더 보기 ({Math.min(stockLimit, stockRows.length)} / {stockRows.length})</ToolbarButton>}
        <p className="breadth-note">종목별 기여 = (현재 상회 개수 − 비교일 상회 개수) × 100 ÷ (477 × 3). 한 종목이 한 이평선에 새로 진입하면 약 +0.0699점입니다. 종목 수와 비중을 고정한 산술 분해이며, 가격 움직임의 경제적 원인을 설명하는 지표는 아닙니다. 표시는 반올림하며 합계 검증은 반올림 전 값으로 합니다.</p>
      </PanelCard>
    </Section>
    <PanelCard className="breadth-panel breadth-method"><details><summary>데이터 범위와 계산 기준</summary>
      <p>가격 기준일 {r.asOf} · 수정 기준일 {r.adjustedAsOf} · 편입 구성 기준일 {r.holdingsDate}. 공급자 확정 관측을 확보한 고정 자료입니다. 실시간 API 자동 갱신은 아직 연결하지 않았습니다.</p>
      <p>원점수는 ETF별 점수의 평균이 아닙니다. 기존 38개 ETF에서 중복을 제거한 477종목 각각에 동일한 가중치를 적용합니다. 현재 비교 가능한 액티브 4개의 편입 종목도 모두 이 집합 안에 있습니다. ETF별 점수는 해당 ETF의 직접 편입 국내 주식만으로 계산합니다.</p>
      <p>종가가 단순 이동평균을 엄격히 초과할 때만 상회로 셉니다. 동일 가격은 상회에 포함하지 않습니다. 현금·다른 ETF·파생상품은 제외하며 결측값은 0점으로 채우거나 분모를 줄이지 않습니다.</p>
      <p>원본 편입 구성은 패시브 38/38개·액티브 9/81개 대조를 완료했습니다. 나머지 액티브는 공통 API 자료 기준입니다. 현재 편입 종목을 과거로 확장한 분석이므로 생존·선정 편향이 남아 있고, 일별 관측도 서로 독립적인 표본은 아닙니다.</p>
      <p className="breadth-fingerprint select-text">확정 가격 지문 {r.sourceSnapshot}</p>
    </details></PanelCard>
  </div>;
}
