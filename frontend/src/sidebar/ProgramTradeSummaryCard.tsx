import type { ProgramTradePoint, ProgramTradeSeries } from '../api/types';
import { formatKoreanInt } from '../util/koreanNumber';

type Props = {
  series?: ProgramTradeSeries | null;
  cursorMs?: number | null;
};

export default function ProgramTradeSummaryCard({ series, cursorMs = null }: Props) {
  const point = pickProgramTradePoint(series?.points ?? [], cursorMs);

  if (!point) {
    return (
      <div className="grid h-full min-h-[88px] place-items-center px-3 py-4 text-xs text-fg-dimmer">
        프로그램 순매수 데이터 없음
      </div>
    );
  }

  const amountClass = signedClass(point.net_amount);
  const qtyClass = signedClass(point.net_qty);

  return (
    <div className="flex h-full min-h-[96px] flex-col justify-between px-3 py-2 font-mono text-xs">
      <div className="flex items-center justify-between gap-2 text-fg-dimmer">
        <span>누적 순매수</span>
        <span>{formatTime(point.t)}</span>
      </div>
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 pt-2 tabular-nums">
        <span className="text-fg-dimmer">금액</span>
        <span className={`text-right text-sm font-semibold ${amountClass}`}>
          {formatSigned(point.net_amount)}
        </span>
        <span className="text-fg-dimmer">수량</span>
        <span className={`text-right ${qtyClass}`}>{formatSigned(point.net_qty)}</span>
      </div>
      {point.gap_risk && (
        <div className="pt-1 text-[11px] text-fg-dimmer">
          일부 구간 보간
        </div>
      )}
    </div>
  );
}

export function pickProgramTradePoint(
  points: readonly ProgramTradePoint[],
  cursorMs: number | null,
): ProgramTradePoint | null {
  if (points.length === 0) return null;
  if (cursorMs === null) return points[points.length - 1] ?? null;
  for (let i = points.length - 1; i >= 0; i -= 1) {
    if (points[i].t <= cursorMs) return points[i];
  }
  return null;
}

function formatSigned(value: number | null): string {
  if (value === null) return '-';
  const sign = value > 0 ? '+' : '';
  return `${sign}${formatKoreanInt(value)}`;
}

function signedClass(value: number | null): string {
  if (value === null || value === 0) return 'text-fg-dimmer';
  return value > 0 ? 'text-price-up' : 'text-price-down';
}

function formatTime(tsMs: number): string {
  return new Date(tsMs).toLocaleTimeString('ko-KR', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}
