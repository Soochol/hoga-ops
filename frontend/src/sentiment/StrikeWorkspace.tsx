import { useMemo, useState, type ReactNode } from 'react';
import type { OptionSentiment } from '../api/optionSentiment';
import { CardHeader, EmptyNote, MarketCard, ModeSwitch } from '../market/marketCardBits';
import { GexChart, IvSkewChart, OiContributors, OiDistributionChart, type StrikeSelection } from './SentimentPanels';
import { fmtCompact } from './sentimentFormat';
import { nearestStrike, type StrikeDomain } from './strikeScale';

/** One exact strike drives all charts and the readout; never borrow a nearby quote. */
export function StrikeWorkspace({ data, domain, range, onRangeChange, fullStamp, atmStamp, putCall }: {
  data: OptionSentiment;
  domain: StrikeDomain | null;
  range: 'atm' | 'all';
  onRangeChange: (range: 'atm' | 'all') => void;
  fullStamp: ReactNode;
  atmStamp: ReactNode;
  putCall: ReactNode;
}) {
  const [requestedStrike, setRequestedStrike] = useState<number | null>(null);
  const maps = useMemo(() => ({
    oi: new Map((data.oi_distribution?.strikes ?? []).map(r => [r.strike, r])),
    gex: new Map((data.gamma_exposure?.points ?? []).map(r => [r.strike, r])),
    iv: new Map((data.iv_skew?.points ?? []).map(r => [r.strike, r])),
  }), [data.oi_distribution, data.gamma_exposure, data.iv_skew]);
  const strikes = useMemo(() => [...maps.oi.keys()].filter(k => domain && k >= domain.lo && k <= domain.hi).sort((a, b) => a - b), [maps.oi, domain]);
  const selected = nearestStrike(strikes, requestedStrike ?? data.underlying ?? strikes[0]);
  const selection: StrikeSelection = { strike: selected, strikes, onChange: setRequestedStrike };
  const oi = selected === null ? undefined : maps.oi.get(selected);
  const gex = selected === null ? undefined : maps.gex.get(selected);
  const iv = selected === null ? undefined : maps.iv.get(selected);
  const chooseContributor = (strike: number) => {
    onRangeChange('all');
    setRequestedStrike(strike);
  };
  const index = selected === null ? 0 : Math.max(0, strikes.indexOf(selected));
  const reference = (value: number | null | undefined, label: string) => value == null ? `${label} —` : `${label} ${value.toLocaleString('ko-KR')}${domain && (value < domain.lo || value > domain.hi) ? ' · 축 밖' : ''}`;
  return <div className="sentiment-structure grid gap-md">
    <MarketCard className="sentiment-workspace flex flex-col gap-sm p-md">
      <CardHeader title="행사가 구조" right={<ModeSwitch value={range} onChange={onRangeChange} options={[
        ['atm', 'ATM 근처'], ['all', '전체'],
      ]} label="행사가 축 범위" />} />
      <div className="sentiment-references flex flex-wrap items-baseline gap-x-lg gap-y-xs font-data text-xs text-fg-dim tabular-nums">
        <span className="sentiment-reference-current">현재 {data.underlying?.toFixed(2) ?? '—'}</span>
        <span>{reference(data.oi_distribution?.max_pain, 'Max Pain')}</span>
        <span>{reference(data.gamma_exposure?.flip_strike, '플립')}</span>
      </div>
      {data.oi_distribution && <section className="sentiment-chart-row" aria-label="미결제약정 분포">
        <div className="sentiment-chart-heading"><h2>행사가별 미결제약정 · Max Pain</h2><div className="sentiment-legend"><span className="sentiment-call-key">콜</span><span className="sentiment-put-key">풋</span><span>계약</span></div></div>
        <div className="sentiment-stamp">{fullStamp}</div>
        {domain ? <OiDistributionChart dist={data.oi_distribution} underlying={data.underlying} domain={domain} selection={selection} /> : <EmptyNote>행사가 축을 구성할 데이터가 없습니다.</EmptyNote>}
        <p className="sentiment-caveat">위 빨강이 콜, 아래 파랑이 풋입니다. Max Pain은 만기 시 옵션 매도자 손실이 최소가 되는 지점일 뿐 가격 예측이 아닙니다.</p>
      </section>}
      {data.gamma_exposure && <section className="sentiment-chart-row" aria-label="감마 익스포저">
        <div className="sentiment-chart-heading"><h2>감마 익스포저 (GEX)</h2><span className="text-xs text-fg-dim">1% 이동당 · 원</span></div>
        <div className="sentiment-stamp">{fullStamp}</div>
        {domain && <GexChart gex={data.gamma_exposure} underlying={data.underlying} domain={domain} selection={selection} />}
        <p className="sentiment-caveat">방향 지표가 아니라 변동성 체제 지표입니다. 양수는 움직임 억제, 음수는 증폭으로 읽습니다. 부호는 '딜러가 콜을 팔고 풋을 산다'는 관례적 가정에서 나오며 검증할 수 없습니다.</p>
      </section>}
      {data.iv_skew && <section className="sentiment-chart-row" aria-label="내재변동성">
        <div className="sentiment-chart-heading"><h2>내재변동성 스마일</h2><div className="sentiment-legend"><span className="sentiment-call-key">콜</span><span className="sentiment-put-key">풋</span><span>%</span></div></div>
        <div className="sentiment-stamp">곡선 {fullStamp} · {atmStamp}</div>
        {domain && <IvSkewChart skew={data.iv_skew} underlying={data.underlying} domain={domain} selection={selection} />}
        <p className="sentiment-caveat">IV 절대값은 그 자체로 정보량이 적습니다 — 주식 옵션은 구조적으로 항상 풋이 비쌉니다. 자기 히스토리 대비로 읽어야 의미가 생깁니다. ATM IV와 리스크리버설만 30초 주기로 갱신됩니다.</p>
      </section>}
      <div className="sentiment-inspector border-t border-border pt-sm">
        <div className="flex flex-wrap items-center gap-md">
          <label htmlFor="sentiment-strike" className="text-xs text-fg-dim">선택 행사가 <strong className="font-data text-sm font-semibold text-fg tabular-nums">{selected?.toLocaleString('ko-KR') ?? '—'}</strong></label>
          <input id="sentiment-strike" type="range" min={0} max={Math.max(0, strikes.length - 1)} step={1} value={index}
            disabled={strikes.length < 2} aria-label="비교할 행사가" aria-valuetext={selected?.toLocaleString('ko-KR') ?? '행사가 없음'}
            onChange={e => { const next = strikes[Number(e.target.value)]; if (next !== undefined) setRequestedStrike(next); }} />
        </div>
        <dl className="sentiment-strike-values mt-sm grid gap-sm font-data text-xs tabular-nums" aria-label="선택 행사가 상세">
          <div><dt>콜 OI / 풋 OI · 계약</dt><dd>{oi ? `${oi.call_oi.toLocaleString('ko-KR')} / ${oi.put_oi.toLocaleString('ko-KR')}` : '— / —'}</dd></div>
          <div><dt>GEX · 1% 이동당</dt><dd>{gex ? `${fmtCompact(gex.gex)}원` : '—'}</dd></div>
          <div><dt>콜 IV / 풋 IV · %</dt><dd>{iv?.call_iv?.toFixed(2) ?? '—'} / {iv?.put_iv?.toFixed(2) ?? '—'}</dd></div>
        </dl>
      </div>
    </MarketCard>
    <aside className="sentiment-sidebar flex min-w-0 flex-col gap-md" aria-label="비율과 미결제 집중도">
      {putCall}
      {data.oi_distribution && <MarketCard className="flex flex-col gap-sm p-md">
        <CardHeader title="미결제 상위 행사가" hint="전체 체인" />
        <div className="sentiment-stamp">{fullStamp}</div>
        <div className="sentiment-table-scroll"><OiContributors dist={data.oi_distribution} underlying={data.underlying} onSelect={chooseContributor} selectedStrike={selected} /></div>
        <p className="sentiment-caveat">Max Pain과 감마 플립이 무엇에 끌려간 값인지 보여줍니다. KOSPI200은 델타가 0에 가까운 극외가에 미결제가 몰리는 특성이 있습니다. 축 범위와 무관하게 전 행사가 기준입니다.</p>
      </MarketCard>}
    </aside>
  </div>;
}
