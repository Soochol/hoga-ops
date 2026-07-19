/**
 * DataWindow — 워크스페이스 데이터 창의 실 콘텐츠 (ADR-0119 PR-C2c-1).
 *
 * 비차트 창(10호가·거래원·잠정투자자 등)에 실제 사이드바 카드를 **LATEST 모드**로
 * 렌더한다. 각 창은 그룹→종목의 code 로 자기 데이터를 구독한다.
 *
 * LATEST 모드 데이터는 `live`(SSE 스냅샷) + per-code 쿼리로 흐른다(LiveSidebar 의
 * latest 경로와 동일). 크로스윈도우 커서(hover 스팟 모드)는 PR-D(크로스헤어 버스)
 * 소관이라 여기선 latest 만.
 *
 * 프로그램·매물대는 번들(timeframe 종속)이 필요해 차트 창 timeframe 연동(PR-D)이
 * 선행돼야 한다 — C2c-1 에서는 안내 카드로 표시한다.
 *
 * kind 별로 필요한 훅이 다르므로 하위 컴포넌트로 분기한다(한 컴포넌트에서 조건부
 * 훅 호출 금지 — 각 하위 컴포넌트가 자기 훅만 무조건 호출).
 */
import { useMemo } from 'react';
import OrderbookTable from '../../sidebar/OrderbookTable';
import TotalQtyBar from '../../sidebar/TotalQtyBar';
import BrokerTrajectoryTable from '../../sidebar/BrokerTrajectoryTable';
import { InvestorTrendEstimateCard } from '../../sidebar/InvestorTrendEstimateCard';
import { useLiveSeries } from '../../api/liveSeries';
import { useLiveInvestorTrendEstimate } from '../../api/liveInvestorTrendEstimate';
import { useQuoteByCode } from '../../api/liveQuotes';
import { useLiveVenueStore } from '../../state/liveVenue';
import { aggregateBrokerSeries, latestOrderbookSnapshot } from '../liveSidebarAdapters';
import { SectorRankingWindow } from './SectorRankingWindow';
import { isLiveIndexId } from '../liveInstrument';
import type { GroupSymbol, WorkspaceWindow, WindowKind } from '../../state/workspace';

const KIND_LABEL: Record<WindowKind, string> = {
  chart: '차트',
  book: '10호가',
  broker: '거래원',
  vdist: '매물대',
  program: '프로그램',
  investor: '잠정투자자',
  'sector-ranking': '섹터 랭킹',
};

export function DataWindow({ win, symbol }: { win: WorkspaceWindow; symbol: GroupSymbol | null }) {
  // 섹터 랭킹은 지수 그룹 전용 데이터 창(PR-D) — 일반 지수 게이트보다 먼저 처리한다
  // (지수에서 유일하게 허용되는 kind). 주식·미지정 그룹에는 안내 카드.
  if (win.kind === 'sector-ranking') {
    if (symbol?.kind === 'index' && isLiveIndexId(symbol.code)) {
      return <SectorRankingWindow indexId={symbol.code} />;
    }
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg-subtle/40 text-center text-[11px] text-fg-dimmer">
        <span className="font-mono">
          {KIND_LABEL[win.kind]} · 지수 그룹 전용
          <br />
          {symbol ? `${symbol.name} 은 지수가 아닙니다` : `종목 없음 (그룹 ${win.group})`}
        </span>
      </div>
    );
  }
  // 지수는 호가/거래원/투자자 데이터가 없다 — 구독 오염 대신 안내 카드(C2c-2c).
  if (symbol?.kind === 'index') {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg-subtle/40 text-center text-[11px] text-fg-dimmer">
        <span className="font-mono">
          {KIND_LABEL[win.kind]} · {symbol.name}
          <br />
          지수는 지원하지 않습니다
        </span>
      </div>
    );
  }
  const code = symbol?.code ?? null;
  if (!code) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg-subtle/40 text-[11px] text-fg-dimmer">
        <span className="font-mono">
          {KIND_LABEL[win.kind]} · 종목 없음 (그룹 {win.group})
        </span>
      </div>
    );
  }
  switch (win.kind) {
    case 'book':
      return <BookWindow code={code} />;
    case 'broker':
      return <BrokerWindow code={code} />;
    case 'investor':
      return <InvestorWindow code={code} />;
    default:
      // 프로그램·매물대: 번들(timeframe) 종속 → 차트 창 연동(PR-D) 후 실 콘텐츠.
      return (
        <div className="flex h-full w-full items-center justify-center bg-bg-subtle/40 text-center text-[11px] text-fg-dimmer">
          <span className="font-mono">
            {KIND_LABEL[win.kind]} · {symbol?.name ?? code}
            <br />
            차트 timeframe 연동 필요 (PR-D)
          </span>
        </div>
      );
  }
}

function BookWindow({ code }: { code: string }) {
  const live = useLiveSeries(code);
  const venue = useLiveVenueStore((s) => s.venue);
  const snapshot = useMemo(() => latestOrderbookSnapshot(live.ob), [live.ob]);
  const quote = useQuoteByCode([code], venue).get(code);
  const baselinePrice = quote?.baseline_price ?? null;
  return (
    <div className="h-full overflow-auto">
      <OrderbookTable snapshot={snapshot} baselinePrice={baselinePrice} />
      <TotalQtyBar snapshot={snapshot} maskRatio={false} />
    </div>
  );
}

function BrokerWindow({ code }: { code: string }) {
  const live = useLiveSeries(code);
  const series = useMemo(() => aggregateBrokerSeries(live.broker), [live.broker]);
  // 비었을 때 fallback 은 null — 시리즈도 비어 표시가 동일하므로 Date.now()(impure) 불필요.
  const cursorMs = live.broker.length > 0 ? (live.broker[live.broker.length - 1].t_ms as number) : null;
  return (
    <div className="h-full overflow-auto">
      <BrokerTrajectoryTable series={series} cursorMs={cursorMs} />
    </div>
  );
}

function InvestorWindow({ code }: { code: string }) {
  const query = useLiveInvestorTrendEstimate(code);
  return (
    <div className="h-full overflow-auto">
      <InvestorTrendEstimateCard query={query} />
    </div>
  );
}
