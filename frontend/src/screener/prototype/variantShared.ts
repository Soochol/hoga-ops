// ============================================================================
// PROTOTYPE — throwaway. /screener UI 리팩토링 변형(A/B/C)의 공유 props 타입과
// 순수 헬퍼. `?variant=` URL 파라미터로 전환한다(PrototypeSwitcher 참조).
// 승자가 정해지면 이 디렉터리 전체를 폐기 브랜치로 옮기고 main 에서는 지운다.
// ============================================================================
import type { SavedScreenerEditor } from '../useSavedScreenerEditor';
import type {
  DepthCoverage,
  DepthPeakValue,
  ScanBasis,
  ScreenerStatus,
} from '../../api/screener';
import type { SavedScreener } from '../../api/savedScreeners';
import type { PanelScan } from '../../state/screenerPanel';
import type { ScreenerRowLive } from '../useScreenerRowsLive';
import type { ScreenerResultSortMode } from '../sortResults';
import type { DepthSides } from '../ResultTable';
import type { ScreenerUpdateFeedback } from '../useScreenerUpdateSync';
import type { JumpModifiers } from '../../live/useJumpToLive';

/** 페이지(Screener.tsx)가 훅으로 만든 상태·핸들러 전부 — 변형은 렌더만 바꾼다. */
export interface ScreenerViewProps {
  editor: SavedScreenerEditor;
  saves: SavedScreener[];
  basis: ScanBasis;
  setBasis: (b: ScanBasis) => void;
  runScan: () => void;
  scanPending: boolean;
  scanFailed: boolean;
  scanErrorMessage: string | null;
  depthCoverage: DepthCoverage | null;
  autoCollect: boolean;
  lastScan: PanelScan | null;
  /** 정렬·Live Quote 머지가 끝난 표시용 행. */
  rows: ScreenerRowLive[];
  sortMode: ScreenerResultSortMode;
  setSortMode: (m: ScreenerResultSortMode) => void;
  notSeeded: boolean;
  hasConditions: boolean;
  resultsStale: boolean;
  intradayDegradation: string | null;
  scopeUniverseEmpty: boolean;
  etfFilterStale: boolean;
  renewalNeedsIntraday: boolean;
  status: ScreenerStatus | undefined;
  updatePending: boolean;
  updateFailed: boolean;
  updateFeedback: ScreenerUpdateFeedback | null;
  serverUpdating: boolean;
  onUpdate: () => void;
  openLive: (code: string, name?: string, e?: JumpModifiers) => void;
  currentTitle: string;
  saveCurrent: () => void;
  openSaveAs: () => void;
  depthValues: Record<string, DepthPeakValue> | null;
  depthSides: DepthSides;
}

export interface StatusFlag {
  key: string;
  text: string;
  /** banner = 행동이 필요해 배너로 승격할 후보, chip = 메타 줄 칩으로 충분. */
  weight: 'banner' | 'chip';
}

/** 경고를 우선순위 순으로 평탄화 — 변형들은 첫 banner 급 1개만 배너로 올리고
 *  나머지는 칩으로 강등하는 데 쓴다(제안 ⑧). */
export function collectStatusFlags(p: ScreenerViewProps): StatusFlag[] {
  const flags: StatusFlag[] = [];
  if (!p.hasConditions) {
    flags.push({ key: 'no-conditions', weight: 'banner',
      text: '조건이 없습니다 · 조건을 추가하면 조회할 수 있습니다' });
  }
  if (p.resultsStale) {
    flags.push({ key: 'stale', weight: 'banner', text: '조건 변경됨 · 다시 조회 필요' });
  }
  if (p.renewalNeedsIntraday) {
    flags.push({ key: 'renewal-intraday', weight: 'banner',
      text: '매도 총잔량 기준시각 돌파는 당일 전용 · 장중 기준으로 조회하세요' });
  }
  if (p.scopeUniverseEmpty) {
    flags.push({ key: 'scope-empty', weight: 'banner',
      text: '종목 범위가 비어 있음 · 관심종목·히트맵에 종목을 추가하세요' });
  }
  if (p.intradayDegradation) {
    flags.push({ key: 'degraded', weight: 'chip', text: p.intradayDegradation });
  }
  if (p.etfFilterStale) {
    flags.push({ key: 'etf-stale', weight: 'chip',
      text: '종목 마스터 없음 · ETF 제외가 오래된 목록 기준입니다' });
  }
  return flags;
}

export function fmtScannedAt(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function basisLabel(basis: ScanBasis): string {
  return basis === 'intraday' ? '오늘 장중' : '전일 확정';
}
