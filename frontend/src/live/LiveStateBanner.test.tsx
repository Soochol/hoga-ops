import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LiveStateBanner } from './LiveStateBanner';

// 액션이 라우트 링크가 아니라 **드로어 열기 요청**이 되면서 모킹 대상도 라우터에서
// 명령 채널로 옮겨왔다(`/settings` 페이지 삭제). MemoryRouter 도 함께 사라졌다 —
// 이 컴포넌트에는 더 이상 `<Link>` 가 없다.
const { requestSettingsModal } = vi.hoisted(() => ({ requestSettingsModal: vi.fn() }));
vi.mock('./settingsModalControls', () => ({ requestSettingsModal }));

describe('LiveStateBanner', () => {
  beforeEach(() => {
    requestSettingsModal.mockClear();
  });

  it('renders nothing when primary is null and stack is empty', () => {
    const { container } = render(<LiveStateBanner primary={null} stack={[]} />);
    expect(container.querySelector('[data-testid="live-state-banner"]')).toBeNull();
  });

  // credentials_missing 행 테스트는 그 배너가 도달 불가 판정으로 제거되며 같이 내렸다.
  // 액션 렌더는 아래 realtime_unavailable 케이스가 그대로 덮는다.

  it('renders stacked kis_token_expired banner without action', () => {
    render(<LiveStateBanner primary={null} stack={['kis_token_expired']} />);
    expect(screen.getByText(/토큰이 만료/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '설정' })).toBeNull();
  });

  it('kiwoom_auth_failing 은 **고칠 env 변수명을** 보여 준다', () => {
    // 계정 번호(5)를 그대로 보이면 사용자가 `KIWOOM_APP_KEY_5` 를 찾는데 그건 다른
    // 키다 — account 5 ↔ `KIWOOM_APP_KEY_6`. 이름은 백엔드가 실어 보낸다.
    render(
      <LiveStateBanner
        primary={null}
        stack={['kiwoom_auth_failing']}
        details={{ kiwoom_auth_failing: 'KIWOOM_APP_KEY_6' }}
      />,
    );

    expect(screen.getByText(/KIWOOM_APP_KEY_6/)).toBeInTheDocument();
    expect(screen.queryByText(/계정 5/)).toBeNull();
  });

  it('detail 이 없으면 제목만 — 꼬리말이 빈 괄호로 남지 않는다', () => {
    render(<LiveStateBanner primary={null} stack={['kiwoom_auth_failing']} />);
    expect(screen.getByText('키움 앱키 인증 실패 — 과거 데이터 조회가 막힙니다')).toBeInTheDocument();
  });

  it('shows realtime_unavailable banner with a settings action (F2)', () => {
    render(<LiveStateBanner primary="realtime_unavailable" stack={[]} />);
    expect(screen.getByText(/실시간 미가동/)).toBeInTheDocument();

    // 예전엔 `href="/settings"` 였다. 그 페이지가 사라지면서 복구 동선은 **화면을
    // 떠나지 않는** 드로어 열기가 됐다 — 배너를 보는 채로 설정을 만지게 된다.
    fireEvent.click(screen.getByRole('button', { name: '설정' }));
    expect(requestSettingsModal).toHaveBeenCalledOnce();
  });
});
