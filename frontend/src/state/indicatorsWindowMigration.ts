/**
 * 창 소유 지표 설정 → 전역 `live.indicators.v2` 1회 승격.
 *
 * ⚠️ **이 모듈은 #712 시절의 창 소유 설정을 걷어 오는 1회성 사다리다.** 창별
 * 지표가 ADR-0145 로 다시 생겼지만 그것은 전혀 다른 저장 위치(전역 v2 의
 * `byWindow`)를 쓰므로, 여기 로직을 그쪽 마이그레이션으로 재활용하지 말 것 —
 * 이 코드가 읽는 것은 **워크스페이스 스냅샷 안의** 지표 블롭이고, 새 모델은
 * 워크스페이스에 지표를 두지 않는다.
 *
 * #712(/live)·ADR-0123 PR-2(/study) 이후 지표 설정의 런타임 진실은 워크스페이스
 * **창**(`chart.indicators`)이었고, 워크스페이스는 탭별 sessionStorage 다. 전역화로
 * 진실을 `live.indicators.v2` 로 되돌리는데, 그 키는 그동안 **아무도 쓰지 않아
 * 스테일**이다 — 읽기만 되돌리면 사용자의 현재 지표 구성이 몇 달 전 값이나 공장값
 * 으로 조용히 회귀한다. 그래서 되돌리기 전에 창 사본을 한 번 끌어올린다.
 *
 * **1회 보장은 별도 플래그 키**로 한다(워크스페이스 스냅샷을 고쳐 쓰지 않는다).
 * 스냅샷을 건드리면 두 저장소(tab·shared)를 양쪽 페이지에서 정합하게 다시 써야
 * 하는데, 그 쓰기가 실패하거나 다른 탭이 자기 메모리를 나중에 flush 하면 승격이
 * 무한 반복되어 사용자가 새로 만진 값을 옛 창 사본이 계속 덮는다. 구 `indicators`
 * 필드는 `ChartWindowConfig` 에서 사라졌으므로 다음 저장 때 자연 소멸한다.
 *
 * 어느 창을 고르는가: **포커스(zOrder 최상단) 차트 창** — "사용자가 마지막으로
 * 보던 설정"이다. 두 페이지 중에는 `/live` 를 우선한다(그 탭 sessionStorage →
 * 공유 시드 → `/study` 순). 전역 1세트로 접는 이상 어느 하나는 져야 하고, 이
 * 순서는 PR 에 명시된 규칙이다. `/study` 는 사라졌지만(2026-08-23) 그 스냅샷을
 * 아직 들고 있는 사용자가 있으므로 **읽기 순서는 그대로 둔다**(`SOURCES` 주석).
 */
import { readJsonObject, persistJson, type StorageScope } from './persist';
import { WORKSPACE_STORAGE_KEY } from './workspaceKeys';

/** 승격 완료 마커. 값은 보지 않는다 — 키의 **존재**가 곧 "이미 했다"다. */
export const INDICATORS_WINDOW_MIGRATION_KEY = 'live.indicators.fromWindows.v1';

type RawWindow = { id?: unknown; kind?: unknown; chart?: unknown };

/**
 * 워크스페이스 raw 스냅샷에서 포커스 차트 창의 지표 블롭을 고른다.
 * 차트 창이 없거나 지표 블롭이 없으면 null. 순수 함수(테스트 대상).
 */
export function pickWindowIndicators(snapshot: unknown): unknown {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const obj = snapshot as Record<string, unknown>;
  const windows = Array.isArray(obj.windows) ? (obj.windows as RawWindow[]) : [];
  const zOrder = Array.isArray(obj.zOrder) ? obj.zOrder : [];

  const indicatorsOf = (w: RawWindow | undefined): unknown => {
    if (!w || w.kind !== 'chart') return null;
    const chart = w.chart;
    if (!chart || typeof chart !== 'object') return null;
    const ind = (chart as Record<string, unknown>).indicators;
    return ind && typeof ind === 'object' ? ind : null;
  };

  // zOrder 최상단부터 — 마지막이 포커스다(양 워크스페이스 공통 규약).
  for (let i = zOrder.length - 1; i >= 0; i -= 1) {
    const found = indicatorsOf(windows.find((w) => w.id === zOrder[i]));
    if (found) return found;
  }
  // zOrder 가 손상됐어도 차트 창이 있으면 그 설정을 잃지 않는다.
  for (const w of windows) {
    const found = indicatorsOf(w);
    if (found) return found;
  }
  return null;
}

/**
 * 사라진 `/study` 워크스페이스 스냅샷 키 — **이 1회성 사다리만 읽는다.**
 *
 * 리터럴로 둔 이유: `workspaceKeys.ts` 는 **살아 있는** 저장소 키의 목록이고,
 * 그 페이지는 2026-08-23 에 삭제됐다. 그런데 아직 승격을 안 거친 사용자의 디스크에는
 * 이 스냅샷이 남아 있을 수 있으므로 **읽기는 그대로 둔다** — 여기서 빼면 그 사용자는
 * `/live` 스냅샷이 비어 있을 때 지표가 공장값으로 회귀한다(이 모듈이 막으려던 바로
 * 그 증상). 우선순위상 마지막이라 `/live` 가 있으면 어차피 지지 않는다.
 */
const DEAD_STUDY_WORKSPACE_STORAGE_KEY = 'study.workspace.v1';

const SOURCES: readonly { key: string; scope: StorageScope }[] = [
  { key: WORKSPACE_STORAGE_KEY, scope: 'tab' },
  { key: WORKSPACE_STORAGE_KEY, scope: 'shared' },
  { key: DEAD_STUDY_WORKSPACE_STORAGE_KEY, scope: 'tab' },
  { key: DEAD_STUDY_WORKSPACE_STORAGE_KEY, scope: 'shared' },
];

/**
 * 승격할 지표 블롭을 한 번만 돌려준다. 두 번째 호출부터는 항상 null.
 *
 * 창 사본을 못 찾아도 마커를 세운다 — 신규 사용자에게 매 로드 워크스페이스
 * 스냅샷 4개를 파싱시키지 않기 위해서다.
 */
export function takeWindowIndicatorsForMigration(): unknown {
  try {
    if (localStorage.getItem(INDICATORS_WINDOW_MIGRATION_KEY) !== null) return null;
  } catch {
    // storage 자체가 없으면(SSR·privacy) 마이그레이션도 승격도 의미가 없다.
    return null;
  }
  let picked: unknown = null;
  for (const src of SOURCES) {
    picked = pickWindowIndicators(readJsonObject(src.key, src.scope));
    if (picked) break;
  }
  persistJson(INDICATORS_WINDOW_MIGRATION_KEY, 1);
  return picked;
}
