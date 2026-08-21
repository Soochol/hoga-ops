/**
 * LiveWindowListMenu — /live 툴바의 창 목록 드롭다운 배선.
 *
 * useWorkspaceStore 의 창을 그룹별 섹션으로 정규화해 공용 WindowListMenu 에 넘긴다.
 * /live 는 링크 그룹(#711)이 있어 그룹 헤더 아래 그 그룹의 종목명을 실을 수 있다 —
 * 창 자체는 종목을 모르고 그룹→종목(groupSymbols)이 SSOT 이므로 헤더가 종목을 진다.
 *
 * **고정(핀) 창은 그 규칙의 예외**라 행이 자기 종목을 진다 — 그룹을 안 따르므로 헤더의
 * 종목명이 그 창에 대해 거짓이 된다. 행에 종목을 실어 헤더와 어긋난 것을 눈에 보이게
 * 한다(그게 핀의 정의이므로, 감출 것이 아니라 드러낼 차이다).
 */
import { useMemo } from 'react';
import { WindowListMenu, type WindowListSection } from '../../workspace/WindowListMenu';
import { WINDOW_KIND_LABEL } from './windowKindLabels';
import { WINDOW_KIND_ICON } from './windowKindIcons';
import { useWorkspaceStore, type GroupId } from '../../state/workspace';

export function LiveWindowListMenu() {
  const windows = useWorkspaceStore((s) => s.windows);
  const zOrder = useWorkspaceStore((s) => s.zOrder);
  const groupSymbols = useWorkspaceStore((s) => s.groupSymbols);
  const focusWindow = useWorkspaceStore((s) => s.focusWindow);
  const closeWindow = useWorkspaceStore((s) => s.closeWindow);

  const focusedId = zOrder[zOrder.length - 1];

  const sections = useMemo<WindowListSection[]>(() => {
    // 그룹 오름차순으로 묶는다 — 창 배열의 추가 순서는 그룹 내에서만 보존한다.
    const groups = [...new Set(windows.map((w) => w.group))].sort((a, b) => a - b);
    return groups.map((group) => {
      const sym = groupSymbols[group as GroupId];
      return {
        key: `group-${group}`,
        heading: sym ? `그룹 ${group} · ${sym.name}` : `그룹 ${group}`,
        rows: windows
          .filter((w) => w.group === group)
          .map((w) => ({
            id: w.id,
            label: WINDOW_KIND_LABEL[w.kind],
            ...(w.pinned ? { sublabel: `고정 ${w.pinned.name}` } : {}),
            icon: WINDOW_KIND_ICON[w.kind],
            isFocused: w.id === focusedId,
            closable: true,
          })),
      };
    });
  }, [windows, groupSymbols, focusedId]);

  const groupCount = sections.length;
  const summary = `열린 창 ${windows.length} · 그룹 ${groupCount}`;

  return (
    <WindowListMenu
      testId="live-window-list"
      count={windows.length}
      summary={summary}
      sections={sections}
      onFocus={focusWindow}
      onClose={closeWindow}
    />
  );
}
