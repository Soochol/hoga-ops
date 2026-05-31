import { useEffect, useRef, useState } from 'react';
import { CaptureForm } from '../capture/CaptureForm';
import { CaptureQueue } from '../capture/CaptureQueue';
import VerticalSplitter from '../layout/VerticalSplitter';
import { PageContainer } from '../layout/PageContainer';

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
  } catch {
    /* SSR / privacy mode — fall through */
  }
  return DEFAULT_LEFT_PCT;
}

function clamp(pct: number): number {
  return Math.max(MIN_PCT, Math.min(MAX_PCT, pct));
}

export default function Capture() {
  const { year, month } = currentKstMonth();
  const containerRef = useRef<HTMLDivElement>(null);
  const [leftPct, setLeftPct] = useState<number>(loadInitialPct);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(leftPct));
    } catch {
      /* ignore */
    }
  }, [leftPct]);

  const onDrag = (clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setLeftPct(clamp(pct));
  };

  const onNudge = (direction: -1 | 1, magnitude: 'small' | 'large') => {
    const step = magnitude === 'small' ? 1 : 5;
    setLeftPct((p) => clamp(p + direction * step));
  };

  return (
    <PageContainer
      ref={containerRef}
      className="grid gap-0 bg-bg text-fg"
      style={{ gridTemplateColumns: `${leftPct}fr 12px ${100 - leftPct}fr` }}
    >
      <section className="bg-bg-card border rounded-lg p-4 overflow-y-auto">
        <CaptureForm referenceYear={year} referenceMonth={month} />
      </section>
      <VerticalSplitter
        ariaLabel={`패널 크기 조정 (${Math.round(leftPct)}% / ${Math.round(100 - leftPct)}%)`}
        ariaValueNow={Math.round(leftPct)}
        ariaValueMin={MIN_PCT}
        ariaValueMax={MAX_PCT}
        onDrag={onDrag}
        onReset={() => setLeftPct(DEFAULT_LEFT_PCT)}
        onNudge={onNudge}
      />
      <section className="bg-bg-card border rounded-lg p-3 flex flex-col min-h-0">
        <CaptureQueue />
      </section>
    </PageContainer>
  );
}
