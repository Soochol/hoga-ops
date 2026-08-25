import { createPortal } from 'react-dom';
import type { RefObject } from 'react';
import MovingAverageRow from './MovingAverageRow';
import { useAnchoredPopover } from '../../util/useAnchoredPopover';
import { MA_SLICE_LABEL, type MaSliceKey } from '../../state/indicatorOps';
import type { LiveMAConfig } from '../../state/livePage';

/** 팝오버 폭 — `MovingAverageRow` 의 5열 그리드(56 + 픽커 + 소스 + 72 + 24)가 줄바꿈
 *  없이 들어가는 최소치에 여유를 둔 값. `useAnchoredPopover` 가 이 숫자를 오른쪽
 *  정렬 기준이자 실제 `width` 로 함께 쓰므로 **추정폭과 실제폭이 갈릴 수 없다**. */
const POPOVER_WIDTH = 340;

/**
 * 레전드 칩 더블클릭으로 뜨는 **인스턴스 속성 팝오버**.
 *
 * 내용물은 설정 패널의 슬롯 행(`MovingAverageRow`)을 그대로 재사용한다 — 그 컴포넌트가
 * props-only 라(스토어·컨텍스트 의존 0) 모달 밖에서도 그대로 산다. 같은 편집을 두 벌
 * 구현하면 조용히 갈리므로, 재사용이 이 팝오버의 설계 전제다.
 *
 * ⚠ **중첩 팝오버**: 이 안의 `MAStylePicker` 는 자기 팔레트를 다시 body 로 포털한다.
 * 두 레이어가 서로의 서브트리 밖이라, 팔레트를 누르면 이 팝오버가 그것을 "바깥 클릭"
 * 으로 읽고 닫혀 **색을 고를 수 없게 된다**. 그 판정은 `useDismissablePopover` 가
 * 열린 순서로 가른다(그 파일의 `openLayers` 주석) — 여기서 따로 할 일은 없지만,
 * 내용물을 바꿀 때 그 계약을 깨지 않도록 알아 둘 것.
 *
 * ⚠ 앵커(칩)는 pane 래퍼의 `overflow:hidden` 안에 있다. 창을 줄이거나 pane 이 접혀
 * 칩이 가려지면 `useAnchoredPopover` 의 IntersectionObserver 가 **팝오버를 닫는다**.
 * 트리거가 안 보이는데 팝오버만 떠 있는 상태를 막는 계약이고, 여기서도 그게 맞다 —
 * 어느 인스턴스를 편집 중인지 가리키는 것이 칩이기 때문이다.
 */
export default function MaInstancePopover({
  slice,
  config,
  anchorRef,
  onChange,
  onRemove,
  onDismiss,
}: {
  slice: MaSliceKey;
  config: LiveMAConfig;
  /** 더블클릭된 칩 — 앵커이자 dismiss 판정의 "안쪽". */
  anchorRef: RefObject<HTMLElement | null>;
  onChange: (patch: Partial<LiveMAConfig>) => void;
  onRemove: () => void;
  onDismiss: () => void;
}) {
  const { ref, style } = useAnchoredPopover<HTMLDivElement>(
    true, anchorRef, onDismiss, POPOVER_WIDTH,
  );
  const label = `${MA_SLICE_LABEL[slice]} ${config.period}`;

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={`${label} 속성`}
      data-testid="ma-instance-popover"
      style={style}
      className="rounded-lg border border-border bg-bg-card p-3 shadow-lg"
    >
      <div className="pb-1 text-xs font-medium text-fg-dim">{label}</div>
      <MovingAverageRow
        index={0}
        config={config}
        canRemove
        onChange={onChange}
        onRemove={onRemove}
        // 팝오버는 인스턴스 하나만 편집하므로 "기간1" 같은 순번 라벨이 의미가 없다.
        // 라벨을 비우면 설정 패널과 aria-label 이 겹치지도 않는다 — 둘이 동시에 열려
        // 있을 때 `getByRole('spinbutton', { name })` 이 두 개를 잡는 것을 막는다.
        periodLabel="길이"
      />
    </div>,
    document.body,
  );
}
