import { useEffect, useRef, type RefObject } from 'react';
import type { IChartApi } from 'lightweight-charts';
import type { RangeBundle } from '../api/types';
import { computeWheelOutcome } from '../util/wheelInteractions';

/**
 * /live 차트의 modifier-aware 휠 인터랙션 배선.
 *
 *  - 휠: 뷰포트 오른쪽 끝(`range.to`) 고정 줌
 *  - shift+휠: 스팬 유지 팬 (오른쪽 벽 = 마지막 캔들에서 클램프)
 *  - ctrl/cmd+휠: 커서 고정 줌 (클램프 없음 — 앵커 불변식 보존)
 *
 * 분기 수식은 `util/wheelInteractions.ts`의 순수 함수가 소유한다. 이 훅은
 * wheel 이벤트 → 헬퍼 입력 → `setVisibleLogicalRange` 배선만 담당.
 * 전제: `LiveChartRoot`가 `handleScale: { mouseWheel: false }`로 라이브러리
 * 내장 휠 줌을 꺼 둔다 (이중 소유권 레이스 방지). `handleScroll`(deltaX 팬)과
 * `pinch`는 라이브러리 기본값 그대로 둔다.
 *
 * See: docs/superpowers/specs/2026-06-07-live-wheel-interactions-design.md
 */
export function useWheelInteractions(
  chart: IChartApi | null,
  containerRef: RefObject<HTMLDivElement | null>,
  bundle: RangeBundle | null,
): void {
  // maxTo ref — bundle 교체(SSE 푸시 포함)마다 값만 갱신, 리스너는 재부착하지
  // 않는다. candles.length === 0이면 maxTo = -1이 되어 shift 오른쪽 팬이 퇴화
  // 범위({from: -1 - span, to: -1})로 클램프되므로 빈 bundle 윈도우는 Infinity로
  // 벽을 비활성화한다 (maxTo를 읽는 분기는 shift 오른쪽 팬뿐).
  const maxToRef = useRef(Number.POSITIVE_INFINITY);
  useEffect(() => {
    maxToRef.current =
      bundle && bundle.candles.length > 0
        ? bundle.candles.length - 1
        : Number.POSITIVE_INFINITY;
  }, [bundle]);

  // 휠 리스너 — chart당 1회 부착. deps의 containerRef는
  // react-hooks/exhaustive-deps 충족용(레포 선례: useDrawingHost) —
  // ref identity가 안정적이라 재부착을 유발하지 않는다.
  useEffect(() => {
    const container = containerRef.current;
    if (!chart || !container) return;
    const ts = chart.timeScale();

    const onWheel = (e: WheelEvent) => {
      const range = ts.getVisibleLogicalRange();
      if (!range) return; // 데이터 로드 전 — 페이지 스크롤을 방해하지 않는다
      e.preventDefault(); // 페이지 스크롤(특히 shift+휠 가로 스크롤)/브라우저 줌 차단
      const rect = container.getBoundingClientRect();
      const outcome = computeWheelOutcome({
        range,
        deltaY: e.deltaY,
        shiftKey: e.shiftKey,
        ctrlOrMetaKey: e.ctrlKey || e.metaKey,
        mouseX: e.clientX - rect.left,
        coordinateToLogical: (x) => ts.coordinateToLogical(x),
        maxTo: maxToRef.current,
      });
      if (outcome) ts.setVisibleLogicalRange(outcome);
    };

    // passive: false 필수 — 기본값(passive)이면 preventDefault()가 무시되어
    // shift+휠이 페이지 가로 스크롤을 함께 일으킨다.
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, [chart, containerRef]);
}
