/**
 * 창 지표 스코프의 **시드와 회수** (ADR-0152).
 *
 * 창별 지표 설정은 전역 저장소(`live.indicators.v2` 의 `byWindow`)에 살고 창은 키만
 * 갖는다. 그래서 두 방향의 손질이 필요하다:
 *
 *  - **시드** — 창이 생기면 자기 세트를 심는다. 안 심으면 그 창은 페이지 세트를
 *    공유해, 이 기능이 조용히 절반만 동작한다.
 *  - **회수** — 창이 사라져도 설정은 남는데, 창 id 는 재사용되지 않으므로 그건
 *    영영 닿을 수 없는 쓰레기다.
 *
 * **로드 시 일괄 청소는 하지 않는다.** 워크스페이스 스냅샷과 대조해 "모르는 키" 를
 * 쓸어버리는 방식이 자연스러워 보이지만, 딥링크 탭은 자기 워크스페이스를 공유
 * 저장소에 미러하지 않는다(`workspace.ts` 의 `isDeepLinkTab`). 그 탭이 열려 있는
 * 동안 다른 탭이 스냅샷을 근거로 청소하면 **살아 있는 창**의 설정이 사라진다.
 * 그래서 회수는 고아를 만드는 두 사건에서만, 그 사건이 일어난 탭에서 한다:
 *
 *  - 창 닫기
 *  - 워크스페이스 스냅샷 교체 (레이아웃 프리셋 적용 — 창 id 가 통째로 갈린다)
 *
 * 언마운트를 신호로 쓰지 않는 이유도 같다 — 페이지 이탈·탭 전환에서도 언마운트가
 * 나는데, 그때 설정을 지우면 사용자는 돌아왔을 때 이유 없이 초기화된 창을 본다.
 *
 * ⚠ **크로스탭 회수 과잉은 감수한 트레이드오프다.** 워크스페이스는 탭별이지만 공유
 * 시드에서 복제되므로 두 탭이 같은 창 id 를 가질 수 있고, 그때 탭 A 에서 그 창을
 * 닫으면 전역 `byWindow` 에서 회수되어 **탭 B 의 같은 창이 페이지 세트로 되붙는다.**
 * "워크스페이스는 탭별, 스코프 키는 전역" 이라는 모델에 내재한 비대칭이고, 회수를
 * 포기하면 대신 영구 누수가 남는다. 스코프 키에 탭 식별자를 넣으면 이번엔 새 탭에서
 * 창별 구성이 재현되지 않아 #712 의 증상으로 되돌아간다.
 */
import { windowScopeKey } from '../live/workspace/windowViewContext';
import { useLivePageStore } from './livePage';

/**
 * 새 창에 자기 지표 세트를 심는다.
 *
 * `sourceWindowId` 는 **복사 원본**이다 — 새 창 추가에서는 포커스 차트 창을 주어
 * "지금 보던 것과 같은 지표로 열림"을 만든다(ADR-0152 의 시드 규칙 ①). null 이거나
 * 그 창에 엔트리가 없으면 앱 세트에서 복사한다(②).
 *
 * 시드는 멱등이라 이미 있는 창에는 아무 일도 하지 않는다 — 창 컴포넌트의 마운트
 * 안전망(`useSeedWindowIndicatorScope`)이 같은 창에 대해 다시 부를 수 있다.
 */
export function seedIndicatorScopeForWindow(
  windowId: string,
  sourceWindowId: string | null,
): void {
  const windowKey = windowScopeKey(windowId);
  if (!windowKey) return;
  useLivePageStore.getState().seedWindowIndicatorScope(
    { windowKey },
    windowScopeKey(sourceWindowId),
  );
}

/**
 * 주어진 창들의 스코프를 회수한다 — `livePage` 가 `chartPrefs` 를
 * 동반 호출하므로(멤버십이 한쪽만 남지 않게) 여기서는 SSOT 만 부른다.
 */
export function dropIndicatorScopesForWindows(windowIds: readonly string[]): void {
  if (windowIds.length === 0) return;
  const scopeKeys = windowIds
    .map((id) => windowScopeKey(id))
    .filter((key): key is string => key !== null);
  useLivePageStore.getState().dropWindowIndicatorScopes(scopeKeys);
}

/** 스냅샷 교체처럼 창 집합이 통째로 갈리는 경로용 — 사라진 id 만 골라 회수한다.
 *  프리셋 payload 가 **같은 id 를 담고 있으면**(그 배치를 저장한 그 세션의 창들)
 *  살아남아야 하므로 전량 폐기가 아니다. */
export function dropIndicatorScopesForRemovedWindows(
  before: readonly { id: string }[],
  after: readonly { id: string }[],
): void {
  const surviving = new Set(after.map((w) => w.id));
  dropIndicatorScopesForWindows(before.map((w) => w.id).filter((id) => !surviving.has(id)));
}
