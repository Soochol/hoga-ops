import { TrashIcon } from '../ui/TrashIcon';
import { HeatmapContextMenu, type HeatmapMenuItem } from './HeatmapContextMenu';

interface Props {
  x: number;            // raw 커서 viewport 좌표
  y: number;
  name: string;         // 접근성 라벨용
  onRemove: () => void;
  onClose: () => void;
  /** '지난 N일 수집' — 미전달이면 항목이 빠진다. */
  onCollect?: () => void;
}

/**
 * 히트맵 **행**(종목) 우클릭 컨텍스트 메뉴 (히트맵 전용, ADR-0068 G3). 라벨은
 * '히트맵에서 제거'(관심 해제 아님)로 독립 스토어임을 분명히 한다. 제거는 우클릭한
 * **그 그룹 스코프** — 같은 종목이 다른 그룹에도 등록돼 있으면 그쪽은 남는다(ADR-0132).
 *
 * **'그룹으로 이동' 섹션은 없다.** 실폴더를 전부 나열하는 구조라 그룹이 수십 개인 실사용
 * 보드에서 메뉴가 화면을 덮었다(38개 실측). 그룹 간 이동은 드래그앤드롭이 대신한다 —
 * 보드·드로어 모두 다른 그룹 블록에 떨구면 이동, Ctrl 을 누른 채면 복제(ADR-0132).
 */
export function HeatmapRowMenu({ x, y, name, onRemove, onClose, onCollect }: Props) {
  const items: HeatmapMenuItem[] = [
    {
      key: 'remove',
      label: '히트맵에서 제거',
      icon: <TrashIcon className="w-[1em] h-[1em]" />,
      onClick: onRemove,
    },
    ...(onCollect ? [{
      key: 'collect',
      label: '지난 N일 수집',
      icon: <>⬇</>,
      onClick: onCollect,
    }] : []),
  ];
  return (
    <HeatmapContextMenu x={x} y={y} ariaLabel={`${name} 컨텍스트 메뉴`}
      testId="heatmap-row-menu" itemTestIdPrefix="heatmap-menu"
      items={items} onClose={onClose} />
  );
}
