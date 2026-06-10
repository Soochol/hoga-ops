import { heatBg } from './heat';
import { priceDirClass } from '../ui/priceDir';

export interface HeatmapRowProps {
  name: string;
  price: number | null;
  pct: number | null;
  onClick: () => void;
  ariaLabel: string;
  testId: string;
}

/** 칼럼형 행: 종목명 │ 현재가 │ 등락률. 배경=heatBg(pct), 숫자=priceDirClass.
 *  결측(null)은 '—'·중립. 색+숫자+부호 삼중 표현(색약 보조, ChangeCell 규칙 계승).
 *  종목명 칼럼은 minmax(4rem,1fr) — 좁아져도 4rem 바닥을 깔아 이름이 짜부되지 않게
 *  하고(truncate 의 암묵적 min-width:0 무력화), 남는 폭은 모두 이름에 흘려보낸다.
 *  숫자 칼럼은 화면 검증된 64/56px 를 rem(3.2/2.8) 으로 옮겨 밀도 다이얼과 맞물린다. */
export function HeatmapRow({ name, price, pct, onClick, ariaLabel, testId }: HeatmapRowProps) {
  const c = pct === null ? 'text-fg-dim' : priceDirClass(pct);
  const glyph = pct === null ? '' : pct > 0 ? '▲' : pct < 0 ? '▼' : '';
  const sign = (n: number) => (n > 0 ? '+' : '');
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid={testId}
      aria-label={ariaLabel}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      className="grid grid-cols-[minmax(4rem,1fr)_3.2rem_2.8rem] gap-1.5 px-2 py-0.5 items-baseline text-sm cursor-pointer border-b border-border outline-none hover:shadow-[inset_0_0_0_1px_var(--border-strong)] focus-visible:shadow-[inset_0_0_0_1px_var(--accent)]"
      style={{ background: heatBg(pct) }}
    >
      <span className="truncate text-fg">{name}</span>
      <span className={`text-right font-mono tabular-nums ${c}`}>
        {price === null ? '—' : price.toLocaleString('ko-KR')}
      </span>
      <span className={`text-right font-mono tabular-nums ${c}`}>
        {pct === null ? '—' : `${glyph}${sign(pct)}${pct.toFixed(2)}`}
      </span>
    </div>
  );
}
