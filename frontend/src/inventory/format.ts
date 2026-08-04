export function fmtDate(d: string): string {
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

export function fmtShortDate(d: string): string {
  return `${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

/** 수집 시각 — 로케일 기본형("26. 8. 3. 오후 7:31")은 오전/오후 문자열 때문에 값마다
 *  폭이 달라 tnum 열 리듬을 깨고, 같은 표의 날짜 열(fmtDate, ISO)과 포맷 계열도
 *  어긋난다. 고정폭 24h "MM-DD HH:mm"(KST)로 통일한다. */
export function fmtTime(ms: number): string {
  const d = new Date(ms + 9 * 60 * 60 * 1000); // shift to KST (unixMsToKSTClock 과 동일 기법)
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${mo}-${dd} ${hh}:${mi}`;
}

/** HH:MM in KST — used by the gap panel to show a gap's start/end wall-clock. */
export function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString('ko-KR', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** Whole-minute duration between two Unix-ms instants, e.g. "19분". */
export function fmtGapDuration(startMs: number, endMs: number): string {
  const mins = Math.round((endMs - startMs) / 60_000);
  return `${mins}분`;
}

export function fmtSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fmtOHLC(open: number, close: number): string {
  const dir = close >= open ? '↑' : '↓';
  return `${close.toLocaleString('ko-KR')} ${dir}`;
}

export function fmtVolume(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
