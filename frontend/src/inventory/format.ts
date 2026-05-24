export function fmtDate(d: string): string {
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

export function fmtShortDate(d: string): string {
  return `${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    dateStyle: 'short',
    timeStyle: 'short',
  });
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
