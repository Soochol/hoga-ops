/**
 * StudyWindowListMenu — /study 툴바의 창 목록 드롭다운 배선.
 *
 * ADR-0154 이전에는 평면 목록 한 섹션이었다(그룹이 없어 헤더도 부라벨도 없었다).
 * 이제 `/live` `LiveWindowListMenu` 와 **같은 모양**이다 — 그룹 오름차순 섹션에
 * 헤더로 그 그룹의 저장뷰 이름을 싣는다. 창 자체는 저장뷰를 모르고 그룹→저장뷰가
 * SSOT 이므로 헤더가 대상을 지는 것도 그쪽과 같은 근거다.
 *
 * 유일 차트 창은 불변식상 닫을 수 없으므로(closeWindow 가 거부) 닫기 버튼을 숨긴다 —
 * 이건 `/study` 에만 있는 규칙이라 그대로 남는다.
 */
import { useMemo } from 'react';
import { WindowListMenu, type WindowListSection } from '../workspace/WindowListMenu';
import { WINDOW_KIND_ICON } from '../live/workspace/windowKindIcons';
import { STUDY_WINDOW_LABEL } from './studyWindowMeta';
import {
  canCloseStudyWindow,
  useStudyWorkspaceStore,
  type GroupId,
} from '../state/studyWorkspace';

export function StudyWindowListMenu() {
  const windows = useStudyWorkspaceStore((s) => s.windows);
  const zOrder = useStudyWorkspaceStore((s) => s.zOrder);
  const groupViews = useStudyWorkspaceStore((s) => s.groupViews);
  const focusWindow = useStudyWorkspaceStore((s) => s.focusWindow);
  const closeWindow = useStudyWorkspaceStore((s) => s.closeWindow);

  const focusedId = zOrder[zOrder.length - 1];

  const sections = useMemo<WindowListSection[]>(() => {
    // 그룹 오름차순으로 묶는다 — 창 배열의 추가 순서는 그룹 내에서만 보존한다.
    const groups = [...new Set(windows.map((w) => w.group))].sort((a, b) => a - b);
    return groups.map((group) => {
      const view = groupViews[group as GroupId];
      // 헤더는 **종목명 + 저장뷰 이름**이다 — 탭 제목과 같은 조합이라(#1433) 목록에서
      // 고른 것과 탭에 뜨는 것이 같은 문자열로 읽힌다.
      const viewLabel = view ? [view.label || view.code, view.name].filter(Boolean).join(' ') : '';
      return {
        key: `group-${group}`,
        heading: viewLabel ? `그룹 ${group} · ${viewLabel}` : `그룹 ${group}`,
        rows: windows
          .filter((w) => w.group === group)
          .map((w) => ({
            id: w.id,
            label: STUDY_WINDOW_LABEL[w.kind],
            icon: WINDOW_KIND_ICON[w.kind],
            isFocused: w.id === focusedId,
            // 마지막 차트 창은 닫을 수 없다 — 스토어·창 프레임과 같은 술어(#801).
            closable: canCloseStudyWindow(windows, w.id),
          })),
      };
    });
  }, [windows, groupViews, focusedId]);

  return (
    <WindowListMenu
      testId="study-window-list"
      count={windows.length}
      summary={`열린 창 ${windows.length} · 그룹 ${sections.length}`}
      sections={sections}
      onFocus={focusWindow}
      onClose={closeWindow}
    />
  );
}
