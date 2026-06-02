import { QuoteChange } from './QuoteChange';

/** 관심종목·스크리너 드로어 공용 행: 종목명(좌) │ 현재가·전일대비 2줄 스택(우) │ (선택) 트레일링 액션.
 *  ScreenerResultRow 의 시각/키보드 계약을 그대로 가져오고 현재가+등락 셀을 우측에 스택.
 *  trailingAction: 패널이 주입하는 행 우측 affordance(하트/휴지통). 자체적으로
 *  stopPropagation/aria 를 책임진다. <li> 는 group 이라 액션이 group-hover/
 *  group-focus-within 로 등장 처리를 할 수 있다. */
export function QuoteRow({
  name, price, pct, changeWon, active, ariaLabel, testId, onClick, trailingAction,
}: {
  name: string;
  price: number | null;
  pct: number | null;
  changeWon: number | null;
  active: boolean;
  ariaLabel: string;
  testId: string;
  onClick: () => void;
  trailingAction?: React.ReactNode;
}) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLLIElement>) => {
    // 중첩 버튼(trailingAction)에서 올라온 keydown 은 무시 — 행이 직접
    // 포커스됐을 때만 Enter/Space 로 차트를 연다.
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
  };
  return (
    <li
      data-testid={testId}
      role="button"
      tabIndex={0}
      aria-current={active ? 'true' : undefined}
      aria-label={ariaLabel}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className="group cursor-pointer px-md py-sm flex items-center gap-2 border-b outline-none hover:bg-bg-input-hover focus-visible:bg-bg-input-hover"
      style={{
        background: active ? 'var(--tint-selection)' : 'transparent',
        borderLeft: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
      }}
    >
      <span className="flex-1 truncate text-sm text-fg">{name}</span>
      <span className="flex flex-col items-end leading-tight">
        <span className="font-mono tabular-nums text-sm text-fg">
          {price != null ? `${price.toLocaleString('ko-KR')}원` : '—'}
        </span>
        <span className="font-mono tabular-nums text-xs">
          <QuoteChange won={changeWon} pct={pct} />
        </span>
      </span>
      {trailingAction != null && (
        <span className="flex items-center justify-center" style={{ minWidth: '1.25rem' }}>
          {trailingAction}
        </span>
      )}
    </li>
  );
}
