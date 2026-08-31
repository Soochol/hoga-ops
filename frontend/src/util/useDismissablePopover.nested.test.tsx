import { useRef, useState } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { createPortal } from 'react-dom';
import { useDismissablePopover } from './useDismissablePopover';

/**
 * 중첩 팝오버의 dismiss 계약.
 *
 * 팝오버 안에서 또 팝오버가 열리고 **둘 다 body 로 포털되면**, 안쪽 레이어는 바깥
 * 레이어의 서브트리 밖이다. 순진하게 `contains` 만 보면 안쪽을 누르는 순간 바깥이
 * 닫히고, 트리거가 통째로 언마운트돼 `click` 이 영영 오지 않는다 — 사용자는 안쪽
 * 팝오버에서 **아무것도 고를 수 없다**.
 *
 * ⚠ 이 테스트가 `mousedown` 을 직접 쏘는 것이 요점이다. `fireEvent.click` 은
 * mousedown 을 발생시키지 않으므로, 이 버그가 살아 있어도 click 기반 테스트는 전부
 * 초록으로 남는다(`useDismissablePopover` 도크스트링의 경고와 같은 함정).
 */

/** 포털 레이어 + dismiss 계약을 갖는 최소 팝오버. */
function Popover({
  testId, onDismiss, children,
}: { testId: string; onDismiss: () => void; children?: React.ReactNode }) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  useDismissablePopover(true, anchorRef, onDismiss, layerRef);
  return (
    <>
      <button type="button" ref={anchorRef} data-testid={`${testId}-anchor`}>anchor</button>
      {createPortal(
        <div ref={layerRef} data-testid={testId}>{children}</div>,
        document.body,
      )}
    </>
  );
}

function Nested({ outerDismiss, innerDismiss }: {
  outerDismiss: () => void; innerDismiss: () => void;
}) {
  const [innerOpen, setInnerOpen] = useState(false);
  return (
    <Popover testId="outer" onDismiss={outerDismiss}>
      <button type="button" onClick={() => setInnerOpen(true)} data-testid="open-inner">열기</button>
      {innerOpen && (
        <Popover testId="inner" onDismiss={innerDismiss}>
          <button type="button" data-testid="inner-item">고르기</button>
        </Popover>
      )}
    </Popover>
  );
}

describe('useDismissablePopover — 중첩', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  afterEach(cleanup);

  it('안쪽 팝오버의 mousedown 은 바깥을 닫지 않는다', () => {
    const outerDismiss = vi.fn();
    const innerDismiss = vi.fn();
    render(<Nested outerDismiss={outerDismiss} innerDismiss={innerDismiss} />);
    fireEvent.click(screen.getByTestId('open-inner'));

    fireEvent.mouseDown(screen.getByTestId('inner-item'));

    // 바깥이 닫히면 안쪽 트리거가 언마운트돼 선택이 통째로 죽는다.
    expect(outerDismiss).not.toHaveBeenCalled();
    // 안쪽도 자기 레이어 안이므로 닫지 않는다.
    expect(innerDismiss).not.toHaveBeenCalled();
  });

  it('진짜 바깥 mousedown 은 둘 다 닫는다', () => {
    const outerDismiss = vi.fn();
    const innerDismiss = vi.fn();
    render(<Nested outerDismiss={outerDismiss} innerDismiss={innerDismiss} />);
    fireEvent.click(screen.getByTestId('open-inner'));

    fireEvent.mouseDown(document.body);

    expect(outerDismiss).toHaveBeenCalled();
    expect(innerDismiss).toHaveBeenCalled();
  });

  it('바깥 레이어의 mousedown 은 **안쪽만** 닫는다 (중첩은 한 방향이다)', () => {
    const outerDismiss = vi.fn();
    const innerDismiss = vi.fn();
    render(<Nested outerDismiss={outerDismiss} innerDismiss={innerDismiss} />);
    fireEvent.click(screen.getByTestId('open-inner'));

    // 바깥 팝오버의 빈 영역을 누르면 안쪽 팔레트는 닫혀야 한다(그쪽 기준으로는 바깥).
    fireEvent.mouseDown(screen.getByTestId('open-inner'));

    expect(innerDismiss).toHaveBeenCalled();
    expect(outerDismiss).not.toHaveBeenCalled();
  });

  it('닫힌 팝오버의 레이어는 등록에서 빠진다 (스테일 레이어가 남의 dismiss 를 막지 않는다)', () => {
    const outerDismiss = vi.fn();
    const innerDismiss = vi.fn();
    const { unmount } = render(<Nested outerDismiss={outerDismiss} innerDismiss={innerDismiss} />);
    fireEvent.click(screen.getByTestId('open-inner'));
    unmount();

    // 새 팝오버 — 앞선 레이어가 등록에 남아 있으면 이 팝오버가 영영 안 닫힌다.
    const lateDismiss = vi.fn();
    render(<Popover testId="late" onDismiss={lateDismiss} />);
    fireEvent.mouseDown(document.body);
    expect(lateDismiss).toHaveBeenCalled();
  });
});
