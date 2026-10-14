


// 기준시각 허용 범위(KST) — 백엔드 validate_session_start_hhmm 과 같은 경계다.
// 여기서 막는 것은 편의고, 진짜 계약은 서버가 지킨다.
export const RENEWAL_MIN_HHMM = 900;

export const RENEWAL_MAX_HHMM = 1959;


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
