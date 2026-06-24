import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { CaptureForm } from '../capture/CaptureForm';
import { CaptureQueue } from '../capture/CaptureQueue';
import VerticalSplitter from '../layout/VerticalSplitter';
import { PageContainer } from '../layout/PageContainer';
import { instrumentToActiveCode } from '../live/liveInstrument';
import { useLiveTabsStore } from '../state/liveTabs';

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
  const [searchParams] = useSearchParams();
  const codeParam = searchParams.get('code');
  const activeLiveTabCode = useLiveTabsStore((s) => {
    const active = s.tabs.find((t) => t.id === s.activeTabId);
    return active ? instrumentToActiveCode(active.instrument ?? null) : null;
  });
  const initialCode = codeParam ?? activeLiveTabCode;
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
        <CaptureForm referenceYear={year} referenceMonth={month} initialCode={initialCode} />
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
      {/* min-w-0: grid item 의 기본 min-width:auto(=콘텐츠 min-content) 를 풀어,
          큐 행의 최소폭이 패널 축소를 막지 않게 한다. 패널이 행보다 좁아지면
          큐 리스트(overflow-x:auto)가 가로 스크롤로 받아낸다 — 페이지 오버플로 방지. */}
      <section className="bg-bg-card border rounded-lg p-3 flex flex-col min-h-0 min-w-0">
        <CaptureQueue />
      </section>
    </PageContainer>
  );
}
