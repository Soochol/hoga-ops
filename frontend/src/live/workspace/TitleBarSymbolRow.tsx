/**
 * TitleBarSymbolRow — 차트 창 타이틀바(제목 표시줄)의 종목 식별 행.
 *
 * 종목명·현재가·등락률·히트맵 그룹·수집 점·경고칩을 창 제목 줄에 표시한다(#869의
 * 캔버스 레전드에서 여기로 이관 — 사용자가 원한 "마우스로 창을 드래그하는 영역").
 * 타이틀바는 창 데이터 파이프라인(useLiveChartData)의 **부모**라 번들 파생값에
 * 직접 못 닿으므로:
 *  - 현재가·등락률·히트맵·수집상태는 `code` 만으로 전역 캐시 훅에서 self-fetch,
 *  - 경고칩(호가 미수집·과거 로딩)만 windowWarnings 채널을 `windowId` 로 구독한다.
 *
 * 현재가는 candles 폴백이 없어(타이틀바 스코프 밖) quote.price 를 직접 쓴다 —
 * 장중 실시간 시세면 채워지고, 없으면(장전·오프라인) 미표시한다.
 */
import { useLiveVenueStore } from '../../state/liveVenue';
import { useConnectionLiveness } from '../../api/useConnectionLiveness';
import { LIVE_STALE_MS } from '../../api/liveness';
import { useQuoteByCode, isStaleLiveQuote } from '../../api/liveQuotes';
import { useWatchlist } from '../../watchlist/useWatchlist';
import { useWatchlistMembership } from '../../watchlist/useWatchlistMembership';
import { useLiveStatus } from '../../api/liveStatus';
import { useHeatmap } from '../../heatmap/useHeatmap';
import { heatmapGroupNameOf } from '../../heatmap/heat';
import { QuoteChange } from '../../rightrail/QuoteChange';
import { CollectionDot } from '../CollectionDot';
import { deriveCollectionView } from '../collectionStatus';
import { captureHealthPillColor } from '../captureHealthPill';
import { hogaCoverageGapTitle } from '../hogaCoverageGap';
import { formatKoreanInt } from '../../util/koreanNumber';
import { useWindowWarnings } from './windowWarningsSource';

interface Props {
  /** 창 제목 종목명(그룹 스토어의 symbol.name). code=name 딥링크면 코드일 수 있다. */
  name: string | null;
  /** 주식 코드. */
  code: string;
  /** 지수 창이면 현재가/등락률/히트맵/수집점을 숨기고 종목명만(지수는 quote 없음). */
  isIndex: boolean;
  /** 경고칩 구독 키 — ChartWindowInner 가 windowWarnings 로 발행한다. */
  windowId: string;
}

export function TitleBarSymbolRow({ name, code, isIndex, windowId }: Props) {
  const live = useConnectionLiveness(LIVE_STALE_MS);
  const venue = useLiveVenueStore((s) => s.venue);

  const symbolLabel = name ? `${name}(${code})` : code;

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

  const { isMember } = useWatchlistMembership();
  const member = !isIndex && isMember(code);

  // ADR-0067: 수집 상태 점(표시 전용) — 지수는 수집 개념이 없어 숨긴다.
  const { data: watchlistData } = useWatchlist();
  const { data: liveStatusData } = useLiveStatus();
  const collection = deriveCollectionView({
    code,
    liveSet: liveStatusData?.live_set ?? [],
    watchlistCodes: watchlistData?.entries.map((e) => e.code) ?? [],
    viewedCodes: [code],
    kiwoomCodes: liveStatusData?.kiwoom?.subscribed_codes ?? [],
    captureCandidate: watchlistData?.entries.some((e) =>
      e.code === code && e.capture_candidate !== false) ?? member,
    liveConnection: live,
  });

  const { hogaGapDates, backfillEarliestDate } = useWindowWarnings(windowId);

  return (
    <span
      data-testid="titlebar-symbol-row"
      className="inline-flex min-w-0 items-center gap-1.5 tabular-nums"
    >
      {!isIndex && <CollectionDot status={collection.displayStatus} />}
      <span className="truncate text-[12px] font-medium text-fg">{symbolLabel}</span>
      {currentPrice !== null && (
        <span data-testid="titlebar-current-price" className="font-data text-[12px] font-semibold text-fg">
          {formatKoreanInt(currentPrice)}
        </span>
      )}
      {quote && (
        <span data-testid="titlebar-change" className="font-data text-[11px]">
          {/* 등락률(%)만 — 현재가가 옆에 있어 등락액 생략(레전드·상태바와 동일). */}
          <QuoteChange won={null} pct={quote.change_pct} />
        </span>
      )}
      {showHeatmapChip && (
        <span
          data-testid="titlebar-heatmap-group"
          className="truncate text-[11px]"
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
            className="font-data whitespace-nowrap rounded px-1.5 text-[10px]"
            style={{ background: pill.bg, border: pill.border, color: pill.fg }}
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
            className="font-data whitespace-nowrap rounded px-1.5 text-[10px]"
            style={{ background: gapPill.bg, border: gapPill.border, color: gapPill.fg }}
          >
            호가 미수집 {hogaGapDates.length}일
          </span>
        );
      })()}
    </span>
  );
}
