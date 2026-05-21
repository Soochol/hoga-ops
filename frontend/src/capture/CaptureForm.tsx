import { useEffect, useState } from 'react';
import type { StartCaptureArgs } from '../api/captures';

const CODE_REGEX = /^\d{6}$/;
const DATE_REGEX = /^\d{8}$/;
const LS_CODE = 'hoga.capture.code';
const LS_DATE = 'hoga.capture.date';

function isTodayKSTBeforeClose(date: string): boolean {
  if (!DATE_REGEX.test(date)) return false;
  const now = new Date();
  const kstOffsetMs = 9 * 60 * 60 * 1000;
  const kstNow = new Date(now.getTime() + kstOffsetMs);
  const yyyy = kstNow.getUTCFullYear();
  const mm = String(kstNow.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(kstNow.getUTCDate()).padStart(2, '0');
  const todayKst = `${yyyy}${mm}${dd}`;
  return date === todayKst && kstNow.getUTCHours() < 16;
}

function lsGet(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // localStorage unavailable (private mode, quota) — fail silently
  }
}

interface Props {
  initialCode?: string;
  initialDate?: string;
  disabled?: boolean;
  onStart: (args: StartCaptureArgs) => void;
}

export function CaptureForm({ initialCode = '', initialDate = '', disabled, onStart }: Props) {
  // Form persistence: localStorage holds the last-typed values so navigating
  // away and back doesn't strand the user with empty inputs whose placeholder
  // text looks like a value. initialCode/initialDate props win if provided.
  const [code, setCode] = useState(() => initialCode || lsGet(LS_CODE));
  const [date, setDate] = useState(() => initialDate || lsGet(LS_DATE));
  const [allowPartial, setAllowPartial] = useState(false);
  const [resume, setResume] = useState(false);
  const [captureOnly, setCaptureOnly] = useState(false);

  useEffect(() => { lsSet(LS_CODE, code); }, [code]);
  useEffect(() => { lsSet(LS_DATE, date); }, [date]);

  const partial = isTodayKSTBeforeClose(date);
  const codeValid = CODE_REGEX.test(code);
  const dateValid = DATE_REGEX.test(date);
  const canStart = codeValid && dateValid && !disabled;

  // When date is today + partial-capture rules apply, the submit ALWAYS sends
  // allow_partial=true. Reflect that in the visible checkbox (forced on, also
  // disabled — toggling would be a lie because the submit ignores the local
  // state in this mode). Spec §5.4 "pre-checks allow_partial".
  const effectiveAllowPartial = partial || allowPartial;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canStart) return;
    onStart({
      code,
      date,
      allow_partial: effectiveAllowPartial,
      resume,
      capture_only: captureOnly,
    });
  }

  return (
    <form className="bg-bg-card border rounded p-3.5 space-y-2.5" onSubmit={submit}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-fg-dimmer">
        New Capture
      </div>

      {partial && (
        <div className="bg-[rgba(245,158,11,0.08)] border border-[rgba(245,158,11,0.3)] rounded p-2.5">
          <div className="text-[11px] font-semibold text-[--warn] mb-1">
            Today's date — Data Window not yet complete (closes 16:00 KST)
          </div>
          <div className="text-[11px] text-fg-dim leading-relaxed">
            hogaplay collects through 16:00 (After-Hours Trading close), so captures
            before then are partial. <code className="font-mono text-fg">allow partial</code>{' '}
            is enabled automatically; re-run with <code className="font-mono text-fg">resume</code>{' '}
            after 16:00 to fill in the rest.
          </div>
        </div>
      )}

      <Field label="Code">
        <input
          className="bg-bg-input border rounded font-mono text-[13px] px-2.5 py-1.5 w-full focus:border-accent outline-none placeholder:text-fg-dimmer/60"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="005930"
          data-testid="capture-code"
        />
      </Field>
      <Field label="Date">
        <input
          className="bg-bg-input border rounded font-mono text-[13px] px-2.5 py-1.5 w-full focus:border-accent outline-none placeholder:text-fg-dimmer/60"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          placeholder="20260520"
          data-testid="capture-date"
        />
      </Field>

      <details open={partial} className="text-[11px] text-fg-dim">
        <summary className="cursor-pointer">▾ Advanced</summary>
        <div className="space-y-1 pt-1.5">
          <Check
            label="allow partial"
            value={effectiveAllowPartial}
            onChange={setAllowPartial}
            highlight={partial}
            disabled={partial}
          />
          <Check label="resume" value={resume} onChange={setResume} />
          <Check label="capture only (skip parse)" value={captureOnly} onChange={setCaptureOnly} />
        </div>
      </details>

      <button
        type="submit"
        disabled={!canStart}
        data-testid="capture-start"
        className="bg-accent text-bg font-semibold text-[13px] px-3.5 py-2 rounded w-full disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Start Capture
      </button>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-wider text-fg-dim mb-1">{label}</div>
      {children}
    </div>
  );
}

function Check({
  label, value, onChange, highlight, disabled,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  highlight?: boolean;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-center gap-2 ${disabled ? 'cursor-not-allowed opacity-90' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        checked={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className={`w-3 h-3 ${highlight ? 'accent-[--warn]' : 'accent-[--accent]'} ${disabled ? 'opacity-90' : ''}`}
      />
      <span className="text-fg">{label}</span>
    </label>
  );
}
