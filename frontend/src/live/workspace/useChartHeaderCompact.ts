import { useEffect, useState } from 'react';
import {
  HEADER_FOLD_NONE,
  LIVE_HEADER_FOLD,
  nextHeaderFold,
  type HeaderFold,
  type HeaderFoldThresholds,
} from './chartHeaderCompact';

/**
 * 헤더 컨테이너 폭을 관측해 접힘 단계를 정한다 — 접힘의 React 경계.
 *
 * 판정 로직은 `chartHeaderCompact.ts` 가 갖고, 여기서는 관측만 한다
 * (`usePaneFolding` 과 같은 분리). 관측 대상이 **컨테이너 폭**이라 접힘이
 * 관측값을 되바꾸지 않는다 — 피드백 루프 없음.
 *
 * **관측 대상은 `RefObject` 로 받지 않고 callback ref 를 돌려준다.** ref 객체는
 * 렌더 간 identity 가 고정이라 deps 에 넣어도 "노드가 생겼다" 를 말해 주지 못한다.
 * 그런데 헤더가 **첫 마운트에는 없다가 나중에 등장하는** 경로가 실재한다 — `/live`
 * 차트 창은 종목이 없으면 헤더 대신 빈 상태를 그리고(`ChartWindow` 의
 * `if (!instrument)`), 종목이 붙는 순간 헤더가 처음 마운트된다. 옛 구현은 그
 * 시점에 effect 가 이미 `ref.current === null` 로 조기 반환한 뒤였고 deps
 * (`[ref, thresholds]`)가 둘 다 영구 안정이라 **ResizeObserver 를 영영 붙이지
 * 못했다**: 창을 아무리 좁혀도 접히지 않고, 새로고침해야(= 첫 렌더부터 헤더가 있는
 * 경로) 접혔다.
 *
 * 2026-08-14 실측(`/browse` · 1.0× · 같은 창을 두 경로로): 종목을 나중에 준 창은
 * 컨테이너 **208px** 에서도 두 단계 다 안 접혔고(임계 384/240 → 둘 다 켜져야 함),
 * 종목을 갖고 마운트한 창은 **258px** 에서 1단계가 정상으로 접혔다. 마운트 시
 * `push(el.clientWidth)` 경로는 옛 구현에서도 살아 있었다는 뜻이라, 증상은 "관측
 * 자체의 부재" 로만 설명된다.
 *
 * callback ref 는 노드가 붙고 떨어질 때마다 호출되므로 **등장·교체가 그대로 deps
 * 변화**가 된다. `setEl` 은 `useState` setter 라 참조가 안정적이고, React 는 참조가
 * 같은 callback ref 를 재호출하지 않으므로 렌더마다 재구독되지도 않는다.
 *
 * ⚠️ 이 함정은 `RefObject` 를 관측하는 훅 전부에 잠재한다. 걸리느냐는 "관측 대상이
 * 첫 마운트에 항상 있는가" 하나로 갈린다 — 조건부 렌더 아래로 옮기는 순간 조용히
 * 죽는다. 동류였던 `usePaneFolding` 은 같은 형태로 함께 전환했다(그쪽은 컨테이너가
 * 무조건 렌더라 무증상이었고, 따라서 예방이다).
 */
export function useChartHeaderFold(
  /** 표면별 임계 — 정책은 공유하고 숫자는 헤더마다 다르다(그 타입 주석 참조). */
  thresholds: HeaderFoldThresholds = LIVE_HEADER_FOLD,
): [HeaderFold, (el: HTMLElement | null) => void] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [fold, setFold] = useState<HeaderFold>(HEADER_FOLD_NONE);

  useEffect(() => {
    if (!el) return undefined;
    // 직전 상태는 setState 업데이터로 읽는다 — effect 를 fold 에 의존시키면
    // 상태가 바뀔 때마다 관측자가 재구독된다.
    const push = (width: number): void => {
      setFold((prev) => {
        const next = nextHeaderFold(width, prev, thresholds);
        return next.compactActions === prev.compactActions
          && next.compactTimeframe === prev.compactTimeframe
          ? prev
          : next;
      });
    };
    push(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      push(entries[0]?.contentRect.width ?? el.clientWidth);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, thresholds]);

  return [fold, setEl];
}
