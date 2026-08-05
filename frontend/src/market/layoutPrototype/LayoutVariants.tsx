// ============================================================================
// PROTOTYPE — throwaway. /market 레이아웃 변형 3종 (?variant=a|b|c).
//
// 질문: 초광폭(~2000px)에서 카드가 무한 확장돼 차트가 납작해지고 행 균형이
// 무너진다 — 어떤 배치가 맞는가. 데이터·카드는 전부 실물(MarketPage 의 카드
// 컴포넌트 재사용)이고 **배치만** 다르다. 확정되면 승자를 CurrentLayout 자리에
// 접고 이 디렉터리를 지운다(프로토타입은 브랜치 보존).
// ============================================================================
import { useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { LABELS, LAYOUT_VARIANTS, useLayoutVariant } from './layoutVariantState';
import {
  ActorNetCard,
  BreadthCard,
  FundsCard,
  IndexCards,
  InvestorCard,
  ProgramCard,
  RankCard,
  SectorCard,
} from '../MarketPage';

export function LayoutSwitcher() {
  const [params, setParams] = useSearchParams();
  const current = useLayoutVariant();
  const idx = LAYOUT_VARIANTS.indexOf(current);

  const go = (delta: number) => {
    const n = LAYOUT_VARIANTS.length;
    const next = LAYOUT_VARIANTS[(idx + delta + n) % n];
    const nextParams = new URLSearchParams(params);
    if (next === 'current') nextParams.delete('variant');
    else nextParams.set('variant', next);
    setParams(nextParams, { replace: true });
  };

  useEffect(() => {
    if (import.meta.env.PROD) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, params]);

  if (import.meta.env.PROD) return null;

  return (
    <div
      className="fixed bottom-10 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-1 rounded-full border px-2 py-1 shadow-overlay"
      style={{ background: 'var(--fg)', color: 'var(--bg)', borderColor: 'var(--fg)' }}
    >
      <button type="button" aria-label="이전 변형" onClick={() => go(-1)}
        className="px-2 py-0.5 text-sm leading-none hover:opacity-70">←</button>
      <span className="min-w-[15rem] text-center font-data text-xs font-semibold tabular-nums">
        {LABELS[current]}
      </span>
      <button type="button" aria-label="다음 변형" onClick={() => go(1)}
        className="px-2 py-0.5 text-sm leading-none hover:opacity-70">→</button>
    </div>
  );
}

/** A — 중앙 고정 폭(1680px). 초광폭에서 카드가 늘어나는 대신 지면이 멈춘다.
 *  행 재균형: 업종 온도(세로로 긴 리스트)를 우측 열로 빼고, 좌측에 수급 위 +
 *  보조 4카드를 2×2 로 쌓아 높이를 맞춘다 — 현행의 "수급 아래 공백" 해소. */
export function VariantCentered() {
  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-[1680px] flex-col gap-xs overflow-y-auto">
      <IndexCards />
      <div className="grid grid-cols-[2fr_1fr] gap-xs">
        <div className="flex flex-col gap-xs">
          <InvestorCard />
          <div className="grid grid-cols-2 gap-xs">
            <ProgramCard />
            <FundsCard />
            <ActorNetCard actor="외국인" />
            <ActorNetCard actor="기관" />
          </div>
        </div>
        <div className="flex flex-col gap-xs">
          <SectorCard />
          <BreadthCard />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-xs">
        <RankCard title="상승률 상위" kind="change" direction="up" />
        <RankCard title="하락률 상위" kind="change" direction="down" />
        <RankCard title="거래대금 상위" kind="value" direction="up" />
      </div>
    </div>
  );
}

/** B — 풀와이드 3존. 폭을 제한하지 않고 **성격으로 나눈다**: 차트(좌) · 요약(중) ·
 *  리스트(우). 차트 존이 넓은 폭을 갖되 카드가 세로로 쌓여 개별 차트의 종횡비가
 *  유지되고, 리스트 존은 원래 좁아도 되는 것들이라 초광폭 낭비가 사라진다. */
export function VariantZones() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-xs overflow-y-auto">
      <IndexCards />
      <div className="grid grid-cols-[1.5fr_1fr_1.1fr] gap-xs">
        <div className="flex flex-col gap-xs">
          <InvestorCard />
          <ProgramCard />
          <FundsCard />
        </div>
        <div className="flex flex-col gap-xs">
          <SectorCard />
          <BreadthCard />
        </div>
        <div className="flex flex-col gap-xs">
          <div className="grid grid-cols-2 gap-xs">
            <ActorNetCard actor="외국인" />
            <ActorNetCard actor="기관" />
          </div>
          <RankCard title="상승률 상위" kind="change" direction="up" />
          <RankCard title="하락률 상위" kind="change" direction="down" />
          <RankCard title="거래대금 상위" kind="value" direction="up" />
        </div>
      </div>
    </div>
  );
}

/** C — 2단 분할(3:2). 좌측 = 차트 스택(수급→프로그램→자금), 우측 = 나머지 전부를
 *  리스트 열로. 시선 동선이 "좌에서 흐름을 읽고 우에서 종목을 고른다" 로 단순해진다.
 *  지수 카드는 그대로 두되 한 행이 아니라 좌측 상단 2×2 로 접는다. */
export function VariantSplit() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-xs overflow-y-auto">
      <div className="grid grid-cols-[3fr_2fr] gap-xs">
        <div className="flex flex-col gap-xs">
          <IndexCards />
          <InvestorCard />
          <div className="grid grid-cols-2 gap-xs">
            <ProgramCard />
            <FundsCard />
          </div>
        </div>
        <div className="flex flex-col gap-xs">
          <SectorCard />
          <div className="grid grid-cols-2 gap-xs">
            <ActorNetCard actor="외국인" />
            <ActorNetCard actor="기관" />
          </div>
          <BreadthCard />
          <div className="grid grid-cols-2 gap-xs">
            <RankCard title="상승률 상위" kind="change" direction="up" />
            <RankCard title="거래대금 상위" kind="value" direction="up" />
          </div>
        </div>
      </div>
    </div>
  );
}
