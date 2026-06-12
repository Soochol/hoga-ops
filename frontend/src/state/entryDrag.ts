import { create } from 'zustand';

/**
 * 관심종목 행을 차트 워크에어리어로 드래그하는 "차트로 드롭" 제스처의 단일 소유 seam.
 *
 * 패널 재정렬과 차트-드롭은 같은 dnd-kit 드래그 한 번을 공유한다(별도 드래그
 * 시스템을 행에 얹으면 네이티브 draggable이 pointermove를 가로채 재정렬이 깨진다).
 * 이 store가 드래그 상태(draggingCode/overChart)뿐 아니라 **드롭 타깃 seam**도 소유한다:
 * LiveWorkarea가 mount 시 자신의 히트테스트 술어 `hitTestChart(clientX,clientY)`를 등록하고
 * (unmount 시 해제), WatchlistDrawer의 onDragMove/onDragEnd가 그 술어로 "이 좌표가 차트
 * 위인가"를 묻는다. 차트는 자기 지오메트리를 스스로 소유하고, 패널은 DOM·rect를 모른다.
 *
 * 이전 구현은 `document.querySelector('[data-testid="live-workarea"]')`로 테스트 ID를
 * 프로덕션 DOM 계약으로 삼아 무관 트리 건너편에서 rect를 읽었다(리네임/중복 시 조용한
 * 강등, 테스트는 DOM stub 필요). 등록 술어 seam이 그 결합을 제거한다.
 * 드래그 고스트는 패널 overflow 경계에서 잘리므로, 워크에어리어 자체가 드롭 어포던스다.
 */
type ChartHitTest = (clientX: number, clientY: number) => boolean;

type EntryDragStore = {
  /** 드래그 중인 종목 코드. null이면 (entry) 드래그 중이 아니다. */
  draggingCode: string | null;
  /** 커서가 현재 라이브 워크에어리어 위에 있는가(드롭하면 종목 변경). */
  overChart: boolean;
  /** LiveWorkarea가 등록한 "이 좌표가 차트 위인가" 술어. 미등록(/live 밖)이면 null. */
  hitTestChart: ChartHitTest | null;
  startDrag: (code: string) => void;
  setOverChart: (v: boolean) => void;
  endDrag: () => void;
  /** LiveWorkarea가 mount 시 자신의 히트테스트를 등록한다. */
  registerChartTarget: (hitTest: ChartHitTest) => void;
  /** unmount 시 해제. 다른 인스턴스가 이미 덮어쓴 뒤면 해제하지 않는다(remount 안전). */
  clearChartTarget: (hitTest: ChartHitTest) => void;
};

export const useEntryDragStore = create<EntryDragStore>((set, get) => ({
  draggingCode: null,
  overChart: false,
  hitTestChart: null,
  startDrag: (code) => set({ draggingCode: code, overChart: false }),
  // 같은 값이면 set을 건너뛴다 — onDragMove가 프레임마다 호출되므로 불필요한 리렌더 방지.
  setOverChart: (v) => set((s) => (s.overChart === v ? s : { overChart: v })),
  // 드롭 타깃 등록은 드래그 라이프사이클과 별개(워크에어리어 mount 동안 유지) — 여기선 안 건드린다.
  endDrag: () => set({ draggingCode: null, overChart: false }),
  registerChartTarget: (hitTest) => set({ hitTestChart: hitTest }),
  clearChartTarget: (hitTest) => {
    if (get().hitTestChart === hitTest) set({ hitTestChart: null });
  },
}));

/** 드롭 좌표가 등록된 차트 드롭 타깃 위인가. 워크에어리어 미등록(/live 밖)이면 false →
 *  재정렬 경로 유지. 패널 핸들러가 DOM·rect를 모른 채 seam에 질의하는 단일 진입점. */
export function isPointOnChart(point: { x: number; y: number } | null): boolean {
  if (!point) return false;
  const hit = useEntryDragStore.getState().hitTestChart;
  return hit ? hit(point.x, point.y) : false;
}
