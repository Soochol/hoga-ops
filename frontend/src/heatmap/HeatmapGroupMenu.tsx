import { PencilIcon } from '../ui/PencilIcon';
import { TrashIcon } from '../ui/TrashIcon';
import { HeatmapContextMenu, type HeatmapMenuItem } from './HeatmapContextMenu';

/**
 * 히트맵 **그룹 헤더** 우클릭 컨텍스트 메뉴 — 이름 변경 / 그룹 삭제.
 *
 * 헤더의 ⋯ 버튼과 우클릭에서 공유한다. 이름 더블클릭도 유지한다.
 *
 * 그룹 삭제는 파괴적이다(멤버 종목도 함께 삭제, ADR-0112) — confirm 은 호출측이 띄운다.
 */
export function HeatmapGroupMenu({ x, y, name, onRename, onDelete, onClose }: {
  x: number;
  y: number;
  name: string;
  onRename?: () => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const items: HeatmapMenuItem[] = [
    ...(onRename ? [{
      key: 'rename',
      label: '그룹 이름 변경',
      icon: <PencilIcon />,
      onClick: onRename,
    }] : []),
    ...(onDelete ? [{
      key: 'delete',
      label: '그룹 삭제',
      icon: <TrashIcon className="w-[1em] h-[1em]" />,
      onClick: onDelete,
      tone: 'danger' as const,
    }] : []),
  ];
  return (
    <HeatmapContextMenu x={x} y={y} ariaLabel={`${name} 그룹 메뉴`}
      testId="heatmap-group-menu" itemTestIdPrefix="heatmap-group-menu"
      items={items} onClose={onClose} />
  );
}
