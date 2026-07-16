/** 전역 하단 시장지표 바 — 대표지수 현재지수 + 전일대비 스트립.
 *
 * App 셸 3번째 grid 행(auto)에 앉는다: 데이터가 없으면(자격증명/용량 부재,
 * 초기 로딩) null 을 반환해 행이 0으로 접힌다 — 고정 높이 행이 빈 띠로
 * 남지 않게 하는 계약. 높이는 --h-bottom-bar 토큰.
 *
 * 색 규율(DESIGN.md): 등락은 가격 방향 카테고리(priceDirClass, 색+부호 2중),
 * 라벨은 --fg-dim, 값은 mono --fg. 지수 클릭 = 해당 지수를 /live 현재 뷰로 연다
 * (activateLiveInstrument — 단일 뷰 제자리 교체, ADR-0113). */
import { useNavigate } from 'react-router';
import { useLiveStatus } from '../api/liveStatus';
import { useMarketIndexQuotes, type MarketIndexQuote } from '../api/marketIndexQuotes';
import { indexInstrument, isLiveIndexId } from '../live/liveInstrument';
import { activateLiveInstrument } from '../live/liveNavigate';
import { priceDirClass } from '../ui/priceDir';

const VALUE_FORMAT = new Intl.NumberFormat('ko-KR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatChange(quote: MarketIndexQuote): string {
  const sign = quote.change > 0 ? '+' : '';
  return `${sign}${VALUE_FORMAT.format(quote.change)} (${sign}${quote.changeRate.toFixed(2)}%)`;
}

function MarketIndexItem({ quote }: { quote: MarketIndexQuote }) {
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
      className="flex shrink-0 items-baseline gap-1.5 rounded-md px-1.5 hover:bg-bg-input-hover disabled:cursor-default disabled:hover:bg-transparent"
    >
      <span className="font-ui text-xs text-fg-dim">{quote.label}</span>
      <span className="font-mono text-xs text-fg">{VALUE_FORMAT.format(quote.value)}</span>
      <span className={`font-mono text-xs ${priceDirClass(quote.change)}`}>
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
  const total = data.live_set.length + k.subscribed_count;
  const degraded = k.connected_accounts < k.accounts_configured;
  return (
    <div className="flex shrink-0 items-center gap-1" data-testid="kiwoom-coverage-chip">
      {leadingDivider && <span aria-hidden className="h-3 w-px bg-border" />}
      <span
        className="flex items-baseline gap-1 px-1.5"
        title={`KIS WS ${data.live_set.length} + 키움 WS ${k.subscribed_count} (연결 ${k.connected_accounts}/${k.accounts_configured}계정)`}
      >
        <span className="font-ui text-xs text-fg-dim">실시간</span>
        <span className={`font-mono text-xs ${degraded ? 'text-warn' : 'text-fg'}`}>{total}</span>
        <span className="font-ui text-xs text-fg-dim">종목</span>
      </span>
    </div>
  );
}

export function MarketIndexBar() {
  const { data } = useMarketIndexQuotes();
  const { data: status } = useLiveStatus();
  const hasIndices = data != null && data.length > 0;
  const hasKiwoom = status?.kiwoom != null;
  // 지수·키움 둘 다 없으면 행 접힘(--h-bottom-bar 0 계약 유지).
  if (!hasIndices && !hasKiwoom) return null;

  return (
    <footer
      data-testid="market-index-bar"
      aria-label="시장지표"
      className="flex h-bottom-bar min-w-0 items-center gap-1 overflow-x-auto bg-bg px-2 [scrollbar-width:none]"
    >
      {hasIndices &&
        data.map((quote, i) => (
          <div key={quote.id} className="flex shrink-0 items-center gap-1">
            {i > 0 && <span aria-hidden className="h-3 w-px bg-border" />}
            <MarketIndexItem quote={quote} />
          </div>
        ))}
      <CoverageChip leadingDivider={hasIndices} />
    </footer>
  );
}
