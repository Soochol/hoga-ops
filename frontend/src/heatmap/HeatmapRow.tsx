import { heatBg, HEAT_CHIP_MAX_ALPHA } from './heat';

export interface HeatmapRowProps {
  name: string;
  price: number | null;
  pct: number | null;
  onClick: () => void;
  ariaLabel: string;
  testId: string;
}

/** 칼럼형 행: 종목명 │ 현재가 │ 등락률 칩. 히트색은 등락률 칩 배경에만 적용한다
 *  (행 전체 워시 X) — 종목명·현재가는 카드 배경 + 흰 글자로 항상 또렷하고, 색은
 *  의미 있는 등락률에만 모인다. 칩 = 농도(heatBg)·흰 글자·▲▼·부호의 4중 표현
 *  (색약 보조). 결측(null)은 '—'·중립.
 *  종목명 칼럼은 minmax(4rem,1fr) — 좁아져도 4rem 바닥을 깔아 이름이 짜부되지 않게
 *  하고(truncate 의 암묵적 min-width:0 무력화), 남는 폭은 모두 이름에 흘려보낸다. */
export function HeatmapRow({ name, price, pct, onClick, ariaLabel, testId }: HeatmapRowProps) {
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
      className="grid grid-cols-[minmax(4rem,1fr)_3.2rem_4.25rem] gap-1.5 px-2 py-0.5 items-center text-sm cursor-pointer border-b border-border outline-none hover:shadow-[inset_0_0_0_1px_var(--border-strong)] focus-visible:shadow-[inset_0_0_0_1px_var(--accent)]"
    >
      <span className="truncate text-fg">{name}</span>
      <span className="text-right font-mono tabular-nums text-fg">
        {price === null ? '—' : price.toLocaleString('ko-KR')}
      </span>
      {/* 히트는 등락률 칩 배경에만: 농도=등락폭(heatBg, 칩 전용 알파), 흰 글자 + ▲▼ + 부호.
          칸을 꽉 채우는 둥근 칩이라 한 칼럼이 통째로 히트색 띠처럼 보이고 행 간 정렬도 유지된다. */}
      {pct === null ? (
        <span className="text-right font-mono tabular-nums text-fg-dim">—</span>
      ) : (
        <span
          className="rounded px-1.5 text-right font-mono tabular-nums text-fg"
          style={{ background: heatBg(pct, HEAT_CHIP_MAX_ALPHA) }}
        >
          {glyph}{sign(pct)}{pct.toFixed(2)}
        </span>
      )}
    </div>
  );
}
