import { useState } from 'react';
import { useNumericFieldValidation } from './numericInputValidation';

interface Props {
  value: number | undefined; onChange: (n: number | undefined) => void;
  label?: string; ariaLabel?: string; suffix?: string; placeholder?: string;
  min?: number; max?: number; step?: number; required?: boolean;
}

function inputError(raw: string, { required, min, max, step }: Props): string | null {
  if (raw === '') return required ? '값을 입력하세요.' : null;
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(raw) || !Number.isFinite(Number(raw))) return '숫자를 입력하세요.';
  const value = Number(raw);
  if (step === 1 && !Number.isInteger(value)) return '정수로 입력하세요.';
  if (min !== undefined && value < min) return `${min} 이상으로 입력하세요.`;
  if (max !== undefined && value > max) return `${max} 이하로 입력하세요.`;
  return null;
}

export function Num({ required = true, ...props }: Props) {
  const { value, onChange, label, ariaLabel, suffix, placeholder } = props;
  const [draft, setDraft] = useState({ source: value, raw: String(value ?? ''), touched: false });
  // Parent updates from this field keep its spelling (e.g. "-0", "2."). Loading
  // a different value resets the draft; sibling edits do not erase an empty field.
  if (!Object.is(draft.source, value)) {
    const ownUpdate = draft.raw !== '' && Number(draft.raw) === value;
    setDraft({ source: value, raw: ownUpdate ? draft.raw : String(value ?? ''), touched: ownUpdate && draft.touched });
  }
  const error = inputError(draft.raw, { ...props, required });
  const invalid = error !== null;
  const errorId = useNumericFieldValidation(invalid);
  const finish = () => setDraft(previous => ({ ...previous, touched: true }));
  return <label className="condition-field condition-number-field">
    <span className="condition-field-label">{label ?? ariaLabel}</span>
    <span className="condition-input-wrap" data-invalid={draft.touched && invalid || undefined}>
      <input type="text" inputMode={props.step === 1 ? 'numeric' : 'decimal'} aria-label={ariaLabel ?? label}
        aria-required={required} aria-invalid={draft.touched && invalid}
        aria-describedby={draft.touched && invalid ? errorId : undefined}
        value={draft.raw} placeholder={placeholder} className="font-data"
        onChange={event => {
          const raw = event.target.value;
          setDraft(previous => ({ ...previous, raw, touched: false }));
          // Never send incomplete/invalid text to numeric condition params.
          if (!inputError(raw, { ...props, required })) onChange(raw === '' ? undefined : Number(raw));
        }}
        onBlur={finish} onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); finish(); }
        }} />
      {suffix && <span className="condition-unit">{suffix}</span>}
    </span>
    {draft.touched && error && <span id={errorId} role="alert" className="condition-number-error">{error}</span>}
  </label>;
}
