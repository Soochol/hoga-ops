import { useEffect, useRef, type RefObject } from 'react';
import type { IChartApi } from 'lightweight-charts';
import type { RangeBundle } from '../api/types';
import { computeWheelOutcome } from '../util/wheelInteractions';
import { CHART_TIMESCALE_OPTIONS } from '../util/chartScale';

/**
 * /live 차트의 modifier-aware 휠 인터랙션 배선.
 *
 *  - 휠: 뷰포트 오른쪽 끝(`range.to`) 고정 줌
 *  - shift+휠: 스팬 유지 팬 (오른쪽 벽 = 마지막 캔들 + rightOffset에서 클램프)
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
  // 않는다. 오른쪽 벽 = 마지막 캔들 + rightOffset: shift 팬으로 라이브 엣지에
  // 복귀하면 기본 뷰(우측 여백 포함)와 정확히 같은 화면에서 멈춘다. 처음엔
  // 마지막 캔들 타이트(length - 1)였으나 필드 사용 후 버퍼안으로 개정 —
  // 스펙 결정 #2 개정(2026-06-08) 참조. 빈 bundle 윈도우는 Infinity로 벽을
  // 비활성화한다 (length === 0이면 벽이 여백 안쪽으로 파고들어 퇴화 클램프 발생;
  // maxTo를 읽는 분기는 shift 오른쪽 팬뿐).
  const maxToRef = useRef(Number.POSITIVE_INFINITY);
  useEffect(() => {
    maxToRef.current =
      bundle && bundle.candles.length > 0
        ? bundle.candles.length - 1 + (CHART_TIMESCALE_OPTIONS.rightOffset ?? 0)
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
      // chart teardown(뷰 전환 remount) 사이에 휠이 끼어드는 경합 방어 —
      // 현재는 effect 선언 순서상 리스너가 c.remove()보다 먼저 해제되어
      // 도달 불가지만, 레포의 다른 lwc viewport 호출부와 같은 관례적 가드.
      try {
        const range = ts.getVisibleLogicalRange();
        if (!range) return; // 데이터 로드 전 — 페이지 스크롤을 방해하지 않는다
        e.preventDefault(); // 페이지 스크롤(특히 shift+휠 가로 스크롤)/브라우저 줌 차단
        // deltaMode 정규화 — 브라우저별 deltaY 단위 차이를 픽셀로 환산한다.
        // Firefox는 휠을 LINE 단위(노치당 ±3)로 보내므로 환산 없이는 줌이
        // ~35배 약해진다. 환산표는 우리가 끈 라이브러리 휠 핸들러
        // (_determineWheelSpeedAdjustment)와 동일: LINE ×32, PAGE ×120.
        // (lwc의 Windows-Chromium DPR 보정은 해당 플랫폼 한정 버그
        // 워크어라운드라 채택하지 않음 — 필요 시 후속.)
        const unit =
          e.deltaMode === e.DOM_DELTA_LINE ? 32
          : e.deltaMode === e.DOM_DELTA_PAGE ? 120
          : 1;
        const rect = container.getBoundingClientRect();
        const outcome = computeWheelOutcome({
          range,
          deltaY: e.deltaY * unit,
          shiftKey: e.shiftKey,
          ctrlOrMetaKey: e.ctrlKey || e.metaKey,
          mouseX: e.clientX - rect.left,
          coordinateToLogical: (x) => ts.coordinateToLogical(x),
          maxTo: maxToRef.current,
        });
        if (outcome) ts.setVisibleLogicalRange(outcome);
      } catch {
        // chart torn down between effect runs — 무시 (다음 차트에서 재부착)
      }
    };

    // passive: false 필수 — 기본값(passive)이면 preventDefault()가 무시되어
    // shift+휠이 페이지 가로 스크롤을 함께 일으킨다.
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, [chart, containerRef]);
}
