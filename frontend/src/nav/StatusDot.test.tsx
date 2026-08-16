import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import StatusDot from './StatusDot';
import type { AppConfig } from '../config';

const getConfig = vi.hoisted(() => vi.fn<() => Promise<AppConfig>>());

vi.mock('../api/client', () => ({ getConfig }));
vi.mock('../api/useConnectionLiveness', () => ({ useConnectionLiveness: () => true }));

describe('StatusDot', () => {
  it('툴팁이 설정된 백엔드를 가리킨다 — 하드코딩 :8000 이 아니라', async () => {
    // e2e 백엔드(:8765). 리터럴이던 시절 이 뱃지는 :8000 이라고 우겼고,
    // Playwright 스냅샷이 "사용자 dev 서버에 붙었다" 로 읽혔다. 라벨이 사라진 뒤에도
    // **오리진의 출처는 설정**이어야 한다 — 그래서 툴팁으로 같은 계약을 검사한다.
    getConfig.mockResolvedValue({ api_url: 'http://127.0.0.1:8765' });
    render(<StatusDot />);
    expect(await screen.findByTitle('실시간 연결 활성 · http://127.0.0.1:8765')).toBeInTheDocument();
  });

  it('falls back to the document origin when the backend serves the SPA', async () => {
    // ADR-0134 same-origin — jsdom 기본 origin.
    getConfig.mockResolvedValue({ api_url: '' });
    render(<StatusDot />);
    expect(
      await screen.findByTitle(`실시간 연결 활성 · ${window.location.origin}`),
    ).toBeInTheDocument();
  });

  it('renders no origin until the config resolves', () => {
    // 자리를 채우려고 아무 포트나 적는 것이 애초의 버그였다.
    getConfig.mockReturnValue(new Promise(() => {}));
    render(<StatusDot />);
    expect(screen.getByTitle('실시간 연결 활성')).toBeInTheDocument();
  });

  it('점만 렌더하고 텍스트 라벨은 내보내지 않는다', async () => {
    // 옛 `WS · :8765` 텍스트는 제거됐다(상단 바 정리). 점은 남고 정보는 툴팁·
    // aria-label 로 간다 — 스크린리더가 빈 span 을 만나지 않도록 role="img" 를 단다.
    getConfig.mockResolvedValue({ api_url: 'http://127.0.0.1:8765' });
    render(<StatusDot />);

    const dot = await screen.findByTestId('ws-status-dot');
    expect(dot).toHaveTextContent('');
    expect(screen.queryByText(/WS/)).toBeNull();
    expect(screen.getByRole('img', { name: /실시간 연결 활성/ })).toBe(dot);
  });
});
