import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import StatusDot from './StatusDot';
import type { AppConfig } from '../config';

const getConfig = vi.hoisted(() => vi.fn<() => Promise<AppConfig>>());

vi.mock('../api/client', () => ({ getConfig }));
vi.mock('../api/useConnectionLiveness', () => ({ useConnectionLiveness: () => true }));

describe('StatusDot', () => {
  it('shows the port of the configured backend, not a hardcoded :8000', async () => {
    // e2e 백엔드(:8765). 리터럴이던 시절 이 뱃지는 :8000 이라고 우겼고,
    // Playwright 스냅샷이 "사용자 dev 서버에 붙었다" 로 읽혔다.
    getConfig.mockResolvedValue({ api_url: 'http://127.0.0.1:8765' });
    render(<StatusDot />);
    expect(await screen.findByText('WS · :8765')).toBeInTheDocument();
    expect(screen.queryByText(/:8000/)).toBeNull();
  });

  it('falls back to the document origin when the backend serves the SPA', async () => {
    // ADR-0134 same-origin — jsdom 기본 origin 은 http://localhost:3000.
    getConfig.mockResolvedValue({ api_url: '' });
    render(<StatusDot />);
    expect(await screen.findByText(`WS · :${window.location.port}`)).toBeInTheDocument();
  });

  it('renders no origin until the config resolves', () => {
    // 자리를 채우려고 아무 포트나 적는 것이 애초의 버그였다.
    getConfig.mockReturnValue(new Promise(() => {}));
    render(<StatusDot />);
    expect(screen.getByText('WS')).toBeInTheDocument();
  });

  it('puts the full origin in the tooltip alongside the liveness text', async () => {
    getConfig.mockResolvedValue({ api_url: 'https://hoga.example.com' });
    render(<StatusDot />);
    const badge = await screen.findByTitle('실시간 연결 활성 · https://hoga.example.com');
    expect(badge).toHaveTextContent('WS · hoga.example.com');
  });
});
