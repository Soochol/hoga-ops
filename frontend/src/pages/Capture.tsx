import { useEffect, useRef, useState } from 'react';
import { CaptureForm } from '../capture/CaptureForm';
import { CaptureQueue } from '../capture/CaptureQueue';

function currentKstMonth(): { year: number; month: number } {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000;
  const kst = new Date(utcMs + 9 * 60 * 60_000);
  return { year: kst.getFullYear(), month: kst.getMonth() + 1 };
}

const STORAGE_KEY = 'capture.leftPct';
const DEFAULT_LEFT_PCT = 60;
const MIN_PCT = 25;
const MAX_PCT = 75;

function loadInitialPct(): number {
  try {
    const v = Number(localStorage.getItem(STORAGE_KEY));
    if (Number.isFinite(v) && v >= MIN_PCT && v <= MAX_PCT) return v;
  } catch { /* SSR / privacy mode — fall through */ }
  return DEFAULT_LEFT_PCT;
}

export default function Capture() {
  const { year, month } = currentKstMonth();
  const containerRef = useRef<HTMLDivElement>(null);
  const [leftPct, setLeftPct] = useState<number>(loadInitialPct);
  const draggingRef = useRef(false);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, String(leftPct)); } catch { /* ignore */ }
  }, [leftPct]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current || containerRef.current === null) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setLeftPct(Math.max(MIN_PCT, Math.min(MAX_PCT, pct)));
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const onDividerDown = (e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <div
      ref={containerRef}
      style={{
        display: 'grid',
        gridTemplateColumns: `${leftPct}fr 12px ${100 - leftPct}fr`,
        gap: 0,
        padding: 16,
        height: '100%',
        background: 'var(--bg)',
        color: 'var(--fg)',
      }}
    >
      <section style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: 16,
        overflowY: 'auto',
      }}>
        <CaptureForm referenceYear={year} referenceMonth={month} />
      </section>

      {/* Divider hit area is the full 12px grid track. The visible 2px bar is
          centered inside via a pseudo-flex layout; the surrounding padding is
          part of the hit target so users have a forgiving 12px grab zone. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize panes (${Math.round(leftPct)}% / ${Math.round(100 - leftPct)}%)`}
        onMouseDown={onDividerDown}
        onDoubleClick={() => setLeftPct(DEFAULT_LEFT_PCT)}
        title="Drag to resize · Double-click to reset"
        style={{
          cursor: 'col-resize',
          display: 'flex',
          alignItems: 'stretch',
          justifyContent: 'center',
          background: 'transparent',
        }}
      >
        <div
          aria-hidden
          style={{
            width: 2,
            background: 'var(--border)',
            borderRadius: 1,
            transition: 'background 0.15s, width 0.15s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--accent)';
            e.currentTarget.style.width = '4px';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'var(--border)';
            e.currentTarget.style.width = '2px';
          }}
        />
      </div>

      <section style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: 12,
        display: 'flex', flexDirection: 'column',
        minHeight: 0,
      }}>
        <CaptureQueue />
      </section>
    </div>
  );
}
