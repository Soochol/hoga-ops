/**
 * ChartWindowIdentity — 차트 창 헤더의 종목 식별 블록 (ADR-0119 후속).
 *
 * 페이지 상태바(LiveStatusBar)를 폐지하며 그 종목 식별·경고를 이 창 헤더로
 * 이관했다. 데이터는 창이 이미 소유한 것(bundle·liveTradePrice·hogaGapDates)을
 * prop 으로 받고, quote·히트맵·수집상태만 전역 캐시 훅으로 보강한다 — 상태바가
 * 쓰던 발행→구독(liveWindowStatusSource)이 통째로 사라졌다.
 *
 * 창별 스코프라 멀티창이면 각 창이 자기 종목의 현재가·등락률·수집상태를 보인다.
 * 진단 라벨(캔들 시간대 자동·호가 venue·소스칩·타임프레임)과 전역 캡처 헬스는
 * 이 블록에 없다: 타임프레임은 헤더의 TimeframeControl 과 중복이고, 캡처 헬스는
 * 종목 무관 전역이라 전역 툴바가 소유한다.
 */
import type { RangeBundle } from '../../api/types';
import type { LiveVenueOption } from '../../state/liveVenue';
import { useConnectionLiveness } from '../../api/useConnectionLiveness';
import { LIVE_STALE_MS } from '../../api/liveness';
import { useQuoteByCode } from '../../api/liveQuotes';
import { useWatchlist } from '../../watchlist/useWatchlist';
import { useWatchlistMembership } from '../../watchlist/useWatchlistMembership';
import { WatchlistHeartButton } from '../../watchlist/WatchlistHeartButton';
import { useLiveStatus } from '../../api/liveStatus';
import { useHeatmap } from '../../heatmap/useHeatmap';
import { heatmapGroupNameOf } from '../../heatmap/heat';
import { QuoteChange } from '../../rightrail/QuoteChange';
import { CollectionDot } from '../CollectionDot';
import { deriveCollectionView } from '../collectionStatus';
import { resolveLiveCurrentPrice } from '../deriveCurrentPriceLine';
import { captureHealthPillColor } from '../captureHealthPill';
import { hogaCoverageGapTitle } from '../hogaCoverageGap';

interface Props {
  /** 주식 코드. 지수 창은 null(수집·quote·히트맵·하트 없음). */
  stockCode: string | null;
  /** 표시 종목명(주식명 또는 지수명). code=이름 딥링크 시드면 코드일 수 있다. */
  symbolName: string | null;
  venue: LiveVenueOption;
  /** 창의 워크에어리어 bundle — 현재가 파생(마지막 캔들 종가 폴백). */
  bundle: RangeBundle | null;
  /** 창이 환원한 fresh 체결가 — 현재가 산출식 최우선 항. */
  liveTradePrice: number | null;
  /** 캔들은 있는데 10호가 캡처가 없는 과거 거래일 — warn 칩. */
  hogaGapDates: readonly string[];
  /** 좌측 팬 딥 백필 진행 — 진행 칩 게이트. */
  isExtending: boolean;
  /** 딥 백필 from-date — null 이면 fresh 뷰(진행 칩 미표시). */
  historicalFromDate: string | null;
}

export function ChartWindowIdentity({
  stockCode,
  symbolName,
  venue,
  bundle,
  liveTradePrice,
  hogaGapDates,
  isExtending,
  historicalFromDate,
}: Props) {
  const live = useConnectionLiveness(LIVE_STALE_MS);

  const symbolLabel = stockCode
    ? (symbolName ? `${symbolName}(${stockCode})` : stockCode)
    : (symbolName ?? '—');

  // 전일대비(등락률) — 관심/스크리너 패널과 동일한 라이브 quote 단일 출처(ADR-0056).
  const quoteByCode = useQuoteByCode(stockCode ? [stockCode] : [], venue);
  const quote = stockCode ? quoteByCode.get(stockCode) : undefined;

  // 현재가 = fresh 체결가 > 사용가능 quote.price > 마지막 캔들 종가(라인=헤더 invariant).
  const lastCandle = bundle && bundle.candles.length > 0
    ? bundle.candles[bundle.candles.length - 1]
    : null;
  const currentPrice = resolveLiveCurrentPrice(lastCandle?.close ?? null, quote, liveTradePrice);

  // 히트맵 그룹명 — 주식만(지수는 대상 아님). 데이터 로드 전엔 숨겨 플리커 방지.
  const { data: heatmapData } = useHeatmap();
  const showHeatmapChip = !!stockCode && !!heatmapData;
  const heatmapGroupName = showHeatmapChip
    ? heatmapGroupNameOf(stockCode!, heatmapData!.folders, heatmapData!.entries)
    : null;

  const { isMember } = useWatchlistMembership();
  const member = !!stockCode && isMember(stockCode);

  // ADR-0067: 수집 상태 점 — 이 창의 종목이 보이는 중이므로 viewedCodes=[stockCode].
  const { data: watchlistData } = useWatchlist();
  const watchlistCodes = watchlistData?.entries.map((e) => e.code) ?? [];
  const { data: liveStatusData } = useLiveStatus();
  const liveSet = liveStatusData?.live_set ?? [];
  const collection = deriveCollectionView({
    code: stockCode,
    liveSet,
    watchlistCodes,
    viewedCodes: stockCode ? [stockCode] : [],
    kiwoomCodes: liveStatusData?.kiwoom?.subscribed_codes ?? [],
    captureCandidate: watchlistData?.entries.some((e) =>
      e.code === stockCode && e.capture_candidate !== false) ?? member,
    liveConnection: live,
  });

  // 진행 칩용 최고(最古) 로드 날짜 — segments 오름차순이라 [0] 이 가장 과거.
  const showBackfillProgress = isExtending && historicalFromDate != null
    && !!bundle && bundle.segments.length > 0;
  const earliestLoadedDate = showBackfillProgress ? bundle!.segments[0].date : null;

  return (
    <div
      data-testid="chart-window-identity"
      className="flex min-w-0 items-center gap-1.5 whitespace-nowrap"
      style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-dim)', fontVariantNumeric: 'tabular-nums' }}
    >
      <span className="inline-flex min-w-0 items-center gap-1">
        {stockCode && <CollectionDot status={collection.displayStatus} />}
        <span className="font-data truncate" style={{ color: 'var(--fg)' }}>
          {symbolLabel}
        </span>
      </span>
      {stockCode && (
        <WatchlistHeartButton code={stockCode} name={symbolName ?? undefined} variant="status" />
      )}
      {currentPrice !== null && (
        <>
          <span aria-hidden className="text-fg-dimmer">·</span>
          <span
            data-testid="chart-window-current-price"
            className="font-data shrink-0"
            style={{ color: 'var(--fg)', fontWeight: 600, letterSpacing: 0 }}
          >
            {currentPrice.toLocaleString('ko-KR')}
          </span>
        </>
      )}
      {quote && (
        <span className="font-data shrink-0" data-testid="chart-window-change">
          {/* 등락률(%)만 — 현재가가 이미 옆에 있고 헤더가 좁아 등락액 생략. */}
          <QuoteChange won={null} pct={quote.change_pct} />
        </span>
      )}
      {showHeatmapChip && (
        <>
          <span aria-hidden className="text-fg-dimmer">·</span>
          <span
            data-testid="chart-window-heatmap-group"
            title={heatmapGroupName ? `히트맵 그룹: ${heatmapGroupName}` : '히트맵 그룹 없음'}
            className="shrink-0 truncate"
            style={heatmapGroupName === null ? { color: 'var(--fg-dimmer)' } : undefined}
          >
            히트맵 · {heatmapGroupName ?? '없음'}
          </span>
        </>
      )}
      {showBackfillProgress && earliestLoadedDate && (() => {
        const pill = captureHealthPillColor('ok');
        const md = `${Number(earliestLoadedDate.slice(4, 6))}/${Number(earliestLoadedDate.slice(6, 8))}`;
        return (
          <span
            data-testid="past-backfill-progress-chip"
            title={`과거 데이터 불러오는 중 — ${md}까지 로드됨`}
            className="font-data px-1.5 py-0.5 rounded whitespace-nowrap shrink-0"
            style={{ background: pill.bg, border: pill.border, color: pill.fg, fontSize: 'var(--text-xs)' }}
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
            className="font-data px-1.5 py-0.5 rounded whitespace-nowrap shrink-0"
            style={{ background: gapPill.bg, border: gapPill.border, color: gapPill.fg, fontSize: 'var(--text-xs)' }}
          >
            호가 미수집 {hogaGapDates.length}일
          </span>
        );
      })()}
    </div>
  );
}
