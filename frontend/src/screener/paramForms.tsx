import type { BreakoutParams, DepthPeakParams, DepthRenewalParams, PeriodParams } from '../api/screener';

// 기준시각 허용 범위(KST) — 백엔드 validate_session_start_hhmm 과 같은 경계다.
// 여기서 막는 것은 편의고, 진짜 계약은 서버가 지킨다.
const RENEWAL_MIN_HHMM = 900;
const RENEWAL_MAX_HHMM = 1520;

/** HHMM 정수(1200) ↔ <input type="time"> 값('12:00'). 저장 형식은 정수로 유지한다. */
export function hhmmToTimeValue(hhmm: number): string {
  const hh = Math.floor(hhmm / 100);
  const mm = hhmm % 100;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
export function timeValueToHhmm(value: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const hhmm = Number(m[1]) * 100 + Number(m[2]);
  if (hhmm < RENEWAL_MIN_HHMM || hhmm > RENEWAL_MAX_HHMM) return null;
  return hhmm;
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-xs font-semibold uppercase text-fg-dim">{children}</div>;
}
export function Num({ value, onChange, label, w = 'w-20' }: {
  value: number | undefined; onChange: (n: number | undefined) => void; label?: string; w?: string;
}) {
  return (
    <label className="inline-flex items-center gap-1.5">
      {label && <span className="text-xs text-fg-dim">{label}</span>}
      <input type="number" inputMode="numeric" aria-label={label}
        value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        className={`${w} bg-bg-input border border-border rounded-md px-2 py-1 font-data text-sm tabular-nums text-fg`} />
    </label>
  );
}
export function Select<T extends string>({ value, onChange, options, label }: {
  value: T; onChange: (v: T) => void; options: [T, string][]; label: string;
}) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)}
      className="bg-bg-input border border-border-strong rounded-md px-2 py-1 text-sm text-fg">
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

/** (lookback N, period M) 돌파 폼 — new_high / new_high_vol 공용. */
export function BreakoutForm({ params, onChange }: { params: BreakoutParams; onChange: (p: BreakoutParams) => void }) {
  return <div className="flex items-center gap-3 flex-wrap">
    <Num label="lookback (N)" value={params.lookback} onChange={(n) => onChange({ ...params, lookback: n ?? 1 })} />
    <Num label="period (M)" value={params.period} onChange={(n) => onChange({ ...params, period: n ?? 1 })} /></div>;
}

/** (period M)일 폼 — new_high_today / new_high_vol_today(당일) 공용. */
export function PeriodForm({ params, onChange }: { params: PeriodParams; onChange: (p: PeriodParams) => void }) {
  return <div className="flex items-center gap-2">
    <Num label="period (M)" value={params.period} onChange={(n) => onChange({ period: n ?? 1 })} />
    <span className="text-sm text-fg-dim">일</span></div>;
}

/** (비교기간 N, 과거 peak 대비 X%) 폼 — ask/bid_depth_new_high(총잔량 신고) 공용. */
export function DepthPeakForm({ params, onChange }: { params: DepthPeakParams; onChange: (p: DepthPeakParams) => void }) {
  return <div className="flex flex-col gap-2">
    <div className="flex items-center gap-2 flex-wrap">
      <Num label="비교 기간 (N)" value={params.lookback} onChange={(n) => onChange({ ...params, lookback: n ?? 1 })} />
      <span className="text-sm text-fg-dim">일</span>
      <Num label="과거 peak 대비" value={params.threshold_pct} onChange={(n) => onChange({ ...params, threshold_pct: n ?? 100 })} />
      <span className="text-sm text-fg-dim">% 이상</span>
    </div>
    <div className="text-xs text-fg-dim">관심·히트맵 종목 중 데이터 보유 종목 대상</div>
  </div>;
}

/** (기준시각, 이전 최대 대비 X%) 폼 — ask/bid_depth_renewal 공용. 당일 전용.
 *  문구는 side 중립이다(DepthPeakForm 과 같은 규칙) — 어느 쪽인지는 조건 행 라벨이
 *  말한다. ParamForm 은 params/onChange 만 받으므로 side 를 알 방법도 없다. */
export function DepthRenewalForm({ params, onChange }: { params: DepthRenewalParams; onChange: (p: DepthRenewalParams) => void }) {
  // 범위 밖·미완성 입력(사용자가 시를 지우는 중 등)은 마지막 유효값을 유지한다 —
  // 여기서 0 이나 NaN 을 흘리면 서버가 422 로 스캔을 통째로 거절한다.
  const onTime = (v: string) => {
    const hhmm = timeValueToHhmm(v);
    if (hhmm != null) onChange({ ...params, start_hhmm: hhmm });
  };
  return <div className="flex flex-col gap-2">
    <div className="flex items-center gap-2 flex-wrap">
      <label className="inline-flex items-center gap-1.5">
        <span className="text-xs text-fg-dim">기준 시각</span>
        <input type="time" aria-label="기준 시각" step={60}
          min={hhmmToTimeValue(RENEWAL_MIN_HHMM)} max={hhmmToTimeValue(RENEWAL_MAX_HHMM)}
          value={hhmmToTimeValue(params.start_hhmm)} onChange={(e) => onTime(e.target.value)}
          className="w-28 bg-bg-input border border-border rounded-md px-2 py-1 font-data text-sm tabular-nums text-fg" />
      </label>
      <span className="text-sm text-fg-dim">이후 총잔량이</span>
      <Num label="이전 최대 대비" value={params.threshold_pct}
        onChange={(n) => onChange({ ...params, threshold_pct: n ?? 100 })} />
      <span className="text-sm text-fg-dim">% 이상</span>
    </div>
    <div className="text-xs text-fg-dim">
      관심·히트맵 종목 대상 · 당일 기준(장중 조회에서만 동작) · 하루 중 한 번이라도 닿으면 계속 표시
      · 100%는 동률 포함(더 큰 것만 보려면 101 이상)
    </div>
  </div>;
}


