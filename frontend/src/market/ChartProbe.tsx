import { useState } from 'react';

/** Inspection over a compact SVG. Arrow keys expose the same samples as the pointer. */
export function ChartProbe({ labels, summaries, positions }: { labels: string[]; summaries: string[]; positions?: number[] }) {
  const [active, setActive] = useState<number | null>(null);
  const count = Math.min(labels.length, summaries.length);
  if (count === 0) return null;
  const index = Math.min(active ?? count - 1, count - 1);
  return (
    <div
      className="absolute inset-0 rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      role="group"
      aria-label="차트 상세 — 좌우 방향키로 표본 탐색, Home/End로 처음/마지막"
      tabIndex={0}
      onFocus={() => setActive(count - 1)}
      onBlur={() => setActive(null)}
      onPointerMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const fraction = (event.clientX - rect.left) / rect.width;
        if (positions) {
          let nearest = 0;
          for (let i = 1; i < count; i++) {
            if (Math.abs(positions[i] - fraction) < Math.abs(positions[nearest] - fraction)) nearest = i;
          }
          setActive(nearest);
        } else {
          setActive(Math.max(0, Math.min(count - 1, Math.round(fraction * (count - 1)))));
        }
      }}
      onPointerLeave={(event) => {
        if (document.activeElement !== event.currentTarget) setActive(null);
      }}
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return;
        event.preventDefault();
        if (event.key === 'Escape') { setActive(null); return; }
        setActive(event.key === 'Home' ? 0 : event.key === 'End' ? count - 1
          : Math.max(0, Math.min(count - 1, index + (event.key === 'ArrowLeft' ? -1 : 1))));
      }}
    >
      {active !== null && <>
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 border-l border-border-strong"
          style={{ left: `${positions ? positions[index] * 100 : count === 1 ? 50 : index / (count - 1) * 100}%` }} />
        <div role="status" className="pointer-events-none absolute inset-x-0 top-full z-20 rounded bg-bg-card p-sm text-xs text-fg shadow-panel">
          <strong className="font-data">{labels[index]}</strong> · {summaries[index]}
        </div>
      </>}
    </div>
  );
}
