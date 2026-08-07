import { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router';
import { CaptureForm, type SymbolPick } from '../capture/CaptureForm';
import { CaptureQueue } from '../capture/CaptureQueue';
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

/**
 * 폼:큐 열 트랙. **드래그 스플리터 + 비율 배분 폐지 (2026-08-07).**
 *
 * 리사이저를 없앤 근거는 **왼쪽이 폭에서 얻을 게 없다**는 것이다 — 달력이
 * `grid-cols-[repeat(7,2rem)]` 고정 트랙이라 2개월을 나란히 놓아도 488px 에서 멈추고,
 * 폼 콘텐츠의 `max-content` 는 566(+ pane 패딩 24 = **590**)에서 더 늘지 않는다.
 * 그래서 스플리터는 "정답이 하나뿐인 문제"를 사용자에게 떠넘기고 있었고, 1920 이상에서
 * 실제로 폼 740 / 큐 904 로 **폼이 150px 를 빈 여백으로 들고 있었다**(실측).
 *
 * 두 값의 출처(모두 실측):
 * - 왼쪽 `32rem`(512) = 달력 488 + 패딩 24. **하한을 `auto` 로 두면 안 된다** — 폼 안에
 *   `overflow-y-auto` 스크롤러가 있어 트랙의 `auto` min 이 min-content 가 아니라 0으로
 *   풀리고, 960px 뷰포트에서 폼이 **260px 까지 짜부러진다**(실측).
 * - 왼쪽 `37rem`(592) = 폼 콘텐츠 max-content + 패딩. 그 위는 여백이므로 상한.
 * - 오른쪽 `38.5rem`(616) ≥ 큐 행 min-content 589 + 패딩 24 = 613. 이 하한이 있어야
 *   좁아질 때 **폼이 먼저 양보**한다(1fr 의 min 은 0이라 이게 없으면 큐가 전부 흡수해
 *   취소(×) 열이 가로 스크롤 뒤로 밀린다 — 60→45 조정이 막으려던 바로 그 증상).
 *
 * 결과(전 뷰포트 오버플로 0): 1920+ 폼 592/큐 1052(종전 740/904), 1280 580/616,
 * 960(앱 floor 근처) 512/616.
 *
 * rem 으로 적는 이유는 밀도 다이얼 때문이다 — px 하드코딩은 1.0× 에서 무증상이라
 * 다이얼을 움직이는 순간 한꺼번에 드러난다(#1208).
 */
export default function Capture() {
  const { year, month } = currentKstMonth();
  const [searchParams] = useSearchParams();
  const codeParam = searchParams.get('code');
  const activeLiveCode = useLivePageStore((s) => s.activeCode);
  const initialCode = codeParam ?? activeLiveCode;
  // 큐 → 폼 종목 전달. seq 를 부모가 매기는 이유는 "같은 종목 재선택"도 이벤트로
  // 전달되어야 하기 때문 — code 만 담으면 상태가 안 바뀌어 폼이 반응하지 않는다.
  const [picked, setPicked] = useState<SymbolPick | null>(null);
  const onPickSymbol = useCallback((code: string) => {
    setPicked((prev) => ({ code, seq: (prev?.seq ?? 0) + 1 }));
  }, []);

  return (
    // grid-rows-[minmax(0,1fr)]: 열은 위 트랙이 잡아주지만 행은 비워두면
    // `grid-auto-rows: auto` 가 되고, auto 트랙은 콘텐츠가 원하는 만큼 커진다. 그래서
    // 창 높이를 줄여도 두 패널이 더 짧아지지 않고 뷰포트 밖으로 잘렸다 — /live 에서
    // 고친 것과 같은 축 비대칭(#730)이 여기서는 세로로 나타난 것.
    <PageContainer
      centered
      className="grid grid-rows-[minmax(0,1fr)] grid-cols-[minmax(32rem,37rem)_minmax(38.5rem,1fr)] gap-md bg-bg text-fg !pb-0"
    >
      {/* min-h-0: 큐 쪽(아래 DataSection)과 같은 이유 — 이게 없으면 폼의
          `overflow-y-auto` 스크롤러가 콘텐츠 높이(약 573px)에서 줄지 않아, 패널의
          `overflow-hidden` 이 폼 하단을 조용히 먹고 자체 스크롤바도 뜨지 않는다. */}
      <PanelCard as="section" borderless flat data-testid="capture-form-pane" className="flex min-h-0 flex-col overflow-hidden">
        {/* 헤더 밑줄을 켠 채로 둔다(`flushHeader` 제거, 2026-08-07) — pane 이
            `PanelCard borderless flat` 이라 테두리·그림자·톤 스텝이 전부 꺼져 있어
            좌우 pane 을 갈라 줄 수단이 이 밑줄뿐이다(스플리터를 없앤 뒤로는 12px gap 도
            선이 아니라 빈 틈이다). `/market` 이 같은 문제(평면 카드는 분리 수단이 없다)에
            낸 답과 같은 선이다. */}
        <DataSection title="캡처 요청" className="flex min-h-0 flex-1 flex-col" contentClassName="min-h-0 flex-1 overflow-y-auto p-md">
          <CaptureForm referenceYear={year} referenceMonth={month} initialCode={initialCode} picked={picked} />
        </DataSection>
      </PanelCard>
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
