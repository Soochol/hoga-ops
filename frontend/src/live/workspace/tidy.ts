/**
 * Tidy — 열린 창들을 겹침 없는 타일로 자동 정렬하는 순수 배치 알고리즘 (ADR-0119).
 *
 * 자유 플로팅의 "어질러짐"을 원클릭으로 리셋하는 안전망. 차트 창은 좌측 영역에
 * 그리드(열 최대 3)로, 데이터 창은 우측 열에 세로 스택으로 배치한다. 순수 함수라
 * 단위 테스트로 고정한다.
 */
import type { Rect, Canvas } from './snapEngine';

/** Tidy 입력 최소 형태 — 스토어의 WindowKind 에 결합하지 않도록 isChart 로 축약. */
export interface TidyWindow {
  id: string;
  isChart: boolean;
}

/** 차트 그리드가 차지하는 가로 비율(데이터 창이 있을 때). */
const CHART_FRACTION = 0.72;
const MAX_CHART_COLS = 3;

/**
 * 창들을 타일로 정렬한 새 rect 맵을 반환한다. 입력 순서가 배치 순서다(차트는
 * 좌→우·상→하, 데이터는 위→아래). 빈 입력이면 빈 맵.
 */
export function tidyLayout(windows: readonly TidyWindow[], canvas: Canvas): Map<string, Rect> {
  const out = new Map<string, Rect>();
  if (windows.length === 0) return out;

  const charts = windows.filter((w) => w.isChart);
  const datas = windows.filter((w) => !w.isChart);

  const chartW = datas.length > 0 ? Math.round(canvas.w * CHART_FRACTION) : canvas.w;
  const dataW = canvas.w - chartW;

  if (charts.length > 0) {
    const cols = Math.min(MAX_CHART_COLS, charts.length);
    const rows = Math.ceil(charts.length / cols);
    const cw = Math.round(chartW / cols);
    const ch = Math.round(canvas.h / rows);
    charts.forEach((win, i) => {
      const r = Math.floor(i / cols);
      const c = i % cols;
      out.set(win.id, { x: c * cw, y: r * ch, w: cw, h: ch });
    });
  }

  if (datas.length > 0) {
    // 차트가 하나도 없으면 데이터 창이 전체 폭을 나눠 갖는다.
    const dx = charts.length > 0 ? chartW : 0;
    const dw = charts.length > 0 ? dataW : canvas.w;
    const dh = Math.round(canvas.h / datas.length);
    datas.forEach((win, i) => {
      out.set(win.id, { x: dx, y: i * dh, w: dw, h: dh });
    });
  }

  return out;
}
