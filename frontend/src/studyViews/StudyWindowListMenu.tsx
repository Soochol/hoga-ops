/**
 * StudyWindowListMenu — /study 툴바의 창 목록 드롭다운 배선.
 *
 * /study 는 그룹·종목 개념이 없어(종목은 탭이 SSOT) 평면 목록 한 섹션으로 낸다 —
 * 헤더도, 종목 부라벨도 없다. 유일 차트 창은 불변식상 닫을 수 없으므로(closeWindow
 * 가 거부) 닫기 버튼을 숨긴다.
 */
import { useMemo } from 'react';
import { WindowListMenu, type WindowListSection } from '../workspace/WindowListMenu';
import { requestWorkspaceTidy } from '../workspace/workspaceCanvasControls';
import { WINDOW_KIND_ICON } from '../live/workspace/windowKindIcons';
import { STUDY_WINDOW_LABEL } from './studyWindowMeta';
import { useStudyWorkspaceStore } from '../state/studyWorkspace';

export function StudyWindowListMenu() {
  const windows = useStudyWorkspaceStore((s) => s.windows);
  const zOrder = useStudyWorkspaceStore((s) => s.zOrder);
  const focusWindow = useStudyWorkspaceStore((s) => s.focusWindow);
  const closeWindow = useStudyWorkspaceStore((s) => s.closeWindow);

  const focusedId = zOrder[zOrder.length - 1];

  const sections = useMemo<WindowListSection[]>(
    () => [
      {
        key: 'study-windows',
        rows: windows.map((w) => ({
          id: w.id,
          label: STUDY_WINDOW_LABEL[w.kind],
          icon: WINDOW_KIND_ICON[w.kind],
          isFocused: w.id === focusedId,
          // 유일 차트 창은 닫을 수 없다(차트 1개 불변식) — 닫기 버튼을 숨긴다.
          closable: w.kind !== 'chart',
        })),
      },
    ],
    [windows, focusedId],
  );

  return (
    <WindowListMenu
      testId="study-window-list"
      count={windows.length}
      summary={`열린 창 ${windows.length}`}
      sections={sections}
      onFocus={focusWindow}
      onClose={closeWindow}
      onTidy={requestWorkspaceTidy}
    />
  );
}
