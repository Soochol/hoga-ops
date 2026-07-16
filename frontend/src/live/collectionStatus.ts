/**
 * 종목별 수집 상태 (순수함수). ADR-0067:
 * - realtime    : code가 live_set(WS 실시간 수집)에 있음
 * - polling      : live_set 밖이지만 현재 보는 종목(REST 화면 표시 중)
 * - waiting_eod  : watchlist엔 있으나 live_set 밖 + 안 보는 중 (관심종목 26 초과 폴백; 정상 운영에선 드묾)
 * - uncollected  : 그 외 (관심종목 밖 + 안 보는 중)
 */
export type CollectionStatus = 'realtime' | 'polling' | 'waiting_eod' | 'uncollected';

export function deriveCollectionStatus(
  code: string | null,
  liveSet: string[],
  watchlistCodes: string[],
  viewedCodes: string[],
  kiwoomCodes: string[] = [],
): CollectionStatus {
  if (!code) return 'uncollected';
  // 키움 WS 수집 종목(히트맵)도 KIS WS(live_set)와 동급 실시간(ADR-0116). 종목 소유권
  // 단일이라 두 집합은 disjoint — 합집합 멤버십으로 realtime(●) 판정.
  if (liveSet.includes(code) || kiwoomCodes.includes(code)) return 'realtime';
  if (viewedCodes.includes(code)) return 'polling';
  if (watchlistCodes.includes(code)) return 'waiting_eod';
  return 'uncollected';
}

/** 표시상태 = collection 상태 + (realtime 한정) WS 연결.
 *  realtime 종목만 WS(live_set)에 의존하므로 !live → disconnected.
 *  polling(REST)·waiting_eod는 connection과 독립이라 그대로 통과(오표시 방지). */
export type DisplayStatus =
  | 'realtime' | 'polling' | 'waiting_eod' | 'disconnected' | 'uncollected';

export function deriveDisplayStatus(
  live: boolean,
  status: CollectionStatus,
): DisplayStatus {
  if (status === 'realtime' && !live) return 'disconnected';
  return status;
}

export interface DisplayPresentation {
  /** null이면 점만(정상). 문자열이면 점 + 라벨(예외). */
  label: string | null;
  colorVar: string;
  ariaLabel: string;
}

/** 점/라벨/색/aria 단일 출처. CollectionDot이 소비. */
export const DISPLAY_PRESENTATION: Record<DisplayStatus, DisplayPresentation> = {
  realtime:     { label: null,       colorVar: 'var(--success)',   ariaLabel: '실시간 수집 중' },
  polling:      { label: null,       colorVar: 'var(--fg-dimmer)', ariaLabel: 'REST 표시 중' },
  waiting_eod:  { label: null,       colorVar: 'var(--fg-dimmer)', ariaLabel: '관심종목 대기 중' },
  disconnected: { label: '재연결 중', colorVar: 'var(--warn)',      ariaLabel: '연결 재시도 중' },
  uncollected:  { label: null,       colorVar: 'var(--fg-dimmer)', ariaLabel: '' },
};

export interface CollectionViewInput {
  code: string | null;
  liveSet: string[];
  watchlistCodes: string[];
  viewedCodes: string[];
  kiwoomCodes?: string[];
  kisApiTargets?: string[];
  captureCandidate?: boolean;
  liveConnection?: boolean;
}

export interface CollectionView {
  collectionStatus: CollectionStatus;
  displayStatus: DisplayStatus;
  ariaLabel: string;
  storageLabel: string;
}

export function deriveStorageLabel(input: {
  code: string | null;
  liveSet: string[];
  kiwoomCodes?: string[];
  kisApiTargets?: string[];
  captureCandidate?: boolean;
}): string {
  const { code, liveSet, kiwoomCodes = [], kisApiTargets = [], captureCandidate = true } = input;
  if (!code || !captureCandidate) return '저장 제외';
  if (liveSet.includes(code)) return 'KIS WS 저장 중';
  if (kiwoomCodes.includes(code)) return '키움 WS 저장 중';
  if (kisApiTargets.includes(code)) return 'KIS API 30초 저장 중';
  return '대기';
}

export function deriveCollectionView(input: CollectionViewInput): CollectionView {
  const collectionStatus = deriveCollectionStatus(
    input.code,
    input.liveSet,
    input.watchlistCodes,
    input.viewedCodes,
    input.kiwoomCodes ?? [],
  );
  const displayStatus = deriveDisplayStatus(input.liveConnection ?? true, collectionStatus);
  return {
    collectionStatus,
    displayStatus,
    ariaLabel: DISPLAY_PRESENTATION[displayStatus].ariaLabel,
    storageLabel: deriveStorageLabel({
      code: input.code,
      liveSet: input.liveSet,
      kiwoomCodes: input.kiwoomCodes,
      kisApiTargets: input.kisApiTargets,
      captureCandidate: input.captureCandidate,
    }),
  };
}
