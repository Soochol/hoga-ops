import { useEffect, useRef, type RefObject } from 'react';
import type { IChartApi, Time } from 'lightweight-charts';
import type { RangeBundle } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import { computeWheelOutcome } from '../util/wheelInteractions';
import { CHART_TIMESCALE_OPTIONS } from '../util/chartScale';

/**
 * /live 차트의 modifier-aware 휠 인터랙션 배선.
 *
 *  - 휠: 마지막 캔들 고정 줌 (라이브 엣지) / 뷰포트 오른쪽 끝 고정 (과거 스크롤)
 *  - shift+휠: 스팬 유지 팬 (오른쪽 벽 = 마지막 캔들 + rightOffset에서 클램프)
 *  - ctrl/cmd+휠: 커서 고정 줌 (클램프 없음 — 앵커 불변식 보존)
 *
 * 분기 수식은 `util/wheelInteractions.ts`의 순수 함수가 소유한다. 이 훅은
 * wheel 이벤트 → 헬퍼 입력 → `setVisibleLogicalRange` 배선만 담당.
 * 전제: `LiveChartRoot`가 `handleScale: { mouseWheel: false }`로 라이브러리
 * 내장 휠 줌을 꺼 둔다 (이중 소유권 레이스 방지). `handleScroll`(deltaX 팬)과
 * `pinch`는 라이브러리 기본값 그대로 둔다.
 *
 * 마지막 캔들 논리 인덱스(plain 앵커·shift 벽)는 `candles.length - 1`이 아니라
 * 이벤트 시점 `ts.timeToIndex(마지막 캔들 virtual time)`로 구한다 — 공유
 * timeScale은 전 페인(호가 포함) time point의 합집합으로 인덱싱하므로 체결 없는
 * 분의 호가 포인트가 끼면 candles 배열 인덱스가 실제 논리 인덱스보다 작아진다
 * (관측 skew ~263칸 → plain 앵커가 화면 왼쪽으로 어긋남). useViewportBackfill의
 * 변환과 동일 패턴이며 staleness-free(prepend 후에도 현재 axis로 재계산).
 *
 * See: docs/superpowers/specs/2026-06-07-live-wheel-interactions-design.md
 */
export function useWheelInteractions(
  chart: IChartApi | null,
  containerRef: RefObject<HTMLDivElement | null>,
  bundle: RangeBundle | null,
  axis: VirtualAxis,
  onViewportChanged?: (range: { from: number; to: number }) => void,
  getRightOffsetBars?: (visibleBars: number, plotWidth: number) => number,
): void {
  // maxTo ref — bundle 교체(SSE 푸시 포함)마다 값만 갱신, 리스너는 재부착하지
  // 않는다. 오른쪽 벽 = 마지막 캔들 + rightOffset: shift 팬으로 라이브 엣지에
  // 복귀하면 기본 뷰(우측 여백 포함)와 정확히 같은 화면에서 멈춘다. 처음엔
  // 마지막 캔들 타이트(length - 1)였으나 필드 사용 후 버퍼안으로 개정 —
  // 스펙 결정 #2 개정(2026-06-08) 참조. 빈 bundle 윈도우는 Infinity로 벽을
  // 비활성화한다 (length === 0이면 벽이 여백 안쪽으로 파고들어 퇴화 클램프 발생;
  // maxTo를 읽는 분기는 shift 오른쪽 팬뿐).
  // 마지막 캔들의 real ms와 현재 axis를 ref로 들고, 이벤트 시점에 합집합 논리
  // 인덱스(trueLast)로 변환한다. ref로 두는 이유: bundle/axis를 리스너 effect
  // deps에 넣으면 SSE 푸시마다 리스너가 재부착되어 churn이 생긴다(기존 설계).
  const lastMsRef = useRef<number | undefined>(undefined);
  const axisRef = useRef<VirtualAxis>(axis);
  const getRightOffsetBarsRef = useRef<typeof getRightOffsetBars>(getRightOffsetBars);
  useEffect(() => {
    lastMsRef.current =
      bundle != null && bundle.candles.length > 0
        ? bundle.candles[bundle.candles.length - 1].ts_ms
        : undefined;
  }, [bundle]);
  useEffect(() => {
    axisRef.current = axis;
  }, [axis]);
  useEffect(() => {
    getRightOffsetBarsRef.current = getRightOffsetBars;
  }, [getRightOffsetBars]);

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
        // 줌아웃 플로어 합성: 라이브러리는 barSpacing < minBarSpacing이 되는
        // span을 거부하면서 오른쪽 끝(rightOffset)만 적용한다 — 무클램프 줌
        // 요청이 플로어에서 우측 팬으로 변질되어 ctrl 앵커가 풀린다
        // (/diagnose 2026-06-08). 요청 span을 플로어 한계로 미리 클램프하면
        // 앵커 비율이 보존된다. width()는 리사이즈 대응을 위해 이벤트 시점에
        // 읽는다 (plot 폭 px / minBarSpacing px = 최대 표시 바 수).
        const plotWidth = ts.width();
        const minBarSpacing = chart.options().timeScale.minBarSpacing;
        const maxSpan =
          plotWidth > 0 && minBarSpacing > 0
            ? plotWidth / minBarSpacing
            : Number.POSITIVE_INFINITY;
        // 마지막 캔들의 합집합 논리 인덱스(trueLast)를 이벤트 시점에 변환:
        // candles.length-1은 호가 페인 합집합 때문에 작게 어긋난다(상단 주석).
        // null/비정상이면 undefined → plain 앵커는 to-고정, shift 벽은 Infinity로
        // 폴백(=기존 보수적 동작).
        let lastBarIndex: number | undefined;
        const lastMs = lastMsRef.current;
        const ax = axisRef.current;
        if (lastMs != null && ax.segments.length > 0) {
          const vt = Math.round(ax.toVirtual(lastMs) / 1000);
          const idx = ts.timeToIndex(vt as Time, true);
          if (typeof idx === 'number' && Number.isFinite(idx)) lastBarIndex = idx;
        }
        const rightOffsetBars =
          getRightOffsetBarsRef.current?.(Math.max(1, range.to - range.from), plotWidth) ??
          (CHART_TIMESCALE_OPTIONS.rightOffset ?? 0);
        const maxTo =
          lastBarIndex != null
            ? lastBarIndex + rightOffsetBars
            : Number.POSITIVE_INFINITY;
        const outcome = computeWheelOutcome({
          range,
          deltaY: e.deltaY * unit,
          shiftKey: e.shiftKey,
          ctrlOrMetaKey: e.ctrlKey || e.metaKey,
          mouseX: e.clientX - rect.left,
          coordinateToLogical: (x) => ts.coordinateToLogical(x),
          maxTo,
          lastBarIndex,
          maxSpan,
        });
        if (outcome) {
          ts.setVisibleLogicalRange(outcome);
          onViewportChanged?.(outcome);
        }
      } catch {
        // chart torn down between effect runs — 무시 (다음 차트에서 재부착)
      }
    };

    // passive: false 필수 — 기본값(passive)이면 preventDefault()가 무시되어
    // shift+휠이 페이지 가로 스크롤을 함께 일으킨다.
    //
    // 부착 타겟은 container가 아니라 그 부모(live-chart-root)다. DrawingOverlay는
    // container의 형제로 그 위에 겹쳐 있고(z-20, inset-0), 그리기 도구 활성 또는
    // 그려진 선 위 hover 시 pointer-events:auto가 되어 휠 이벤트를 가로챈다.
    // 형제는 버블링 경로 밖이라 container 리스너에 도달하지 못해 preventDefault가
    // 누락되고 브라우저 페이지 줌이 발동했다(/diagnose 2026-06-13). 공통 부모에
    // 부착하면 container·overlay 어느 쪽에서 발생한 휠도 버블링으로 한 번 잡힌다
    // (실제 wheel 이벤트는 bubbles:true). rect·ts.width()는 container 기준 그대로
    // 읽는다 — 부모·container·overlay가 모두 동일 크기(100%·inset-0)라
    // clientX-rect.left 좌표가 동일하다. 형제 오버레이들(DrawingPropertyPanel·
    // PaneLegendOverlay 등)은 스크롤 컨테이너가 아니므로 stopPropagation 불필요.
    const wheelTarget = container.parentElement ?? container;
    wheelTarget.addEventListener('wheel', onWheel, { passive: false });
    return () => wheelTarget.removeEventListener('wheel', onWheel);
  }, [chart, containerRef, onViewportChanged]);
}
