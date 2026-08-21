/**
 * 기간 동기화의 **배선** — 판정과 수식은 `chart/rangeSync.ts` 가 갖고, 여기서는
 * 그것을 lightweight-charts 와 DOM 이벤트에 붙인다.
 *
 * 훅이 둘인 이유는 방향이 하나이기 때문이다: 분봉 창은 발행만, 일봉 창은 추종만
 * 한다. 한 훅에 합치면 양쪽 게이트가 한 함수 안에서 얽혀 "이 창이 지금 무엇을
 * 하는가" 가 읽히지 않는다.
 */
import { useEffect, useRef } from 'react';
import type { IChartApi, Time } from 'lightweight-charts';
import { useLiveCursorStore, type SidebarCursorOrigin } from './useLiveCursorStore';
import { safeUnsubscribe } from '../chart/util/safeUnsubscribe';
import { realMsToVirtualSeconds } from './viewportAnchor';
import type { VirtualAxis } from '../util/virtualAxis';
import { centeredLogicalRange, shouldFollowRange, zoomedSpan } from '../chart/rangeSync';

/** 휠이 멈춘 것으로 보는 침묵 구간. 휠은 pointerup 같은 종료 이벤트가 없다. */
const WHEEL_GESTURE_TAIL_MS = 150;

/**
 * **발행** — 이 분봉 창이 사용자 제스처로 움직이는 동안 보이는 실시각 구간을 싣는다.
 *
 * ── 왜 제스처 구간이 필요한가 ─────────────────────────────────────────────
 * 분봉 창의 논리 범위는 사용자 팬 말고도 움직인다: 새 캔들이 도착하면 라이브 엣지를
 * 따라가고, 백필이 prepend 하면 재앵커한다. 그걸 전부 발행하면 일봉 창이 **틱마다
 * 오늘로 끌려가** 다른 기간을 볼 수 없게 된다.
 *
 * 기존 `pendingUserDragRangeChange`(LiveChartRoot 의 「사용자 조정」 래치)를 그대로
 * 쓸 수 없는 이유가 여기 있다 — 그건 드래그당 **한 번만** 소비되는 신호라 연속 추적에
 * 모자란다. 같은 아이디어를 구간으로 넓힌 것이 이 훅이다.
 *
 * 루프 방지도 이 게이트가 겸한다: 일봉 창이 동기화로 움직여도 그건 제스처가 아니고,
 * 애초에 일봉은 발행하지 않는다(`canPublishRangeSync`).
 */
export function useRangeSyncPublish(params: {
  chart: IChartApi | null;
  axis: VirtualAxis;
  containerRef: { current: HTMLElement | null };
  /** 이 창이 발행 자격이 있는가(분봉 + 기능 토글). 꺼져 있으면 구독 자체를 안 건다. */
  enabled: boolean;
  /** 매 발행 시점의 최신 origin 을 읽는다 — 창의 code·봉은 바뀔 수 있다. */
  originRef: { current: SidebarCursorOrigin };
}): void {
  const { chart, axis, containerRef, enabled, originRef } = params;
  const axisRef = useRef(axis);
  axisRef.current = axis;

  useEffect(() => {
    if (!chart || !enabled) return;
    const target = containerRef.current;
    if (!target) return;
    const ts = chart.timeScale();
    let gestureActive = false;
    let wheelTail: ReturnType<typeof setTimeout> | null = null;
    let raf = 0;
    // 제스처가 끝난 뒤 **한 번은 더** 실어야 한다. 아래 `onPointerUp` 주석 참조.
    let flushPending = false;

    // rAF 로 합친다 — 드래그 중 범위 변화는 포인터 이벤트 속도로 들어오는데, 그걸
    // 그대로 store 에 쓰면 소비 창이 같은 프레임에 여러 번 재렌더된다.
    // (`publish` 는 아래에 선언되지만 이 화살표가 호출될 때는 이미 초기화돼 있다 —
    //  등록 자체가 effect 본문 끝의 addEventListener 이후다.)
    const schedule = () => { if (raf === 0) raf = requestAnimationFrame(publish); };

    const endWheelTail = () => {
      wheelTail = null;
      gestureActive = false;
      flushPending = true;
      schedule();
    };
    /**
     * 제스처 시작. **그 시점의 범위를 즉시(동기로) 싣는다.**
     *
     * 소비 창의 줌 비율은 "직전에 적용한 발행의 폭" 과 비교해 나온다. 제스처가 만든
     * 발행이 그 창의 **첫 발행**이면 비교할 짝이 없어 줌이 한 박자 늦는다 — 도그푸딩
     * 에서 실제로 그랬다(분봉은 확대됐는데 일봉 라벨 간격이 그대로). 시작 시점의
     * 범위를 먼저 실어 두면 이어지는 rAF 발행이 곧바로 올바른 비율을 만든다.
     *
     * **capture 단계로 듣는 이유**가 이것이다 — lwc 의 휠 핸들러는 캔버스(타겟)에
     * 있어 버블 단계에서는 이미 확대가 끝난 뒤다. 그러면 "시작 시점" 이 아니라
     * 확대 후 범위를 싣게 되어 기준선이 무의미해진다.
     */
    const startGesture = () => {
      if (gestureActive) return;
      gestureActive = true;
      flushPending = true;
      publish();
    };
    const onWheel = () => {
      startGesture();
      if (wheelTail !== null) clearTimeout(wheelTail);
      wheelTail = setTimeout(endWheelTail, WHEEL_GESTURE_TAIL_MS);
    };
    const onPointerDown = () => { startGesture(); };
    const onPointerUp = () => {
      // 휠 꼬리가 살아 있으면 그쪽이 끝낸다 — 드래그 종료가 휠 구간을 잘라먹지 않게.
      if (wheelTail !== null) return;
      gestureActive = false;
      // **마지막 위치를 한 번 더 싣고 닫는다.** 범위 변화는 rAF 로 미뤄 두는데, 드래그가
      // 한 프레임 안에 끝나면(빠른 플릭 · 합성 드래그) 예약된 rAF 가 `pointerup` **뒤에**
      // 돈다. 그때 게이트가 닫혀 있으면 그 제스처의 발행이 **통째로 사라진다** — 도그푸딩
      // 에서 실제로 그랬다(분봉은 움직였는데 일봉이 그대로). 느린 드래그에서도 마지막
      // 프레임은 같은 경로라, 이 flush 가 없으면 **최종 위치가 영영 발행되지 않는다.**
      flushPending = true;
      schedule();
    };

    // 발행값은 **실시각**이다. 논리 인덱스를 실으면 발행 창의 캔들 수에 묶여 소비 창이
    // 해석할 수 없다(창마다 로드 범위가 다르다). 시각이 두 축의 유일한 공통 언어다.
    const publish = () => {
      raf = 0;
      const allowed = gestureActive || flushPending;
      flushPending = false;
      if (!allowed) return;
      const r = ts.getVisibleRange();
      if (!r) return;
      const fromMs = axisRef.current.toReal(Number(r.from) * 1000);
      const toMs = axisRef.current.toReal(Number(r.to) * 1000);
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return;
      useLiveCursorStore.getState().setSyncRange(fromMs, toMs, originRef.current);
    };

    // capture: true — lwc 의 핸들러(캔버스=타겟)보다 **먼저** 듣기 위해서다.
    target.addEventListener('wheel', onWheel, { passive: true, capture: true });
    target.addEventListener('pointerdown', onPointerDown, { capture: true });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    ts.subscribeVisibleLogicalRangeChange(schedule);
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      if (wheelTail !== null) clearTimeout(wheelTail);
      target.removeEventListener('wheel', onWheel, { capture: true });
      target.removeEventListener('pointerdown', onPointerDown, { capture: true });
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      safeUnsubscribe(() => ts.unsubscribeVisibleLogicalRangeChange(schedule));
      useLiveCursorStore.getState().clearSyncRangeFrom(originRef.current.windowId);
    };
  }, [chart, containerRef, enabled, originRef]);
}

/**
 * **추종** — 옆 분봉 창의 발행을 받아 그 기간을 화면 중앙에 둔다.
 *
 * ⚠ **`setVisibleLogicalRange` 를 범위 콜백 안에서 부르지 않는다.** lwc 는 그걸
 * 재진입 방지로 **조용히 삼킨다**(#1452 실측 — 에러도 반환값도 없다). 여기서는 store
 * 구독이 트리거라 그 경로는 아니지만, rAF 로 미루고 **실행 시점에 범위를 다시 읽는**
 * 처방은 그대로 쓴다: 예약과 실행 사이에 사용자가 일봉을 움직였으면 낡은 span 으로
 * 되미는 것이 오히려 튐이다.
 *
 * **stale 발행은 적용하지 않는다.** 마운트 시점의 `seq` 를 기억하고 그보다 큰 발행만
 * 본다 — 슬롯에 남아 있던 마지막 기간을 새 창이 적용하면 저장뷰 착석과 싸운다.
 */
export function useRangeSyncFollow(params: {
  chart: IChartApi | null;
  axis: VirtualAxis;
  /** 이 창의 캔들 수 — 인덱스 변환의 존재 확인이자 줌 클램프의 천장이다. */
  candleCount: number;
  enabled: boolean;
  /** 폭(줌)까지 따라갈지 — `rangeSyncZoom`. 끄면 스크롤만 한다. */
  syncZoom: boolean;
  myWindowId: string | null;
  /** 이 창의 링크 그룹(창 헤더의 번호) — 동기화 범위. */
  myGroup: number | null;
  myCode: string | null;
  allowCrossSymbol: boolean;
}): void {
  const {
    chart, axis, candleCount, enabled, syncZoom, myWindowId, myGroup, myCode, allowCrossSymbol,
  } = params;
  const syncRange = useLiveCursorStore((s) => s.syncRange);
  const axisRef = useRef(axis);
  axisRef.current = axis;
  // 마운트(정확히는 이 창이 추종을 시작한) 시점의 발행 번호. 이보다 큰 것만 적용한다.
  const baselineSeqRef = useRef<number | null>(null);
  if (baselineSeqRef.current === null) {
    baselineSeqRef.current = useLiveCursorStore.getState().syncRange?.seq ?? 0;
  }
  /**
   * 줌 비율의 기준선 — 직전에 **적용한** 발행의 폭과 그 발행 창.
   *
   * `windowId` 를 함께 들고 있어야 한다. 분봉 창이 둘이고 배율이 서로 다르면(6시간 vs
   * 1시간) 번갈아 발행할 때마다 6배·1/6배가 번갈아 나온다 — 아무도 줌하지 않았는데
   * 일봉이 요동친다. 발행 창이 바뀌면 기준선을 새로 잡고 그 라운드는 줌을 건너뛴다.
   */
  const zoomBaselineRef = useRef<{ windowId: string | null; spanMs: number } | null>(null);
  // 추종이 꺼져 있는 동안의 발행은 기준선을 갱신하지 못한다 — 다시 켰을 때 낡은 폭과
  // 비교하면 유령 줌이 된다. 스위치·종목이 바뀌면 기준선을 버린다.
  useEffect(() => { zoomBaselineRef.current = null; }, [enabled, syncZoom, myCode]);

  useEffect(() => {
    if (!chart || !enabled || candleCount <= 0 || !syncRange) return;
    if (syncRange.seq <= (baselineSeqRef.current ?? 0)) return;
    if (!shouldFollowRange({
      publication: syncRange, myWindowId, myGroup, myCode, allowCrossSymbol,
    })) return;
    const ts = chart.timeScale();
    const raf = requestAnimationFrame(() => {
      // 실행 시점에 다시 읽는다 — 예약 이후 사용자가 이 창을 움직였을 수 있다.
      const current = ts.getVisibleLogicalRange();
      if (!current) return;
      const toIndex = ts.timeToIndex?.(
        realMsToVirtualSeconds(axisRef.current, syncRange.toMs) as Time,
        true,
      );
      const fromIndex = ts.timeToIndex?.(
        realMsToVirtualSeconds(axisRef.current, syncRange.fromMs) as Time,
        true,
      );
      if (typeof fromIndex !== 'number' || typeof toIndex !== 'number') return;
      const baseline = zoomBaselineRef.current;
      const publishedSpanMs = syncRange.toMs - syncRange.fromMs;
      const sameOrigin = baseline !== null && baseline.windowId === syncRange.origin.windowId;
      const spanOverride = syncZoom && sameOrigin
        ? zoomedSpan({
          prevPublishedSpanMs: baseline.spanMs,
          nextPublishedSpanMs: publishedSpanMs,
          currentSpan: current.to - current.from,
          candleCount,
        })
        : null;
      // 기준선은 **줌 동기화가 꺼져 있어도** 갱신한다 — 안 그러면 토글을 켠 순간
      // 한참 전 폭과 비교해 유령 줌이 난다.
      zoomBaselineRef.current = { windowId: syncRange.origin.windowId, spanMs: publishedSpanMs };
      // 위치와 폭을 **한 번의 호출로** 적용한다. 두 번 나눠 부르면 일봉의 범위 변화
      // 이벤트가 두 번 발화해 애니메이션이 겹친다.
      const next = centeredLogicalRange({
        fromIndex, toIndex, current, spanOverride: spanOverride ?? undefined,
      });
      if (next) ts.setVisibleLogicalRange(next);
    });
    return () => cancelAnimationFrame(raf);
  }, [
    chart, enabled, syncZoom, candleCount, syncRange, myWindowId, myGroup, myCode, allowCrossSymbol,
  ]);
}
