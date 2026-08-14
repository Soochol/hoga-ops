import { create } from 'zustand';
import { MINUTE_TIMEFRAMES, type MinuteTimeframe } from './livePage';

const STORAGE_KEY = 'studyView.openPrefs.v1';
// 'keep'    = 차트 창이 지금 들고 있는 봉을 **그대로 둔다**(기본값).
// 'saved'   = 저장뷰가 저장한 봉 그대로 연다.
// 'current' = study 차트에서 마지막으로 설정한 분봉(useStudyLastMinuteTimeframeStore)으로 연다.
// 그 외는 고정 분봉.
//
// **'keep' 이 기본인 이유는 멀티 타임프레임 배치다**(2026-08-14). 나머지 세 값은
// 전부 "저장뷰가 봉을 정한다" 는 같은 축 위에 있고, 그 축은 창이 여럿일 때
// **사용자가 벌려 둔 배치를 무너뜨린다** — 일봉 창 + 3분봉 창을 띄워 둔 상태에서
// 1분봉 저장뷰를 열면 포커스 창(일봉)이 1분봉으로 덮여 "분봉, 분봉" 이 된다.
// #1295 가 넣은 완화(같은 봉을 이미 보여주는 창이 있으면 포커스만 이동)는 봉이
// **정확히 일치할 때만** 걸리므로 이 순서를 못 막았다.
//
// ⚠ 'keep' 은 아래 캐시 warm 보장을 **의도적으로 포기**한다. 저장뷰가 정하는 것은
// 종목·구간이고 봉은 창이 소유한다는 계약이다. 속도가 우선이면 'saved' 를 고른다.
//
// **'saved' 는 한 번 폐지됐다가 되살아났다**(#837 에서 'current' 로 옮겼고 여기서 복귀).
// 되살린 이유는 취향이 아니라 캐시다: 봉 종속 지표 캐시는 파일명에 `bucket_ms` 가
// 있어 **처음 보는 봉은 그 구간을 통째로 재계산**한다. 저장 시점의 사용자는 그 구간을
// **그 봉으로 보고 있었으므로** 저장 봉의 캐시는 이미 채워져 있다 — 즉 저장 봉으로
// 열면 warm 이 확률이 아니라 **구조**다(2026-08-13 실측: 저장 봉 기준 `ask_peak`·
// `bid_peak` 미계산 1.1%). 다른 봉으로 열면 그 보장이 사라진다.
//
// ⚠ 폐지 시절의 마이그레이션('saved'→'current')은 **읽을 때만** 변환했고 저장은 하지
// 않았다. 그래서 그때 'saved' 를 골랐던 사용자의 저장값은 여전히 'saved' 다 — 승격을
// 걷어내는 것만으로 원래 선택이 복원되고, 강제 마이그레이션이 필요 없다.
export type StudyViewOpenTimeframe = 'keep' | 'saved' | 'current' | MinuteTimeframe;

interface Store {
  defaultTimeframe: StudyViewOpenTimeframe;
  setDefaultTimeframe: (value: StudyViewOpenTimeframe) => void;
  hydrateFromStorage: () => void;
}

function isStudyViewOpenTimeframe(value: unknown): value is StudyViewOpenTimeframe {
  return value === 'keep'
    || value === 'saved'
    || value === 'current'
    || (typeof value === 'string' && MINUTE_TIMEFRAMES.includes(value as MinuteTimeframe));
}

function normalizeStored(value: unknown): StudyViewOpenTimeframe | null {
  return isStudyViewOpenTimeframe(value) ? value : null;
}

function readStorage(): { defaultTimeframe: StudyViewOpenTimeframe } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { defaultTimeframe?: unknown };
    const normalized = normalizeStored(parsed.defaultTimeframe);
    return normalized ? { defaultTimeframe: normalized } : null;
  } catch {
    return null;
  }
}

function persist(state: { defaultTimeframe: StudyViewOpenTimeframe }): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage may be unavailable.
  }
}

/**
 * 한 번도 고른 적 없는 사용자의 기본값.
 *
 * ⚠ **이미 저장된 값은 마이그레이션하지 않는다** — 설정에서 명시적으로 'saved' 를
 * 고른 사용자는 캐시 warm 을 알고 고른 것이므로 그 선택을 뒤집지 않는다.
 */
export const STUDY_VIEW_DEFAULT_OPEN_TIMEFRAME: StudyViewOpenTimeframe = 'keep';

export const useStudyViewOpenPrefsStore = create<Store>((set) => ({
  defaultTimeframe: readStorage()?.defaultTimeframe ?? STUDY_VIEW_DEFAULT_OPEN_TIMEFRAME,

  setDefaultTimeframe: (value) => {
    if (!isStudyViewOpenTimeframe(value)) return;
    set({ defaultTimeframe: value });
    persist({ defaultTimeframe: value });
  },

  hydrateFromStorage: () => {
    const stored = readStorage();
    if (stored) set({ defaultTimeframe: stored.defaultTimeframe });
  },
}));
