import { useEffect, useState } from 'react';
import { formatHhmm, parseTradingTimeInput } from '../../util/tradingTime';

/** 장중 시각(HHMM 정수)을 HH:MM으로 표시·편집하는 공용 입력.
 *  총잔량 급증 마커·신규 거래원 등장·시그널 알림이 동일한 형식/검증을 공유한다(P1-9).
 *  draft를 로컬로 들고, blur/Enter에서만 커밋한다(부분 입력 중 상위 값 미변경).
 *  잘못된 값이면 저장값을 다시 포맷해 되돌린다. */
export default function TimeOfDayInput({
  hhmm,
  onCommit,
  ariaLabel,
  disabled = false,
  className = '',
}: {
  hhmm: number;
  onCommit: (hhmm: number) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}) {
  const [draft, setDraft] = useState(() => formatHhmm(hhmm));

  useEffect(() => {
    setDraft(formatHhmm(hhmm));
  }, [hhmm]);

  const commit = () => {
    const parsed = parseTradingTimeInput(draft);
    if (parsed == null) {
      setDraft(formatHhmm(hhmm));
      return;
    }
    setDraft(formatHhmm(parsed));
    if (parsed !== hhmm) onCommit(parsed);
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      placeholder="09:00"
      disabled={disabled}
      aria-label={ariaLabel}
      value={draft}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
          event.currentTarget.blur();
        }
      }}
      className={`w-[84px] rounded-md border border-border-strong bg-bg-input px-2 py-1 text-right text-sm tabular-nums text-fg focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${className}`.trim()}
    />
  );
}
