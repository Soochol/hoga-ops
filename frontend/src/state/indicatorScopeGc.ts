/**
 * 사라진 창의 지표 스코프 회수.
 *
 * 창별 지표 설정은 전역 저장소(`live.indicators.v2` 의 `byWindow`)에 살고 창은 키만
 * 갖는다. 그래서 창이 없어져도 설정은 남는데, 창 id 는 재사용되지 않으므로 그건
 * 영영 닿을 수 없는 쓰레기다.
 *
 * **로드 시 일괄 청소는 하지 않는다.** 워크스페이스 스냅샷과 대조해 "모르는 키" 를
 * 쓸어버리는 방식이 자연스러워 보이지만, 딥링크 탭은 자기 워크스페이스를 공유
 * 저장소에 미러하지 않는다(`workspace.ts` 의 `isDeepLinkTab`). 그 탭이 열려 있는
 * 동안 다른 탭이 스냅샷을 근거로 청소하면 **살아 있는 창**의 설정이 사라진다.
 * 그래서 회수는 고아를 만드는 두 사건에서만, 그 사건이 일어난 탭에서 한다:
 *
 *  - 창 닫기
 *  - 레이아웃 프리셋 적용 (창 id 가 통째로 프리셋 것으로 갈린다)
 *
 * 언마운트를 신호로 쓰지 않는 이유도 같다 — 페이지 이탈·탭 전환에서도 언마운트가
 * 나는데, 그때 설정을 지우면 사용자는 돌아왔을 때 이유 없이 초기화된 창을 본다.
 */
import { windowScopeKey } from '../live/workspace/windowViewContext';
import { useLivePageStore } from './livePage';

/**
 * 주어진 창들의 스코프를 두 스토어에서 회수한다(livePage 가 chartPrefs 를 동반
 * 호출한다 — 멤버십이 한쪽만 남지 않게).
 */
export function dropIndicatorScopesForWindows(
  scopePrefix: 'live' | 'study',
  windowIds: readonly string[],
): void {
  if (windowIds.length === 0) return;
  const scopeKeys = windowIds
    .map((id) => windowScopeKey({ scopePrefix }, id))
    .filter((key): key is string => key !== null);
  useLivePageStore.getState().dropWindowIndicatorScopes(scopeKeys);
}

/** 스냅샷 교체처럼 창 집합이 통째로 갈리는 경로용 — 사라진 id 만 골라 회수한다. */
export function dropIndicatorScopesForRemovedWindows(
  scopePrefix: 'live' | 'study',
  before: readonly { id: string }[],
  after: readonly { id: string }[],
): void {
  const surviving = new Set(after.map((w) => w.id));
  dropIndicatorScopesForWindows(
    scopePrefix,
    before.map((w) => w.id).filter((id) => !surviving.has(id)),
  );
}
