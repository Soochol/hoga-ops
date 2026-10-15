import { useId, useState } from 'react';
import { isTradeMinAmountManwon, MAX_TRADE_MIN_AMOUNT_MANWON } from '../../state/tradeWindowSettings';

const PRESETS = [
  { value: 0, label: '전체' },
  { value: 1000, label: '1천만' },
  { value: 3000, label: '3천만' },
  { value: 5000, label: '5천만' },
  { value: 10000, label: '1억' },
];

export function TradeWindowSettings({ minAmountManwon, onApply }: {
  minAmountManwon: number;
  onApply: (minAmountManwon: number) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(() => (minAmountManwon || 1000).toLocaleString('ko-KR'));
  const [invalid, setInvalid] = useState(false);
  return <div className="space-y-3 p-3">
    <fieldset>
      <legend className="mb-2 font-medium">체결금액 필터</legend>
      <div className="flex flex-wrap gap-1">
        {PRESETS.map(preset => <button key={preset.value} type="button" className="ui-choice"
          aria-pressed={minAmountManwon === preset.value} onClick={() => onApply(preset.value)}>{preset.label}</button>)}
      </div>
    </fieldset>
    <form onSubmit={event => {
      event.preventDefault();
      const raw = draft.replaceAll(',', '').trim();
      const amount = Number(raw);
      if (!/^\d+$/.test(raw) || !isTradeMinAmountManwon(amount) || amount < 1) {
        setInvalid(true); return;
      }
      onApply(amount);
    }}>
      <label htmlFor={id} className="mb-1 block text-xs text-fg-dim">최소 금액 직접 입력</label>
      <div className="flex flex-wrap items-center gap-1.5">
        <input id={id} type="text" inputMode="numeric" autoComplete="off" value={draft}
          aria-invalid={invalid || undefined} aria-describedby={`${id}-unit${invalid ? ` ${id}-error` : ''}`}
          className="ui-field w-24 text-right font-data" onChange={event => { setDraft(event.target.value); setInvalid(false); }} />
        <span id={`${id}-unit`}>만원 이상</span>
        <button type="submit" className="ui-choice">적용</button>
      </div>
      {invalid && <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-error">
        1~{MAX_TRADE_MIN_AMOUNT_MANWON.toLocaleString('ko-KR')}만원 사이의 정수를 입력하세요.
      </p>}
    </form>
    <p className="text-xs text-fg-dim">단건 체결가 × 체결량 기준 · 전체 선택 시 해제</p>
  </div>;
}
