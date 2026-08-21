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

  // 오른쪽 배치는 **두 축**이 함께 만든다: JSX 위치(제목 뒤)와 정렬(`ml-auto`).
  // 둘을 한 단언으로 뭉치면 한쪽만 되돌아가도 초록이라, 축마다 따로 잰다
  // (실측: `ml-auto` 만 지웠을 때 DOM 순서 단언은 통과했다).
  it('헤더 오른쪽 ① DOM 순서 — 제목 뒤, 닫기(×) 앞', () => {
    const { pin } = renderFrame({ pinned: false });
    const title = screen.getByText(/삼성전자/);
    const close = screen.getByTitle('창 닫기');

    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
    // 제목 → 핀 → × 순서. compareDocumentPosition 은 인자가 뒤에 오면 FOLLOWING 을 켠다.
    expect(title.compareDocumentPosition(pin) & FOLLOWING).toBeTruthy();
    expect(pin.compareDocumentPosition(close) & FOLLOWING).toBeTruthy();
  });

  it('헤더 오른쪽 ② 정렬 — 바로 앞에 flex-1 스페이서가 여유를 혼자 먹는다', () => {
    // jsdom 은 레이아웃을 안 하므로 실제 x 좌표를 잴 수 없다 — 정렬 **수단**을 잰다.
    // 눈으로 보는 최종 확인은 도그푸딩 실측이 담당한다(이 단언의 한계).
    //
    // **`ml-auto` 가 아니어야 한다**: 코어의 × 도 `ml-auto` 라 둘을 함께 두면 flex 가
    // 여유를 auto 마진들에 균등 분배해 핀이 중간에 뜬다(실측 179px 간격). 그 회귀를
    // 막는 것이 이 단언의 목적이므로 스페이서 **와** ml-auto 부재를 함께 잰다.
    const { pin } = renderFrame({ pinned: false });

    expect(pin.previousElementSibling?.className).toContain('flex-1');
    expect(pin.className).not.toContain('ml-auto');
  });

  it('그룹 뱃지는 왼쪽에 그대로 남는다 — 핀만 옮겼다', () => {
    const { pin } = renderFrame({ pinned: false });
    const badge = screen.getByTitle('링크 그룹 변경');

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
