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

export function MarketIndexBar() {
  const { data } = useMarketIndexQuotes();
  if (!data || data.length === 0) return null;

  return (
    <footer
      data-testid="market-index-bar"
      aria-label="시장지표"
      className="flex h-bottom-bar min-w-0 items-center gap-1 overflow-x-auto border-t border-border bg-bg-subtle px-2 [scrollbar-width:none]"
    >
      {data.map((quote, i) => (
        <div key={quote.id} className="flex shrink-0 items-center gap-1">
          {i > 0 && <span aria-hidden className="h-3 w-px bg-border" />}
          <MarketIndexItem quote={quote} />
        </div>
      ))}
    </footer>
  );
}
