/**
 * LegendSymbolRow — 차트 캔버스 레전드 최상단(OHLC 행 위)의 종목 식별 행.
 *
 * 페이지 상태바(#865에서 폐지)의 종목 식별을 창 헤더가 아니라 TradingView 처럼
 * 차트 그리기 영역 안(PaneLegendOverlay 캔들 pane 최상단)으로 옮긴 것이다.
 * 레전드 컨테이너가 pointerEvents:none 이라 **표시 전용** — 하트/토글 같은
 * 인터랙션은 없고 수집 점·종목명·현재가·등락률·히트맵 그룹·경고칩만 그린다.
 *
 * 데이터는 대부분 전역 캐시 훅(useSymbols·useQuoteByCode·useHeatmap·수집 상태)
 * 으로 자체 조달하고, 현재가 폴백용 candles 와 경고칩 원료(hogaGapDates·백필
 * earliest 날짜)만 상위(LiveChartRoot)가 prop 으로 공급한다.
 */
import type { Candle } from '../api/types';
import type { LiveVenueOption } from '../state/liveVenue';
import { useConnectionLiveness } from '../api/useConnectionLiveness';
import { LIVE_STALE_MS } from '../api/liveness';
import { useQuoteByCode } from '../api/liveQuotes';
import { useSymbols } from '../capture/useSymbols';
import { useWatchlist } from '../watchlist/useWatchlist';
import { useWatchlistMembership } from '../watchlist/useWatchlistMembership';
import { useLiveStatus } from '../api/liveStatus';
import { useHeatmap } from '../heatmap/useHeatmap';
import { heatmapGroupNameOf } from '../heatmap/heat';
import { QuoteChange } from '../rightrail/QuoteChange';
import { CollectionDot } from './CollectionDot';
import { deriveCollectionView } from './collectionStatus';
import { resolveLiveCurrentPrice } from './deriveCurrentPriceLine';
import { captureHealthPillColor } from './captureHealthPill';
import { hogaCoverageGapTitle } from './hogaCoverageGap';
import { formatKoreanInt } from '../util/koreanNumber';

/** 안정 필드만 담는 종목 식별 입력 — 현재가/등락률은 LegendSymbolRow 가 자체 quote
 *  구독으로 갱신하므로 여기 넣지 않는다(PaneLegendOverlay memo 보존). 상위
 *  (ChartWindow)가 계산해 LiveChartRoot→PaneLegendOverlay 로 통과시킨다. */
export type SymbolLegendInput = {
  /** 주식 코드. null·`index:` 는 상위에서 게이트하므로 여기선 항상 유효 주식. */
  code: string;
  venue: LiveVenueOption;
  /** 캔들은 있는데 10호가 캡처가 없는 과거 거래일 — warn 칩. */
  hogaGapDates: readonly string[];
  /** 좌측 팬 딥 백필로 로드된 최고(最古) 거래일(YYYYMMDD). null 이면 진행 칩 미표시.
   *  게이트(isExtending·historicalFromDate·segments)는 ChartWindow 가 판정한다. */
  backfillEarliestDate: string | null;
};

type Props = SymbolLegendInput & {
  /** 현재가용 캔들(마지막 종가). PaneLegendOverlay 의 candles 를 그대로 전달.
   *  fresh 체결가(liveTradePrice)는 일부러 안 받는다 — 그건 LiveCurrentPriceLine
   *  이 담당하고, 여기에 넘기면 SSE 틱마다 PaneLegendOverlay memo 가 깨진다.
   *  레전드 현재가는 candles(캔들 epoch) + quote(자체 10s 구독)로 산출한다. */
  candles?: readonly Candle[];
};

export function LegendSymbolRow({
  code,
  venue,
  candles,
  hogaGapDates,
  backfillEarliestDate,
}: Props) {
  const live = useConnectionLiveness(LIVE_STALE_MS);

  const { data: symbolsData } = useSymbols();
  const symbolName = symbolsData?.symbols.find((s) => s.code === code)?.name;
  const symbolLabel = symbolName ? `${symbolName}(${code})` : code;

  // 전일대비(등락률) — 관심/스크리너 패널과 동일한 라이브 quote 단일 출처(ADR-0056).
  const quoteByCode = useQuoteByCode([code], venue);
  const quote = quoteByCode.get(code);

  // 현재가 = 사용가능 quote.price > 마지막 캔들 종가. fresh 체결가는 위 사유로 생략.
  const lastClose = candles && candles.length > 0 ? candles[candles.length - 1].close : null;
  const currentPrice = resolveLiveCurrentPrice(lastClose, quote, undefined);

  // 히트맵 그룹명 — 데이터 로드 전엔 숨겨 '없음'→그룹명 플리커 방지.
  const { data: heatmapData } = useHeatmap();
  const heatmapGroupName = heatmapData
    ? heatmapGroupNameOf(code, heatmapData.folders, heatmapData.entries)
    : null;
  const showHeatmapChip = !!heatmapData;

  const { isMember } = useWatchlistMembership();
  const member = isMember(code);

  // ADR-0067: 수집 상태 점(표시 전용) — 이 종목이 보이는 중이므로 viewedCodes=[code].
  const { data: watchlistData } = useWatchlist();
  const watchlistCodes = watchlistData?.entries.map((e) => e.code) ?? [];
  const { data: liveStatusData } = useLiveStatus();
  const collection = deriveCollectionView({
    code,
    liveSet: liveStatusData?.live_set ?? [],
    watchlistCodes,
    viewedCodes: [code],
    kiwoomCodes: liveStatusData?.kiwoom?.subscribed_codes ?? [],
    captureCandidate: watchlistData?.entries.some((e) =>
      e.code === code && e.capture_candidate !== false) ?? member,
    liveConnection: live,
  });

  return (
    <span
      data-testid="legend-symbol-row"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-2xs)',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      <CollectionDot status={collection.displayStatus} />
      <span style={{ color: 'var(--fg)', fontWeight: 600 }}>{symbolLabel}</span>
      {currentPrice !== null && (
        <span data-testid="legend-current-price" style={{ color: 'var(--fg)', fontWeight: 600 }}>
          {formatKoreanInt(currentPrice)}
        </span>
      )}
      {quote && (
        <span data-testid="legend-change">
          {/* 등락률(%)만 — 현재가가 이미 옆에 있어 등락액 생략(상태바·창헤더와 동일). */}
          <QuoteChange won={null} pct={quote.change_pct} />
        </span>
      )}
      {showHeatmapChip && (
        <span
          data-testid="legend-heatmap-group"
          style={{ color: heatmapGroupName === null ? 'var(--fg-dimmer)' : 'var(--fg-dim)' }}
          title={heatmapGroupName ? `히트맵 그룹: ${heatmapGroupName}` : '히트맵 그룹 없음'}
        >
          히트맵 · {heatmapGroupName ?? '없음'}
        </span>
      )}
      {backfillEarliestDate && (() => {
        const pill = captureHealthPillColor('ok');
        const md = `${Number(backfillEarliestDate.slice(4, 6))}/${Number(backfillEarliestDate.slice(6, 8))}`;
        return (
          <span
            data-testid="past-backfill-progress-chip"
            title={`과거 데이터 불러오는 중 — ${md}까지 로드됨`}
            style={{ background: pill.bg, border: pill.border, color: pill.fg, fontSize: 'var(--text-xs)', borderRadius: '4px', padding: '0 6px' }}
          >
            과거 로딩 중 · {md}까지
          </span>
        );
      })()}
      {hogaGapDates.length > 0 && (() => {
        const gapPill = captureHealthPillColor('warn');
        return (
          <span
            data-testid="hoga-coverage-gap-chip"
            title={hogaCoverageGapTitle(hogaGapDates)}
            style={{ background: gapPill.bg, border: gapPill.border, color: gapPill.fg, fontSize: 'var(--text-xs)', borderRadius: '4px', padding: '0 6px' }}
          >
            호가 미수집 {hogaGapDates.length}일
          </span>
        );
      })()}
    </span>
  );
}
