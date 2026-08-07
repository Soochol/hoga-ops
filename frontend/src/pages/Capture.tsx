import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { CaptureForm, type SymbolPick } from '../capture/CaptureForm';
import { CaptureQueue } from '../capture/CaptureQueue';
import VerticalSplitter from '../layout/VerticalSplitter';
import { PageContainer } from '../layout/PageContainer';
import { useLivePageStore } from '../state/livePage';
import { PanelCard } from '../ui/PageShell';
import { DataSection } from '../ui/DataSurface';

function currentKstMonth(): { year: number; month: number } {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000;
  const kst = new Date(utcMs + 9 * 60 * 60_000);
  return { year: kst.getFullYear(), month: kst.getMonth() + 1 };
}

const STORAGE_KEY = 'capture.leftPct';
/**
 * 폼:큐 기본 분할. **60 → 45 (2026-08-07).**
 *
 * 페이지를 `PAGE_MAX_W` 중앙 고정으로 담으면서 필요해진 값이다. 2560px 전폭일 땐
 * 60% 도 충분했지만 1680 으로 좁히면 큐 pane 이 656px 가 되고, 큐 행 스크롤러가
 * 658/629 로 넘쳐 **취소(×) 열 ~29px 가 가로 스크롤 뒤로 밀린다**(101행 전부, 실측).
 * 폼은 2개월 달력이라 필요 폭이 ~740px 로 고정이므로 60% 를 받을 이유가 없다 —
 * 45% 면 폼 738 / 큐 903 이고 오버플로가 0이다.
 *
 * ⚠ 이 값은 `localStorage` 에 저장되므로 **기존 사용자에게는 적용되지 않는다**(저장된
 * 60 이 이긴다). 스플리터를 한 번 움직이거나 더블클릭 리셋하면 이 값으로 온다.
 */
const DEFAULT_LEFT_PCT = 45;
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
  const activeLiveCode = useLivePageStore((s) => s.activeCode);
  const initialCode = codeParam ?? activeLiveCode;
  const containerRef = useRef<HTMLDivElement>(null);
  const [leftPct, setLeftPct] = useState<number>(loadInitialPct);
  // 큐 → 폼 종목 전달. seq 를 부모가 매기는 이유는 "같은 종목 재선택"도 이벤트로
  // 전달되어야 하기 때문 — code 만 담으면 상태가 안 바뀌어 폼이 반응하지 않는다.
  const [picked, setPicked] = useState<SymbolPick | null>(null);
  const onPickSymbol = useCallback((code: string) => {
    setPicked((prev) => ({ code, seq: (prev?.seq ?? 0) + 1 }));
  }, []);

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
    // grid-rows-[minmax(0,1fr)]: 열은 스플리터가 fr 로 잡아주지만 행은 비워두면
    // `grid-auto-rows: auto` 가 되고, auto 트랙은 콘텐츠가 원하는 만큼 커진다. 그래서
    // 창 높이를 줄여도 두 패널이 더 짧아지지 않고 뷰포트 밖으로 잘렸다 — /live 에서
    // 고친 것과 같은 축 비대칭(#730)이 여기서는 세로로 나타난 것.
    <PageContainer
      ref={containerRef}
      centered
      className="grid grid-rows-[minmax(0,1fr)] gap-0 bg-bg text-fg !pb-0"
      style={{ gridTemplateColumns: `${leftPct}fr 12px ${100 - leftPct}fr` }}
    >
      {/* min-h-0: 큐 쪽(아래 DataSection)과 같은 이유 — 이게 없으면 폼의
          `overflow-y-auto` 스크롤러가 콘텐츠 높이(약 573px)에서 줄지 않아, 패널의
          `overflow-hidden` 이 폼 하단을 조용히 먹고 자체 스크롤바도 뜨지 않는다. */}
      <PanelCard as="section" borderless flat data-testid="capture-form-pane" className="flex min-h-0 flex-col overflow-hidden">
        {/* 헤더 밑줄을 켠 채로 둔다(`flushHeader` 제거, 2026-08-07) — pane 이
            `PanelCard borderless flat` 이라 테두리·그림자·톤 스텝이 전부 꺼져 있고,
            좌우 pane 을 갈라 주는 게 스플리터 12px 뿐이었다. `/market` 이 같은
            문제(평면 카드는 분리 수단이 없다)에 낸 답과 같은 선이다. */}
        <DataSection title="캡처 요청" className="flex min-h-0 flex-1 flex-col" contentClassName="min-h-0 flex-1 overflow-y-auto p-md">
          <CaptureForm referenceYear={year} referenceMonth={month} initialCode={initialCode} picked={picked} />
        </DataSection>
      </PanelCard>
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
      <PanelCard as="section" borderless flat data-testid="capture-queue-pane" className="flex min-h-0 min-w-0 flex-col overflow-hidden">
        <DataSection title="캡처 대기열" className="flex min-h-0 flex-1 flex-col" contentClassName="flex min-h-0 flex-1 flex-col p-md">
          <CaptureQueue onPickSymbol={onPickSymbol} />
        </DataSection>
      </PanelCard>
    </PageContainer>
  );
}
