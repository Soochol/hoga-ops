import { ChangeCell } from '../screener/ChangeCell';

/** 관심종목·스크리너 드로어 공용 행: 코드 │ 이름 │ 현재가 │ 등락률.
 *  ScreenerResultRow 의 시각/키보드 계약을 그대로 가져오고 현재가 셀을 추가. */
export function QuoteRow({
  code, name, price, pct, active, ariaLabel, testId, onClick,
}: {
  code: string;
  name: string;
  price: number | null;
  pct: number | null;
  active: boolean;
  ariaLabel: string;
  testId: string;
  onClick: () => void;
}) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLLIElement>) => {
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
      className="cursor-pointer px-md py-sm flex items-center gap-2 border-b outline-none hover:bg-bg-input-hover focus-visible:bg-bg-input-hover"
      style={{
        background: active ? 'var(--tint-selection)' : 'transparent',
        borderLeft: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
      }}
    >
      <span className="font-mono text-xs text-fg-dim" style={{ minWidth: '3.2rem' }}>{code}</span>
      <span className="flex-1 truncate text-sm text-fg">{name}</span>
      <span className="font-mono tabular-nums text-sm text-fg-dim text-right">
        {price != null ? price.toLocaleString('ko-KR') : '—'}
      </span>
      <span className="font-mono tabular-nums text-sm text-right" style={{ minWidth: '4.5rem' }}>
        <ChangeCell pct={pct} />
      </span>
    </li>
  );
}
