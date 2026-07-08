import { useNowMs } from '../util/useNowMs';
import { realMsToYyyymmdd, regularSessionCloseMs, regularSessionOpenMs } from './liveDateTime';
import { auctionTickPcts, sessionProgress } from './sessionProgress';

/** Weekend by KST calendar day (holiday-unaware by design, like
 * `isKrxRegularSessionNow` — the backend calendar owns holidays). */
function isWeekendKst(yyyymmdd: string): boolean {
  const y = parseInt(yyyymmdd.slice(0, 4), 10);
  const m = parseInt(yyyymmdd.slice(4, 6), 10);
  const d = parseInt(yyyymmdd.slice(6, 8), 10);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 || wd === 6;
}

const PHASE_LABEL: Record<'pre' | 'in' | 'post', string> = {
  pre: '장 시작 전',
  in: '정규장 진행 중',
  post: '장 마감',
};

/**
 * Session Tape — a hairline under the /live top chrome that maps the KRX
 * Regular Session (09:00–15:30 KST) to a progress track with a live playhead.
 * The signature app-chrome element from the commercial mockups. All colors are
 * tokens, so it renders brass on Obsidian and green on Ledger.
 *
 * Simple form (this iteration): live "now" progress only. The /study replay
 * scrubber (click-to-seek) is a separate follow-up.
 */
export default function SessionTape() {
  const nowMs = useNowMs(1000);
  const today = realMsToYyyymmdd(nowMs);
  const openMs = regularSessionOpenMs(today);
  const closeMs = regularSessionCloseMs(today);
  const { fillPct, headPct, phase } = sessionProgress(nowMs, openMs, closeMs);
  const [openTick, closeTick] = auctionTickPcts(openMs, closeMs);
  // Weekend/holiday: draw the empty track but hide the playhead — a "now"
  // marker on a non-trading day would read as a real (misleading) session.
  const showHead = !isWeekendKst(today);
  const pct = (v: number) => `${(v * 100).toFixed(3)}%`;

  return (
    <div
      role="progressbar"
      aria-label={`${PHASE_LABEL[phase]} · 정규장 09:00–15:30`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={showHead ? Math.round(fillPct * 100) : undefined}
      className="relative w-full overflow-visible"
      style={{ height: '3px', background: 'var(--bg-subtle)' }}
    >
      {/* elapsed fill */}
      <div
        data-testid="session-tape-fill"
        className="absolute inset-y-0 left-0"
        style={{
          width: showHead ? pct(fillPct) : '0%',
          background: 'color-mix(in srgb, var(--accent) 50%, transparent)',
        }}
      />
      {/* auction boundary ticks (09:10 / 15:20) */}
      {[openTick, closeTick].map((t, i) => (
        <div
          key={i}
          className="absolute inset-y-0"
          style={{ left: pct(t), width: '1px', background: 'var(--border-strong)' }}
        />
      ))}
      {/* live playhead */}
      {showHead && (
        <div
          data-testid="session-tape-head"
          className="session-head-pulse absolute rounded-full"
          style={{
            left: pct(headPct),
            top: '50%',
            width: '7px',
            height: '7px',
            transform: 'translate(-50%, -50%)',
            background: 'var(--accent)',
          }}
        />
      )}
    </div>
  );
}
