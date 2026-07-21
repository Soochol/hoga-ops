import type { ScreenerUpdating } from '../api/screener';

/** 갱신 job 진행 칩 + 바. status.updating(서버 진실)만 그린다 — WS 이벤트는
 *  useScreenerUpdateSync 가 같은 캐시 필드로 흘려보내므로 여기서는 구독이 없다. */
export function ScreenerUpdateProgress({ updating }: { updating: ScreenerUpdating | null | undefined }) {
  if (!updating) return null;
  const pct = updating.total > 0 ? Math.round((updating.done / updating.total) * 100) : 0;
  return (
    <span
      data-testid="screener-update-progress"
      className="inline-flex items-center gap-1.5 font-data text-xs tabular-nums text-fg-dim"
      title="일봉 아카이브 갱신 진행 중"
    >
      갱신 중 {updating.done.toLocaleString()}/{updating.total.toLocaleString()}
      <span className="relative h-1 w-24 rounded-sm bg-bg-input" aria-hidden>
        <span
          style={{ width: `${pct}%` }}
          className="absolute bottom-0 left-0 top-0 rounded-sm bg-accent"
        />
      </span>
    </span>
  );
}
