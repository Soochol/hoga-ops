import { isMinuteTimeframe, type LiveTimeframe } from '../state/livePage';

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * 극값 라벨 문자열 — `"<가격>원 (<±극값 대비율>%, <MM.DD HH:MM>)"`.
 *
 * 시각은 `candleTooltipModel.kstLabels` 와 **동일한 +9h/getUTC 규칙**(축·툴팁과 일치 → 9h 어긋남 없음),
 * 구분자만 레퍼런스 이미지에 맞춰 점(`MM.DD`)을 쓴다. 분봉이면 ` HH:MM` 을 붙이고, 캘린더(D/W/M)는
 * 09:00 앵커라 시각이 무의미하므로 날짜만 표시한다. 부호는 음수면 toFixed 의 `-`, 0·양수면 `+`.
 */
export function formatExtremeLabel(
  price: number,
  pct: number,
  tsMs: number,
  timeframe: LiveTimeframe,
): string {
  const priceStr = Math.round(price).toLocaleString('ko-KR');
  const pctStr = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}`;
  const d = new Date(tsMs + 9 * 3_600_000); // KST = UTC + 9h
  const date = `${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`;
  const when = isMinuteTimeframe(timeframe)
    ? `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
    : date;
  return `${priceStr}원 (${pctStr}%, ${when})`;
}
