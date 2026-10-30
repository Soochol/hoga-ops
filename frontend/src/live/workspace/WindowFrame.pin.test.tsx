import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WINDOW_KINDS } from '../../state/workspace';
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
    '고정 상태와 무관하게 헤더 툴팁을 표시하지 않는다(pinned=%s)',
    (pinned) => {
      // 한 it 안에서 renderFrame 을 두 번 부르면 자동 cleanup 이 안 돌아 testId 가
      // 두 개가 된다(getByTestId 가 "multiple elements" 로 실패). 케이스를 나눈다.
      expect(renderFrame({ pinned }).pin).not.toHaveAttribute('title');
    },
  );

  // 실제 정렬·버튼 겹침은 live-window-actions.spec.ts 에서 브라우저로 검증한다.
  it('헤더 오른쪽 ① DOM 순서 — 제목 뒤, 닫기(×) 앞', () => {
    const { pin } = renderFrame({ pinned: false });
    const title = screen.getByText(/삼성전자/);
    const close = screen.getByRole('button', { name: '삼성전자 10호가 창 닫기' });

    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
    // 제목 → 핀 → × 순서. compareDocumentPosition 은 인자가 뒤에 오면 FOLLOWING 을 켠다.
    expect(title.compareDocumentPosition(pin) & FOLLOWING).toBeTruthy();
    expect(pin.compareDocumentPosition(close) & FOLLOWING).toBeTruthy();
  });

  it('그룹 뱃지는 왼쪽에 그대로 남는다 — 핀만 옮겼다', () => {
    const { pin } = renderFrame({ pinned: false });
    const badge = screen.getByRole('button', { name: '링크 그룹 1 변경' });

    expect(badge.compareDocumentPosition(pin) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

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

it.each(WINDOW_KINDS)('%s 항상 위 버튼은 상태와 토글을 제공하며 드래그를 시작하지 않는다', async (kind) => {
  const onToggleAlwaysOnTop = vi.fn();
  const onHandleDown = vi.fn();
  render(<WindowFrame id="w1" kind={kind} group={1} rect={{ x: 0, y: 0, w: 660, h: 215 }}
    zIndex={1} focused={false} symbolLabel={null} symbolCode={null} paletteOpen={false}
    alwaysOnTop onToggleAlwaysOnTop={onToggleAlwaysOnTop} onHandleDown={onHandleDown}
    onToggleMaximize={vi.fn()} onFocus={vi.fn()} onClose={vi.fn()}
    onTogglePalette={vi.fn()} onPickGroup={vi.fn()}><div /></WindowFrame>);
  const button = screen.getByRole('button', { name: '항상 위' });
  expect(button).toHaveAttribute('aria-pressed', 'true');
  expect(button.closest('.live-window-titlebar')!.querySelectorAll('[title]')).toHaveLength(0);
  const maximize = screen.getByRole('button', { name: '창 최대화' });
  expect(maximize.nextElementSibling).toHaveAccessibleName(/창 닫기$/);
  expect(maximize.nextElementSibling!.nextElementSibling).toBeNull();
  await userEvent.click(button);
  expect(onToggleAlwaysOnTop).toHaveBeenCalledWith('w1');
  expect(onHandleDown).not.toHaveBeenCalled();
});
