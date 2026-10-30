import { AppIcon } from '../../ui/AppIcon';
import { useStockDescriptionTooltip } from '../../heatmap/StockDescriptionTooltip';
import { isLiveIndexId, usStockFromKey } from '../liveInstrument';
import { IndexTitleBarSymbolRow } from './IndexTitleBarSymbolRow';
/**
 * TitleBarSymbolRow — 차트 창 타이틀바(제목 표시줄)의 종목 식별 행.
 *
 * 종목명·현재가·등락률·히트맵 그룹·수집 점·경고칩을 창 제목 줄에 표시한다(#869의
 * 캔버스 레전드에서 여기로 이관 — 사용자가 원한 "마우스로 창을 드래그하는 영역").
 * 대표지수는 IndexTitleBarSymbolRow에서 독립된 지수 시세 경로를 사용한다.
 * 타이틀바는 창 데이터 파이프라인(useLiveChartData)의 **부모**라 번들 파생값에
 * 직접 못 닿으므로:
 *  - 현재가·등락률·히트맵·수집상태는 `code` 만으로 전역 캐시 훅에서 self-fetch,
 *  - 경고칩(과거 로딩)만 windowWarnings 채널을 `windowId` 로 구독한다.
 *
 * 현재가는 candles 폴백이 없어(타이틀바 스코프 밖) quote.price 를 직접 쓴다 —
 * 장중 실시간 시세면 채워지고, 없으면(장전·오프라인) 예약된 칸에 — 를 표시한다.
 */
import { useEffectiveVenue } from '../useEffectiveVenue';
import { useLiveVenueStore } from '../../state/liveVenue';
import { useConnectionLiveness } from '../../api/useConnectionLiveness';
import { LIVE_STALE_MS } from '../../api/liveness';
import { useQuoteByCode, isStaleLiveQuote } from '../../api/liveQuotes';
import { useWatchlist } from '../../watchlist/useWatchlist';
import { useLiveStatus } from '../../api/liveStatus';
import { useHeatmap } from '../../heatmap/useHeatmap';
import { heatmapGroupNameOf } from '../../heatmap/heat';
import { QuoteChange } from '../../rightrail/QuoteChange';
import { CollectionDot } from '../CollectionDot';
import { deriveCollectionView } from '../collectionStatus';
import { captureHealthPillColor } from '../captureHealthPill';
import { formatKoreanInt } from '../../util/koreanNumber';
import { useWindowWarnings } from './windowWarningsSource';

interface Props {
  /** 창 제목 종목명(그룹 스토어의 symbol.name). code=name 딥링크면 코드일 수 있다. */
  name: string | null;
  /** 창 종목 식별자(국내 Code, 대표지수 ID 또는 미국 종목 키). */
  code: string;
  /** 지수·미국 종목이면 국내 주식 전용 시세/수집 조회를 차단한다. */
  isIndex: boolean;
  /** 경고칩 구독 키 — ChartWindowInner 가 windowWarnings 로 발행한다. */
  windowId: string;
}

export function TitleBarSymbolRow({ name, code, isIndex, windowId }: Props) {
  const indexId = code.startsWith('index:') ? code.slice(6) : code;
  if (isIndex && isLiveIndexId(indexId)) {
    return <IndexTitleBarSymbolRow key={indexId} name={name} indexId={indexId} windowId={windowId} />;
  }
  return <StockTitleBarSymbolRow key={code} name={name} code={code} isIndex={isIndex} windowId={windowId} />;
}

function StockTitleBarSymbolRow({ name, code, isIndex, windowId }: Props) {
  const tooltip = useStockDescriptionTooltip();
  const live = useConnectionLiveness(LIVE_STALE_MS);
  const venue = useLiveVenueStore((s) => s.venue);
  const effectiveVenue = useEffectiveVenue(code, venue);

  const usStock = usStockFromKey(code);
  const displayCode = usStock?.kind === 'us_stock' ? `${usStock.symbol} · ${usStock.exchange}` : code;

  // 현재가·등락률 — 관심/스크리너 패널과 동일한 라이브 quote 단일 출처(ADR-0056).
  // 타이틀바는 candles 폴백이 없어 quote.price 를 직접 쓴다(stale·0·비유한 배제).
  const quoteByCode = useQuoteByCode(isIndex ? [] : [code], venue);
  const quote = isIndex ? undefined : quoteByCode.get(code);
  const currentPrice =
    quote && !isStaleLiveQuote(quote) && Number.isFinite(quote.price) && quote.price > 0
      ? quote.price
      : null;

  // 히트맵 그룹명 — 주식만. 데이터 로드 전엔 숨겨 '없음'→그룹명 플리커 방지.
  const { data: heatmapData } = useHeatmap();
  const showHeatmapChip = !isIndex && !!heatmapData;
  const heatmapGroupName = showHeatmapChip
    ? heatmapGroupNameOf(code, heatmapData!.folders, heatmapData!.entries)
    : null;

  // ADR-0067: 수집 상태 점(표시 전용) — 지수는 수집 개념이 없어 숨긴다.
  const { data: watchlistData } = useWatchlist();
  const { data: liveStatusData } = useLiveStatus();
  const collection = deriveCollectionView({
    code,
    liveSet: liveStatusData?.live_set ?? [],
    watchlistCodes: watchlistData?.entries.map((e) => e.code) ?? [],
    viewedCodes: [code],
    kiwoomCodes: liveStatusData?.kiwoom?.subscribed_codes ?? [],
    liveConnection: live,
    registrationReady: liveStatusData?.kiwoom?.ready_registrations?.includes(
      `${code}${effectiveVenue === 'NXT' ? '_NX' : effectiveVenue === 'UN' ? '_AL' : ''}`,
    ),
    hasReceivedTick: liveStatusData?.kiwoom?.data_received_ms === undefined ? undefined :
      Object.keys(liveStatusData.kiwoom.data_received_ms).some((key) => key.startsWith(`${code}:${effectiveVenue}:`)),
  });

  const { backfillEarliestDate } = useWindowWarnings(windowId);
  const backfillDate = backfillEarliestDate
    ? `${backfillEarliestDate.slice(4, 6)}/${backfillEarliestDate.slice(6, 8)}`
    : null;
  const backfillPill = captureHealthPillColor('ok');

  return (
    <span
      data-testid="titlebar-symbol-row"
      className="live-symbol-row tabular-nums"
    >
      <span className="live-symbol-identity">
        <span className="live-symbol-name truncate text-fg" tabIndex={0}
          onMouseEnter={event => { if (!isIndex && event.buttons === 0) tooltip?.show(event.currentTarget, code); }}
          onMouseLeave={() => tooltip?.scheduleHide()}
          onFocus={event => { if (!isIndex && event.currentTarget.matches(':focus-visible')) tooltip?.show(event.currentTarget, code); }}
          onBlur={() => tooltip?.hide()}>{name ?? code}</span>
        {name && name !== code && <span className="live-symbol-code font-data">{displayCode}</span>}
        {!isIndex && <CollectionDot status={collection.displayStatus} showLabel={false} showTooltip={false} />}
      </span>
      {!isIndex && (
        <span data-testid="titlebar-current-price" className="live-symbol-price shrink-0 font-data text-fg"
          data-direction={currentPrice !== null && quote?.change_pct != null
            ? quote.change_pct > 0 ? 'up' : quote.change_pct < 0 ? 'down' : undefined
            : undefined}>
          {currentPrice !== null ? formatKoreanInt(currentPrice) : '—'}
        </span>
      )}
      {!isIndex && (
        <span data-testid="titlebar-change" className="live-symbol-change shrink-0 font-data">
          {/* 등락률(%)만 — 현재가가 옆에 있어 등락액 생략(레전드·상태바와 동일). */}
          <QuoteChange won={null} pct={quote?.change_pct ?? null} />
        </span>
      )}
      {!isIndex && (
        <span
          data-testid="titlebar-heatmap-group"
          className="live-symbol-sector truncate"
          style={{ visibility: showHeatmapChip ? undefined : 'hidden' }}
        >
          {heatmapGroupName ?? '히트맵 그룹 없음'}
        </span>
      )}
      {/* 숨겨도 칸은 유지한다 — 로딩 시작/종료와 날짜 자릿수가 헤더를 밀지 않는다. */}
      <span
        data-testid="past-backfill-progress-chip"
        className="live-symbol-backfill font-data whitespace-nowrap rounded text-2xs"
        style={{ visibility: backfillDate ? undefined : 'hidden',
          background: backfillPill.bg, border: backfillPill.border, color: backfillPill.fg }}
      >
        <AppIcon name="refresh" /><span className="live-symbol-warning-label">{backfillDate}</span>
      </span>
    </span>
  );
}
