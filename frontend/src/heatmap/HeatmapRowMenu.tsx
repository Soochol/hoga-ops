import { QuoteRowGroupMenu } from '../rightrail/QuoteRowGroupMenu';
import { TrashIcon } from '../ui/TrashIcon';
import type { HeatmapMenuItem } from './HeatmapContextMenu';

interface Props {
  code: string;
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
export function HeatmapRowMenu({ x, y, code, name, onRemove, onClose, onCollect }: Props) {
  const items: HeatmapMenuItem[] = [
    ...(onCollect ? [{
      key: 'collect',
      label: '지난 N일 수집',
      icon: <>⬇</>,
      onClick: onCollect,
    }] : []),
    {
      key: 'remove',
      label: '히트맵에서 제거',
      icon: <TrashIcon className="w-[1em] h-[1em]" />,
      onClick: onRemove,
    },
  ];
  return (
    <QuoteRowGroupMenu code={code} name={name} x={x} y={y} onClose={onClose} testId="heatmap-row-menu">
      <div className="mt-1 border-t border-border pt-1">
        {items.map((item) => (
          <button key={item.key} type="button" role="menuitem" data-testid={`heatmap-menu-${item.key}`}
            onClick={() => { item.onClick(); onClose(); }}
            className="w-full text-left px-3 py-1.5 text-sm text-fg-dim hover:text-fg hover:bg-bg-input-hover flex items-center gap-2">
            <span className="w-4 grid place-items-center">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </div>
    </QuoteRowGroupMenu>
  );
}
