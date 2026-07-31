import { PencilIcon } from '../ui/PencilIcon';
import { TrashIcon } from '../ui/TrashIcon';
import { HeatmapContextMenu, type HeatmapMenuItem } from './HeatmapContextMenu';

/**
 * 히트맵 **그룹 헤더** 우클릭 컨텍스트 메뉴 — 이름 변경 / 그룹 삭제.
 *
 * 보드 헤더엔 ⋯ 버튼을 두지 않는다: 헤더가 이미 이름 + 당일 흐름 스파크라인 + 평균 등락률
 * + ＋종목으로 빽빽해, 컨트롤을 하나 더 얹으면 밀도가 무너진다(DESIGN.md). 대신 우클릭이
 * 진입점이고 — 방금 행 메뉴에서 쓴 것과 같은 관용구다 — 이름 변경은 **이름 더블클릭**이라는
 * 더 빠른 길도 함께 갖는다. 우클릭 메뉴는 그 더블클릭을 발견 가능하게 만드는 역할도 한다
 * (더블클릭은 화면에 아무 표시가 없다).
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
