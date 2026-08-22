import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import MAStylePicker, { MA_COLOR_ROWS } from './MAStylePicker';

describe('MAStylePicker', () => {
  it('renders trigger with color dot + line-width preview reflecting props', () => {
    render(<MAStylePicker color="#EC4899" lineWidth={3} onChange={() => {}} />);
    const trigger = screen.getByRole('button', { name: 'MA 스타일 선택' });
    // Trigger has three aria-hidden spans (dot + line + ⌄ open-affordance).
    // Dot and line are painted with the current color; the line's height = lineWidth.
    const previews = trigger.querySelectorAll('span[aria-hidden="true"]');
    expect(previews).toHaveLength(3);
    expect(previews[2].textContent).toBe('⌄');
    // Dot uses backgroundColor; the line preview uses border-top (so it can
    // reflect solid/dashed/dotted) with width = lineWidth.
    expect((previews[0] as HTMLElement).style.backgroundColor).toMatch(/236.*72.*153|#ec4899/i);
    expect((previews[1] as HTMLElement).style.borderTopColor).toMatch(/236.*72.*153|#ec4899/i);
    expect((previews[1] as HTMLElement).style.borderTopWidth).toBe('3px');
  });

  it('renders 모양(line-style) section only when lineStyle + onLineStyleChange given', () => {
    const onLineStyleChange = vi.fn();
    const { rerender } = render(<MAStylePicker color="#EC4899" lineWidth={1} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'MA 스타일 선택' }));
    // Absent by default (기존 호출부 불변).
    expect(screen.queryAllByRole('button', { name: /^MA 모양 / })).toHaveLength(0);
    rerender(
      <MAStylePicker
        color="#EC4899"
        lineWidth={1}
        lineStyle="dashed"
        onChange={() => {}}
        onLineStyleChange={onLineStyleChange}
      />,
    );
    const styleButtons = screen.getAllByRole('button', { name: /^MA 모양 / });
    expect(styleButtons).toHaveLength(3);
    expect(
      screen.getByRole('button', { name: 'MA 모양 파선' }).getAttribute('aria-pressed'),
    ).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'MA 모양 점선' }));
    expect(onLineStyleChange).toHaveBeenCalledWith('dotted');
  });

  it('opens combined palette+width popover on click', () => {
    render(<MAStylePicker color="#EC4899" lineWidth={1} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'MA 스타일 선택' }));
    const colorButtons = screen.getAllByRole('button', { name: /^MA 색상 / });
    const widthButtons = screen.getAllByRole('button', { name: /^MA 굵기 / });
    expect(colorButtons).toHaveLength(32);
    expect(widthButtons).toHaveLength(4);
  });

  it('emits {color} and closes popover when a swatch is picked', () => {
    const onChange = vi.fn();
    render(<MAStylePicker color="#EC4899" lineWidth={1} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'MA 스타일 선택' }));
    const target = MA_COLOR_ROWS[2][3];
    const swatch = screen.getByRole('button', { name: `MA 색상 ${target}` });
    fireEvent.click(swatch);
    expect(onChange).toHaveBeenCalledWith({ color: target });
    expect(screen.queryAllByRole('button', { name: /^MA 색상 / })).toHaveLength(0);
  });

  it('emits {lineWidth} when a width card is picked, keeps popover open', () => {
    const onChange = vi.fn();
    render(<MAStylePicker color="#EC4899" lineWidth={1} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'MA 스타일 선택' }));
    const w3 = screen.getByRole('button', { name: 'MA 굵기 3px' });
    fireEvent.click(w3);
    expect(onChange).toHaveBeenCalledWith({ lineWidth: 3 });
    expect(screen.getAllByRole('button', { name: /^MA 굵기 / })).toHaveLength(4);
  });

  it('marks the current color and width as selected via aria-pressed', () => {
    render(<MAStylePicker color="#A855F7" lineWidth={2} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'MA 스타일 선택' }));
    expect(
      screen.getByRole('button', { name: 'MA 색상 #A855F7' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen.getByRole('button', { name: 'MA 굵기 2px' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('exports a 4x8 grid of 32 distinct colors', () => {
    expect(MA_COLOR_ROWS).toHaveLength(4);
    for (const row of MA_COLOR_ROWS) {
      expect(row).toHaveLength(8);
    }
    const flat = MA_COLOR_ROWS.flat();
    expect(new Set(flat).size).toBe(flat.length);
  });

  // ── 클리핑 탈출(2026-08-22). 설정 모달은 셸의 overflow-hidden 과 상세 section 의
  //    overflow-y-auto 로 감싸여 있어 absolute 팝오버가 카드 오른쪽에서 잘렸다.
  //    아래 두 건이 "포털로 나갔다" 와 "나가고도 조작할 수 있다" 를 각각 잰다.
  //    **막는 방향**: 팝오버를 다시 앵커 서브트리 안 absolute 로 되돌리면 첫 건이,
  //    포털만 하고 레이어 ref 를 dismiss 계약에 안 넘기면 둘째 건이 빨개진다.
  //    **못 보는 것**: jsdom 은 레이아웃을 안 하므로 실제 픽셀 잘림은 여기서 못 잰다
  //    (그건 /browse 도그푸딩 몫). 여기서 재는 건 DOM 위치와 조작 가능성이다.
  it('팝오버를 body 로 포털해 조상 overflow 밖으로 내보낸다', () => {
    const { container } = render(
      // 실제 설정 모달과 같은 형상 — 잘라내는 조상 안에 픽커를 둔다.
      <div style={{ overflow: 'hidden' }} data-testid="clipper">
        <MAStylePicker color="#EC4899" lineWidth={1} onChange={() => {}} />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'MA 스타일 선택' }));
    const popover = screen.getByRole('dialog', { name: 'MA 스타일 팔레트' });
    expect(popover.parentElement).toBe(document.body);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    // fixed 여야 조상 스크롤 컨테이너가 아니라 뷰포트를 기준으로 눕는다.
    expect(popover.style.position).toBe('fixed');
    // 그리고 모달 크롬(ModalShell 은 z-[60])보다 위여야 한다. 포털된 팝오버는 모달의
    // **형제**라 z 를 안 주면 뒤에 깔리는데, 좌표는 멀쩡해서 rect 검사가 전부
    // 통과한다 — 실측에서 한 번 놓쳤다(fullyVisible:true 인데 화면엔 없었다).
    expect(Number(popover.style.zIndex)).toBeGreaterThan(60);
  });

  it('열리면 팝오버 안으로 포커스를 옮긴다 — 포털이라 Tab 이 닿지 않는다', () => {
    // ModalShell 의 Tab trap 은 카드 안 포커서블만 순환한다. 포털된 팝오버는 그
    // 밖이라 명시적으로 포커스를 넣지 않으면 키보드로는 팔레트에 **도달할 수 없다**.
    // 막는 방향: 포커스 이동을 지우면 activeElement 가 트리거에 남아 빨개진다.
    render(<MAStylePicker color={MA_COLOR_ROWS[2][3]} lineWidth={1} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'MA 스타일 선택' }));
    const popover = screen.getByRole('dialog', { name: 'MA 스타일 팔레트' });
    expect(popover.contains(document.activeElement)).toBe(true);
    // 현재 값에서 시작한다 — 골라져 있는 것이 포커스 링으로도 읽힌다.
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: `MA 색상 ${MA_COLOR_ROWS[2][3]}` }),
    );
  });

  it('팝오버 내부 mousedown 은 팝오버를 닫지 않는다', () => {
    const onChange = vi.fn();
    render(<MAStylePicker color="#EC4899" lineWidth={1} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'MA 스타일 선택' }));

    // 포털 후 팝오버는 앵커 서브트리 밖이다 — dismiss 계약이 레이어를 모르면
    // 이 mousedown 이 "바깥" 으로 잡혀 닫히고, 이어질 click 은 영영 오지 않는다.
    // (fireEvent.click 은 mousedown 을 안 쏘므로 위쪽 선택 테스트들은 그 버그를
    //  안고도 전부 초록이다. 이 한 줄만이 그 차이를 본다.)
    const swatch = screen.getByRole('button', { name: 'MA 굵기 3px' });
    fireEvent.mouseDown(swatch);
    expect(screen.getByRole('dialog', { name: 'MA 스타일 팔레트' })).toBeTruthy();

    fireEvent.click(swatch);
    expect(onChange).toHaveBeenCalledWith({ lineWidth: 3 });
  });

  it('팝오버·트리거 바깥 mousedown 은 닫는다', () => {
    render(
      <div>
        <MAStylePicker color="#EC4899" lineWidth={1} onChange={() => {}} />
        <button data-testid="바깥">바깥</button>
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'MA 스타일 선택' }));
    fireEvent.mouseDown(screen.getByTestId('바깥'));
    expect(screen.queryByRole('dialog', { name: 'MA 스타일 팔레트' })).toBeNull();
  });

  // 스크롤 정책. 처음엔 "스크롤하면 닫는다" 로 만들었다가 /browse 실측에서 뒤집혔다 —
  // 부분적으로만 보이는 트리거를 누르면 브라우저 포커스 스크롤이 따라붙어 팝오버가
  // **열자마자 닫혔다**. 이제 앵커를 다시 읽어 따라가고, 트리거가 뷰포트 밖으로
  // 완전히 나갔을 때만 닫는다. 아래 두 건이 그 두 갈래를 각각 고정한다.
  it('스크롤해도 팝오버는 열린 채 앵커를 따라간다', () => {
    render(<MAStylePicker color="#EC4899" lineWidth={1} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'MA 스타일 선택' }));
    fireEvent.scroll(window);
    expect(screen.getByRole('dialog', { name: 'MA 스타일 팔레트' })).toBeTruthy();
  });

  it('트리거가 보이지 않게 되면 닫는다 (IntersectionObserver)', () => {
    // jsdom 에는 IntersectionObserver 가 없다 — 훅이 브라우저에서 타는 바로 그 경로를
    // 재려고 스텁을 세워 콜백을 손에 쥔다(폴백 경로를 만들지 않은 이유가 이것이다).
    // 막는 방향: 훅이 IO 구독을 잃거나 isIntersecting 판정을 뒤집으면 빨개진다.
    let notify: ((entries: { isIntersecting: boolean }[]) => void) | null = null;
    class FakeIntersectionObserver {
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
        notify = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    try {
      render(<MAStylePicker color="#EC4899" lineWidth={1} onChange={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: 'MA 스타일 선택' }));
      expect(notify).not.toBeNull();

      // 아직 보이는 동안은 그대로 열려 있다(반대 방향도 같이 고정 — 항상 닫는
      // 구현이면 여기서 빨개진다).
      act(() => notify!([{ isIntersecting: true }]));
      expect(screen.getByRole('dialog', { name: 'MA 스타일 팔레트' })).toBeTruthy();

      act(() => notify!([{ isIntersecting: false }]));
      expect(screen.queryByRole('dialog', { name: 'MA 스타일 팔레트' })).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('label prop으로 aria 문구 일반화', () => {
    render(<MAStylePicker color="#1D4ED8" lineWidth={2} onChange={() => {}} label="매도벽" />);
    expect(screen.getByRole('button', { name: '매도벽 스타일 선택' })).toBeTruthy();
  });
});
