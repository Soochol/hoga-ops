import { arrayMove } from '@dnd-kit/sortable';

/**
 * onDragEnd 재배치 로직(순수). dnd-kit의 active/over id를 받아 새 코드 순서를
 * 돌려준다. 같은 슬롯/리스트 밖/미존재 코드면 null(=뮤테이션 스킵).
 */
export function reorderCodes(
  codes: string[],
  activeId: string,
  overId: string | null | undefined,
): string[] | null {
  if (overId == null || activeId === overId) return null;
  const from = codes.indexOf(activeId);
  const to = codes.indexOf(overId);
  if (from < 0 || to < 0) return null;
  return arrayMove(codes, from, to);
}
