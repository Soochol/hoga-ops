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

  it('shows realtime_unavailable banner with a settings action (F2)', () => {
    render(<LiveStateBanner primary="realtime_unavailable" stack={[]} />);
    expect(screen.getByText(/실시간 미가동/)).toBeInTheDocument();

    // 예전엔 `href="/settings"` 였다. 그 페이지가 사라지면서 복구 동선은 **화면을
    // 떠나지 않는** 드로어 열기가 됐다 — 배너를 보는 채로 설정을 만지게 된다.
    fireEvent.click(screen.getByRole('button', { name: '설정' }));
    expect(requestSettingsModal).toHaveBeenCalledOnce();
  });
});
