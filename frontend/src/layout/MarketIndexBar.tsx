/** 전역 한 줄 시장지표 바 — 지수 ↔ 투자자 순매수를 10초마다 전환.
 *
 * App 셸 3번째 grid 행(auto)에 앉는다: 데이터가 없으면(자격증명/용량 부재,
 * 초기 로딩) null 을 반환해 행이 0으로 접힌다 — 고정 높이 행이 빈 띠로
 * 남지 않게 하는 계약. 높이는 --h-bottom-bar 토큰.
 *
 * 색 규율(DESIGN.md): 등락은 가격 방향 카테고리(priceDirClass, 색+부호 2중),
 * 라벨은 --fg-dim, 값은 mono --fg. 지수 클릭 = 해당 지수를 /live 현재 뷰로 연다
 * (activateLiveInstrument — 단일 뷰 제자리 교체, ADR-0113). */
import { useNowMs } from '../util/useNowMs';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useLiveStatus } from '../api/liveStatus';
import { useMarketIndexQuotes, type MarketIndexQuote } from '../api/marketIndexQuotes';
import { useMarketInvestorFlowSummary, type InvestorFlowSummaryGroup } from '../api/marketInvestorFlowSummary';
import { indexInstrument, isLiveIndexId } from '../live/liveInstrument';
import { activateLiveInstrument } from '../live/liveNavigate';
import { priceDirClass } from '../ui/priceDir';
import { flowStatus } from '../market/flowStatus';
import { fmtSigned } from '../market/marketFormat';

const ROTATE_MS = 10_000;
const ACTORS = [['foreign', '외인'], ['institution', '기관'], ['individual', '개인']] as const;
const STATUS_LABELS = {
  waiting: '수신 대기', receiving: '', delayed: '수신 지연', closed: '',
  unavailable: '수집 설정 없음', unknown: '수신 상태 확인 불가',
};

function InvestorFlowItem({ group, market, label, receivedAt, nowMs, error }: {
  group: InvestorFlowSummaryGroup;
  market: string;
  label: string;
  receivedAt: number;
  nowMs: number;
  error: boolean;
}) {
  const point = group.markets[market];
  const health = group.collection?.targets[market];
  const status = group.collection && health
    ? flowStatus(group.collection, health, Math.max(0, nowMs - receivedAt)) : 'unknown';
  const unitKnown = group.unit === 'amt_eok';
  const statusLabel = error ? '연결 지연' : !unitKnown && point ? '단위 확인 중' : STATUS_LABELS[status];
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(nowMs).replaceAll('-', '');
  const dateLabel = group.date !== today ? `${group.date.slice(4, 6)}/${group.date.slice(6, 8)}` : '';
  const received = health?.last_success_at_ms;
  const stamp = received != null
    ? new Date(received).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false }) : '없음';
  return (
    <div
      data-market-bar-content
      data-testid={`market-flow-${market}`}
      className="flex shrink-0 items-baseline gap-1.5 px-1.5"
      title={`${group.date} · 당일 누적 순매수 · ${group.confirmed ? '확정' : '잠정'} · 마지막 정상 수신 ${stamp}${statusLabel ? ` · ${statusLabel}` : ''}`}
    >
      <span className="font-ui text-xs text-fg-dim">{label}</span>
      {dateLabel && <span className="font-data text-xs text-fg-dim">{dateLabel}</span>}
      {ACTORS.map(([key, actor]) => {
        const value = unitKnown ? point?.[key] : null;
        return (
          <span key={key} className="flex items-baseline gap-1">
            <span className="font-ui text-xs text-fg-dim">{actor}</span>
            <span className={`font-data text-xs tabular-nums ${value == null ? 'text-fg-dim' : priceDirClass(value)}`}>
              {fmtSigned(value)}
            </span>
          </span>
        );
      })}
      {statusLabel && <span className={`font-ui text-xs ${error || status === 'delayed' ? 'text-warn' : 'text-fg-dim'}`}>{statusLabel}</span>}
    </div>
  );
}

const VALUE_FORMAT = new Intl.NumberFormat('ko-KR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatChange(quote: MarketIndexQuote): string {
  const sign = quote.change > 0 ? '+' : '';
  return `${sign}${VALUE_FORMAT.format(quote.change)} (${sign}${quote.changeRate.toFixed(2)}%)`;
}

function MarketIndexItem({ quote, nowMs }: { quote: MarketIndexQuote; nowMs: number }) {
  const ageSeconds = Math.max(0, Math.floor((nowMs - quote.tMs) / 1000));
  const navigate = useNavigate();
  const openable = isLiveIndexId(quote.id);

  const open = () => {
    if (!isLiveIndexId(quote.id)) return;
    activateLiveInstrument(indexInstrument(quote.id, quote.label));
    navigate('/live');
  };

  return (
    <button
      type="button"
      onClick={open}
      disabled={!openable}
      aria-label={`${quote.label} 차트 열기`}
      title={`시세 기준 ${new Date(quote.tMs).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`}
      className="flex shrink-0 items-baseline gap-1.5 rounded-md px-1.5 hover:bg-bg-input-hover disabled:cursor-default disabled:hover:bg-transparent"
    >
      <span className="font-ui text-xs text-fg-dim">{quote.label}</span>
      {ageSeconds >= 90 && <span className="font-ui text-xs text-fg-dim">시세 {Math.floor(ageSeconds / 60)}분 전</span>}
      <span className="font-data text-xs text-fg">{VALUE_FORMAT.format(quote.value)}</span>
      <span className={`font-data text-xs ${priceDirClass(quote.change)}`}>
        {formatChange(quote)}
      </span>
    </button>
  );
}

/** 키움 WS 실시간 커버리지 칩 — KIS WS + 키움 WS로 push 수집 중인 종목 수(ADR-0116).
 * 키움 미배선(kiwoom null)이면 렌더 안 함. 저하(계정 일부 미연결) 시 숫자를 --warn 로
 * 물들여 '장애=게이지 하락' 신호. 지수 아이템과 같은 시각 문법(dim 라벨 + mono 값). */
function CoverageChip({ leadingDivider }: { leadingDivider: boolean }) {
  const { data } = useLiveStatus();
  const k = data?.kiwoom;
  if (!data || k == null) return null;
  const total = k.ready_codes?.length ?? k.subscribed_count;
  const degraded = k.connected_accounts < k.accounts_configured || k.registration_incomplete;
  return (
    <div data-market-bar-content className="flex shrink-0 items-center gap-1" data-testid="kiwoom-coverage-chip">
      {leadingDivider && <span aria-hidden className="h-3 w-px bg-border" />}
      <span
        className="flex items-baseline gap-1 px-1.5"
        title={`키움 구독 확인 ${total}/${k.subscribed_count}종목 (연결 ${k.connected_accounts}/${k.accounts_configured}계정)`}
      >
        <span className="font-ui text-xs text-fg-dim">실시간</span>
        <span className={`font-data text-xs ${degraded ? 'text-warn' : 'text-fg'}`}>{total}</span>
        <span className="font-ui text-xs text-fg-dim">종목</span>
      </span>
    </div>
  );
}

export function MarketIndexBar() {
  const nowMs = useNowMs(10_000);
  const { data } = useMarketIndexQuotes();
  const { data: status } = useLiveStatus();
  const flow = useMarketInvestorFlowSummary();
  const [page, setPage] = useState({ mode: 'indices' as 'indices' | 'flow', revision: 0 });
  const [autoRotate, setAutoRotate] = useState(true);
  const hasIndices = data != null && data.length > 0;
  const hasKiwoom = status?.kiwoom != null;
  const summary = flow.data;
  const hasFlow = summary != null && [summary.stock, summary.futures]
    .some((group) => Object.values(group.markets).some((point) => point != null));
  const canRotate = hasIndices && hasFlow;
  const showFlow = hasFlow && (!hasIndices || page.mode === 'flow');
  // 값이 없는 페이지로 자동 전환하지 않는다. 클릭은 다음 전환까지 10초를 보장한다.
  useEffect(() => {
    if (!canRotate || !autoRotate) return;
    const timer = window.setInterval(() => {
      setPage((previous) => ({ ...previous, mode: previous.mode === 'indices' ? 'flow' : 'indices' }));
    }, ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [canRotate, autoRotate, page.revision]);

  const switchPage = () => {
    if (!canRotate) return;
    setPage((previous) => ({
      mode: previous.mode === 'indices' ? 'flow' : 'indices', revision: previous.revision + 1,
    }));
  };
  if (!hasIndices && !hasKiwoom && !hasFlow) return null;

  return (
    <footer
      data-testid="market-index-bar"
      aria-label="시장지표"
      data-page={showFlow ? 'flow' : 'indices'}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (!target.closest('button, [data-market-bar-content]')) switchPage();
      }}
      className="flex h-bottom-bar min-w-0 items-center gap-1 bg-bg px-2"
    >
      <div className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
      {showFlow && summary ? (
        <>
          <InvestorFlowItem group={summary.stock} market="KOSPI" label="코스피" receivedAt={flow.dataUpdatedAt} nowMs={nowMs} error={flow.isError} />
          <span aria-hidden className="h-3 w-px shrink-0 bg-border" />
          <InvestorFlowItem group={summary.stock} market="KOSDAQ" label="코스닥" receivedAt={flow.dataUpdatedAt} nowMs={nowMs} error={flow.isError} />
          <span aria-hidden className="h-3 w-px shrink-0 bg-border" />
          <InvestorFlowItem group={summary.futures} market="F001" label="K200 선물" receivedAt={flow.dataUpdatedAt} nowMs={nowMs} error={flow.isError} />
        </>
      ) : hasIndices &&
        data.map((quote, i) => (
          <div key={quote.id} className="flex shrink-0 items-center gap-1">
            {i > 0 && <span aria-hidden className="h-3 w-px bg-border" />}
            <MarketIndexItem quote={quote} nowMs={nowMs} />
          </div>
        ))}
      {canRotate && (
        <button
          type="button"
          data-testid="market-bar-switch"
          aria-label={showFlow ? '지수 화면으로 전환' : '투자자 수급 화면으로 전환'}
          title="빈 영역 클릭으로 전환 · 10초마다 자동 전환"
          onClick={switchPage}
          className="h-full min-w-6 shrink-0 self-stretch rounded-sm px-1 text-xs text-fg-dim hover:bg-bg-input-hover"
        >{showFlow ? '지수 ›' : '수급 ›'}</button>
      )}
      </div>
      {canRotate && <button type="button" aria-label="시장지표 자동 전환" aria-pressed={autoRotate}
        title={autoRotate ? '10초마다 자동 전환 · 누르면 일시 정지' : '자동 전환 일시 정지 · 누르면 재개'}
        onClick={() => setAutoRotate(value => !value)} className="shrink-0 rounded px-1 text-xs text-fg-dim hover:bg-bg-input-hover">
        {autoRotate ? '자동' : '정지'}
      </button>}
      <CoverageChip leadingDivider={hasIndices || hasFlow} />
    </footer>
  );
}
