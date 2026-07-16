import type { ConditionLeaf, ScreenerUniverse } from '../api/screener';
import { persistJson, readJsonObject } from '../state/persist';

const STORAGE_KEY = 'screenerDraft.v1';

/**
 * 풀페이지 Screener 빌더의 라이브 상태(조건/유니버스/앵커/dirty) 영속 스냅샷.
 * 라우트 이탈로 <Screener /> 가 unmount 돼도 조건 입력값이 빈 draft 로 리셋되지 않게
 * 한다. screenerPanel(스캔 결과) 과 분리 — 이건 페이지 빌더 전용 상태다.
 *
 * 검증은 얕게(배열/객체/원소 type 문자열)만 한다. 조건 leaf 스키마는 백엔드가
 * 진실이고 조회 시 400 으로 최종 방어하므로, 클라이언트가 leaf 형태를 깊게 검증할
 * 이유가 없다(스키마 드리프트 시 이중 유지보수만 늘 뿐).
 */
export interface ScreenerDraft {
  conditions: ConditionLeaf[];
  universe: ScreenerUniverse;
  anchorId: string | null;
  anchorName: string | null;
  dirty: boolean;
}

export const EMPTY_SCREENER_DRAFT: ScreenerDraft = {
  conditions: [],
  universe: {},
  anchorId: null,
  anchorName: null,
  dirty: false,
};

function isConditionLeafArray(value: unknown): value is ConditionLeaf[] {
  return Array.isArray(value)
    && value.every((c) => typeof c === 'object' && c !== null && typeof (c as { type?: unknown }).type === 'string');
}

function isUniverse(value: unknown): value is ScreenerUniverse {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readScreenerDraft(): ScreenerDraft {
  const raw = readJsonObject(STORAGE_KEY);
  if (!isConditionLeafArray(raw.conditions) || !isUniverse(raw.universe)) return EMPTY_SCREENER_DRAFT;
  return {
    conditions: raw.conditions,
    universe: raw.universe,
    anchorId: typeof raw.anchorId === 'string' ? raw.anchorId : null,
    anchorName: typeof raw.anchorName === 'string' ? raw.anchorName : null,
    dirty: raw.dirty === true,
  };
}

export function persistScreenerDraft(draft: ScreenerDraft): void {
  persistJson(STORAGE_KEY, draft);
}
