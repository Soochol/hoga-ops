import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WindowFrame } from './WindowFrame';

/** 프레임 크롬만 보므로 종목 없는 데이터 창으로 렌더한다 — 차트 창은 `symbolCode` 가
 *  있으면 TitleBarSymbolRow(react-query 구독)를 그려 QueryClient 를 요구한다
 *  (WindowFrame.test.tsx 와 같은 규율). */
function renderFrame(props: Partial<React.ComponentProps<typeof WindowFrame>> = {}) {
  const onTogglePin = vi.fn();
  render(
    <WindowFrame
      id="w1"
      kind="book"
      group={1}
      rect={{ x: 0, y: 0, w: 320, h: 240 }}
      zIndex={1}
      focused={false}
      symbolLabel="삼성전자"
      symbolCode="005930"
      paletteOpen={false}
      onHandleDown={vi.fn()}
      onFocus={vi.fn()}
      onClose={vi.fn()}
      onTogglePalette={vi.fn()}
      onPickGroup={vi.fn()}
      onTogglePin={onTogglePin}
      {...props}
    >
      <div />
    </WindowFrame>,
  );
  return { onTogglePin, pin: screen.getByTestId('window-pin-toggle') };
}

describe('창 헤더 고정(핀) 버튼', () => {
  it('상태를 aria-pressed 로 노출한다 — 색만으로 켜짐을 말하지 않는다', () => {
    expect(renderFrame({ pinned: false }).pin).toHaveAttribute('aria-pressed', 'false');
  });

  it('고정된 창은 aria-pressed=true', () => {
    expect(renderFrame({ pinned: true }).pin).toHaveAttribute('aria-pressed', 'true');
  });

  it('누르면 창 id 로 토글을 요청한다', async () => {
    const { onTogglePin, pin } = renderFrame({ pinned: false });
    await userEvent.click(pin);
    expect(onTogglePin).toHaveBeenCalledWith('w1');
  });

  it('고정할 종목이 없으면 비활성 — 스토어 가드와 같은 술어를 UI 에도 세운다', async () => {
    // 비활성이 아니면 "눌렀는데 아무 일도 안 남" 이 된다(스토어가 조용히 거절한다).
    const { onTogglePin, pin } = renderFrame({ canPin: false });
    expect(pin).toBeDisabled();
    await userEvent.click(pin);
    expect(onTogglePin).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    '스코프를 창으로 못박는 툴팁(pinned=%s) — 그룹 뱃지 옆이라 그룹 단위로 오해되기 쉽다',
    (pinned) => {
      // 한 it 안에서 renderFrame 을 두 번 부르면 자동 cleanup 이 안 돌아 testId 가
      // 두 개가 된다(getByTestId 가 "multiple elements" 로 실패). 케이스를 나눈다.
      expect(renderFrame({ pinned }).pin.getAttribute('title')).toContain('이 창');
    },
  );

  it('onTogglePin 을 안 넘기면 버튼 자체가 없다(/study 등 핀 없는 호출부)', () => {
    render(
      <WindowFrame
        id="w1"
        kind="book"
        group={1}
        rect={{ x: 0, y: 0, w: 320, h: 240 }}
        zIndex={1}
        focused={false}
        symbolLabel="삼성전자"
        symbolCode="005930"
        paletteOpen={false}
        onHandleDown={vi.fn()}
        onFocus={vi.fn()}
        onClose={vi.fn()}
        onTogglePalette={vi.fn()}
        onPickGroup={vi.fn()}
      >
        <div />
      </WindowFrame>,
    );
    expect(screen.queryByTestId('window-pin-toggle')).toBeNull();
  });
});
