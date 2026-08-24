import type { PaneId } from './drawing/types';
import { CANONICAL_PANE_ORDER } from './paneOrder';

/**
 * Pane 병합 그룹 (ADR 예정 — 보조지표 pane 병합).
 *
 * `paneGroups` 는 **순서 있는 그룹 목록**이고 각 그룹은 지표 PaneId 목록이다 —
 * 즉 전체 PaneId 집합의 **순열 + 분할(partition)** 이다. 같은 그룹의 멤버들은
 * lightweight-charts 의 **같은 pane** 에 마운트된다(멤버당 RangeSeriesPane 1개,
 * 그룹당 paneIndex 1개).
 *
 * `paneOrder`(ADR-0114 §3) 와의 관계: paneOrder 는 이제 `flattenPaneGroups` 의
 * **파생 투영**이다. 저장 블롭에는 둘 다 실리지만(paneGroups 없는 구 빌드가
 * 순서라도 읽도록), 읽기는 paneGroups 가 있으면 그것이 원본이다 — 구 빌드는
 * 블롭 전체를 재조립해 쓰므로 paneGroups 키가 통째로 사라지고, 그때는
 * paneOrder 싱글턴 파생으로 자연 복귀한다(스테일 그룹이 남는 경로가 없다).
 *
 * 불변식 (normalizePaneGroups 가 강제):
 *  - candle 은 항상 **단독 그룹, index 0** (timeScale·드로잉·오버레이 앵커 —
 *    paneOrder 의 candle 규칙과 동일).
 *  - 모든 PaneId 가 정확히 한 번 등장한다(unknown 드롭·중복 제거·누락은 canonical
 *    순서의 싱글턴 그룹으로 append — 게이트로 부재중인 pane 도 자리는 보존).
 *  - 빈 그룹 없음.
 *
 * **멤버십은 여전히 타임프레임 게이트 소유다**(`paneSpecsForTimeframe`) — 그룹은
 * 레이아웃일 뿐이라, 현재 봉에서 게이트로 빠진 멤버는 그냥 마운트되지 않고 전원
 * 빠진 그룹은 pane 자체가 생기지 않는다.
 */
export type PaneGroups = PaneId[][];

const CANONICAL_SET = new Set<string>(CANONICAL_PANE_ORDER);

function isPaneId(value: unknown): value is PaneId {
  return typeof value === 'string' && CANONICAL_SET.has(value);
}

/** 순서 순열을 싱글턴 그룹 목록으로 — v1/구 블롭(paneOrder 만 있음)의 파생과
 *  프리셋 적용(그룹은 프리셋 범위 밖 — 적용 = 싱글턴 리셋)이 쓴다. */
export function paneGroupsFromOrder(order: readonly PaneId[]): PaneGroups {
  return order.map((id) => [id]);
}

/** 그룹의 평탄화 = 종전 `paneOrder` 투영. 저장 블롭의 paneOrder 필드와
 *  기존 flat 소비자(`paneSpecsForTimeframe` 의 순열 인자)가 이 값을 받는다. */
export function flattenPaneGroups(groups: readonly (readonly PaneId[])[]): PaneId[] {
  return groups.flat() as PaneId[];
}

/**
 * 저장된 paneGroups 를 정규화한다 — 도크스트링의 불변식 3종을 강제.
 * 형태가 배열이 아니면(누락 포함) canonical 싱글턴 전체를 돌려준다.
 */
export function normalizePaneGroups(raw: unknown): PaneGroups {
  const seen = new Set<PaneId>();
  const groups: PaneGroups = [];
  if (Array.isArray(raw)) {
    for (const rawGroup of raw) {
      if (!Array.isArray(rawGroup)) continue;
      const members: PaneId[] = [];
      for (const id of rawGroup) {
        if (!isPaneId(id) || seen.has(id)) continue;
        // candle 은 아래에서 단독 그룹으로 강제 — 저장값이 어느 그룹에 넣었든 뺀다.
        if (id === 'candle') {
          seen.add(id);
          continue;
        }
        seen.add(id);
        members.push(id);
      }
      if (members.length > 0) groups.push(members);
    }
  }
  // 누락 pane 은 canonical 순서의 싱글턴으로 append (normalizeKeyOrder 와 같은 규율).
  for (const id of CANONICAL_PANE_ORDER) {
    if (id === 'candle' || seen.has(id)) continue;
    groups.push([id]);
  }
  return [['candle'], ...groups];
}

/** `pane` 이 속한 그룹 인덱스. 없으면 -1 (정규화된 그룹에서는 일어나지 않는다). */
export function paneGroupIndexOf(
  groups: readonly (readonly PaneId[])[],
  pane: PaneId,
): number {
  return groups.findIndex((g) => g.includes(pane));
}

/**
 * `source` 지표를 `target` 지표가 속한 그룹으로 옮긴다(병합 드롭).
 * 멤버는 그룹 **끝에** 붙는다 — 첫 멤버(= 오른쪽 축 소유, 대표)는 바뀌지 않는다.
 * candle 관련·자기 자신·미지 pane 은 no-op(원본 배열 반환으로 identity 보존).
 */
export function mergePaneIntoGroup(
  groups: PaneGroups,
  source: PaneId,
  target: PaneId,
): PaneGroups {
  if (source === 'candle' || target === 'candle' || source === target) return groups;
  const sourceIdx = paneGroupIndexOf(groups, source);
  const targetIdx = paneGroupIndexOf(groups, target);
  if (sourceIdx < 0 || targetIdx < 0 || sourceIdx === targetIdx) return groups;
  const next = groups.map((g) => g.filter((id) => id !== source));
  next[targetIdx] = [...next[targetIdx], source];
  return next.filter((g) => g.length > 0);
}

/**
 * `pane` 을 자기 그룹에서 빼내 **새 싱글턴 그룹**으로 `boundaryIndex` 위치에
 * 끼운다(경계 드롭 = 분리/이동). `boundaryIndex` 는 **원본 그룹 목록 기준**의
 * 그룹 사이 경계(0 = 맨 앞 = candle 앞은 불허라 1 로 클램프, groups.length =
 * 맨 뒤). 싱글턴을 빼서 다시 끼우면 순수 이동이 된다 — 병합의 역연산과 pane
 * 이동이 한 연산이다.
 */
export function extractPaneToBoundary(
  groups: PaneGroups,
  pane: PaneId,
  boundaryIndex: number,
): PaneGroups {
  if (pane === 'candle') return groups;
  const fromIdx = paneGroupIndexOf(groups, pane);
  if (fromIdx < 0) return groups;
  // 제거 후 인덱스 보정: 빼낸 pane 이 싱글턴이었으면 그 그룹이 사라져,
  // 그 뒤를 가리키던 경계가 한 칸 당겨진다.
  const wasSingleton = groups[fromIdx].length === 1;
  const without = groups
    .map((g) => g.filter((id) => id !== pane))
    .filter((g) => g.length > 0);
  let at = boundaryIndex;
  if (wasSingleton && boundaryIndex > fromIdx) at -= 1;
  // candle(그룹 0) 앞으로는 못 간다.
  at = Math.max(1, Math.min(at, without.length));
  // 싱글턴을 제자리에 다시 끼우는 무의미 이동이면 원본 identity 보존.
  if (wasSingleton && at === fromIdx) return groups;
  return [...without.slice(0, at), [pane], ...without.slice(at)];
}

/**
 * `pane` 이 속한 **그룹 전체**를 `neighbor` 가 속한 그룹의 앞/뒤로 옮긴다 —
 * 레전드 ↑/↓ 의 그룹 판(`movePaneBeside` 의 인접 삽입 시맨틱 승계: swap 이
 * 아니라 최소 이동이라, 게이트로 부재중인 그룹의 상대 위치가 보존된다).
 */
export function movePaneGroupBeside(
  groups: PaneGroups,
  pane: PaneId,
  neighbor: PaneId,
  side: 'before' | 'after',
): PaneGroups {
  if (pane === 'candle') return groups;
  const fromIdx = paneGroupIndexOf(groups, pane);
  const neighborIdx = paneGroupIndexOf(groups, neighbor);
  if (fromIdx < 0 || neighborIdx < 0 || fromIdx === neighborIdx) return groups;
  const moving = groups[fromIdx];
  const without = groups.filter((_, i) => i !== fromIdx);
  const ni = without.findIndex((g) => g.includes(neighbor));
  const at = Math.max(1, side === 'before' ? ni : ni + 1);
  return [...without.slice(0, at), moving, ...without.slice(at)];
}

/**
 * 병합 pane 의 y축 공유 화이트리스트 — **단위·극성이 같아도 자동 공유하지 않는다**
 * (거래량+총잔량이 반례: 둘 다 주 단위·0+ 인데 봉당 유량 vs 상시 수준이라 자릿수가
 * 달라, 공유하면 한쪽이 눌려 읽을 수 없다). 직접 비교가 병합의 존재 이유인 조합만
 * 나열한다 — 시작은 외국인+기관 순매수량(같은 주 단위·같은 ± 일별 순매수·같은 D
 * 게이트) 1쌍.
 */
const SHARED_AXIS_SETS: readonly (readonly string[])[] = [
  ['investor-foreign', 'investor-institution'],
];

/** 이 멤버 구성이 화이트리스트 축 공유 조합인가(2인 이상 + 전원이 한 세트 안). */
export function isSharedAxisGroup(members: readonly string[]): boolean {
  if (members.length <= 1) return false;
  return SHARED_AXIS_SETS.some((set) => members.every((id) => set.includes(id)));
}

/**
 * 병합 그룹의 y축 **모드** (v2 boolean 공유 → v3 3모드).
 *
 * - `'isolated'` — 멤버별 격리 스케일(비화이트리스트 기본값). 오른쪽 축은 대표 것.
 * - `'shared'` — 전원 오른쪽 축 하나(오토스케일 합산; 화이트리스트 쌍의 기본값).
 * - `'left'` — 대표는 오른쪽 축, **둘째 멤버는 왼쪽 축**(둘 다 눈금이 보인다),
 *   셋째부터는 격리. lwc 특성상 왼쪽 축 컬럼 폭은 차트 전체가 나눠 갖는다(다른
 *   pane 에도 빈 거터) — 그래서 opt-in 이다.
 *
 * 키 = 멤버 구성(정렬 join, `paneGroupKey`) — 구성이 바뀌면 키가 달라져 선택이
 * **기본값으로 리셋**된다(의도: 새 멤버는 단위가 다를 수 있다).
 */
export type PaneAxisMode = 'shared' | 'isolated' | 'left';

export type PaneAxisModeMap = Record<string, PaneAxisMode>;

/** 그룹 구성 → 그룹 단위 오버라이드 맵(축 모드·그룹 stretch)의 키.
 *  순서 무관(정렬) — 같은 멤버면 같은 그룹이다. */
export function paneGroupKey(members: readonly string[]): string {
  return [...members].sort().join(',');
}

const AXIS_MODES = new Set<string>(['shared', 'isolated', 'left']);

/** 현재 paneGroups 의 2인 이상 그룹 구성 키 집합 — 그룹 단위 오버라이드 맵들의
 *  공통 생존 판정(스테일 키는 정규화에서 걷혀 해체 시 자연 소멸). */
function liveGroupKeys(groups: readonly (readonly PaneId[])[]): Set<string> {
  return new Set(groups.filter((g) => g.length > 1).map((g) => paneGroupKey(g)));
}

/** 저장된 축 모드 맵을 정규화한다 — 미지 값·현재 그룹과 매칭 안 되는 키 드롭. */
export function normalizePaneAxisMode(
  raw: unknown,
  groups: readonly (readonly PaneId[])[],
): PaneAxisModeMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const liveKeys = liveGroupKeys(groups);
  const out: PaneAxisModeMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string' || !AXIS_MODES.has(value)) continue;
    if (!liveKeys.has(key)) continue;
    out[key] = value as PaneAxisMode;
  }
  return out;
}

/** 그룹 구성의 기본 축 모드 — 화이트리스트 쌍만 공유, 나머지는 격리. */
export function defaultAxisMode(members: readonly string[]): PaneAxisMode {
  return isSharedAxisGroup(members) ? 'shared' : 'isolated';
}

/** 그룹의 **유효** 축 모드 = 수동 오버라이드 ?? 기본값. 싱글턴은 항상 격리(무의미). */
export function resolveAxisMode(
  members: readonly string[],
  modeMap: PaneAxisModeMap,
): PaneAxisMode {
  if (members.length <= 1) return 'isolated';
  return modeMap[paneGroupKey(members)] ?? defaultAxisMode(members);
}

/**
 * 그룹 단위 stretch 오버라이드 (v3) — separator 드래그로 병합 pane 을 리사이즈한
 * 결과를 **그룹 키에** 저장한다. 없으면 멤버 최대값 파생(`paneGroupStretch`).
 * 종전(멤버 전원에게 기록)은 분리 후 두 pane 이 같은 크기로 시작하는 부작용이
 * 있었다 — 그룹 키 저장이면 분리 시 멤버 각자의 옛 stretch 가 살아난다.
 */
export type PaneGroupStretchMap = Record<string, number>;

// paneOrder.ts 의 paneStretch 와 같은 경계 — 스펙 기본값 0.3~1.4 스케일 기준,
// 밖은 손상된 저장값으로 간주(극단값이 다른 pane 을 0 으로 짓누르는 것 차단).
const GROUP_STRETCH_MIN = 0.05;
const GROUP_STRETCH_MAX = 20;

/** 저장된 그룹 stretch 맵을 정규화한다 — 비유한·범위 밖·스테일 키 드롭. */
export function normalizePaneGroupStretch(
  raw: unknown,
  groups: readonly (readonly PaneId[])[],
): PaneGroupStretchMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const liveKeys = liveGroupKeys(groups);
  const out: PaneGroupStretchMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (value < GROUP_STRETCH_MIN || value > GROUP_STRETCH_MAX) continue;
    if (!liveKeys.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * 병합 pane 에서 `member` 시리즈가 쓸 priceScaleId 를 정한다.
 *
 * - 그룹의 **첫 멤버**(대표)는 원래 스케일 그대로 → 오른쪽 축 눈금은 대표 것.
 * - `'shared'` 모드는 전원 원래 스케일 유지 → 축을 실제로 공유한다.
 * - `'left'` 모드의 **둘째 멤버**는 'right' 계열이 'left' 로 간다(왼쪽 축 눈금).
 *   누적선 오버레이('')는 왼쪽 축을 차지하면 안 되므로 격리 유지 — 솔로 pane 에서도
 *   자기 스케일이었다.
 * - 그 외(격리 대상)는 멤버별 숨은 오버레이 스케일 — 원래 id 를 **접두**로
 *   네임스페이스한다. 'right' 만이 아니라 ''(거래량·체결강도의 누적선 오버레이
 *   스케일)도 리매핑해야 한다: lwc 는 같은 id = 같은 스케일이라, 두 멤버의
 *   누적선이 둘 다 '' 면 한 오토스케일을 나눠 갖게 된다.
 *
 * 반환이 null 이면 "리매핑 없음"(스펙의 원래 id 사용).
 *
 * 인자가 `PaneId` 가 아니라 string 인 이유: 소비자가 `RangeSeriesPane`(chart/)의
 * `spec.name: string` 이라, 여기서 좁히면 호출부마다 캐스트가 생긴다 — 판정은
 * 문자열 멤버십뿐이라 넓혀도 잃는 것이 없다.
 */
export function priceScaleIdForGroupMember(
  group: readonly string[],
  member: string,
  originalId: string,
  /** 유효 축 모드(`resolveAxisMode` — 수동 오버라이드 반영). 생략 시 화이트리스트
   *  기본값만 본다(오버라이드를 안 나르는 호출자·기존 테스트 호환). */
  mode: PaneAxisMode = defaultAxisMode(group),
): string | null {
  if (group.length <= 1) return null;
  if (group[0] === member) return null;
  if (mode === 'shared') return null;
  if (mode === 'left' && group[1] === member && originalId !== '') return 'left';
  return `merged:${member}:${originalId}`;
}
