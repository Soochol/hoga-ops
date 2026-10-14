
export function fmtDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}`;
}
