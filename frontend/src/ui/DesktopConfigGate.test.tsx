import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import DesktopConfigGate from './DesktopConfigGate';
import { __resetConfigForTests } from '../api/client';
import type { DesktopControls } from '../desktop';
import { loadConfig } from '../config';

afterEach(() => { delete window.hogaDesktop; vi.unstubAllGlobals(); __resetConfigForTests(); });
it('desktop bootstrap blocks content on failure and retries without a cached rejection', async () => {
  window.hogaDesktop = { strictConfig: true, apiOrigin: window.location.origin };
  const fetcher = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ ok: true, json: async () => ({ api_url: '' }) });
  vi.stubGlobal('fetch', fetcher);
  render(<DesktopConfigGate><p>workspace-ready</p></DesktopConfigGate>);
  expect(screen.queryByText('workspace-ready')).not.toBeInTheDocument();
  fireEvent.click(await screen.findByRole('button', { name: '다시 시도' }));
  expect(await screen.findByText('workspace-ready')).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('strict config rejects a different API origin', async () => {
  window.hogaDesktop = { strictConfig: true, apiOrigin: 'http://remote:8000' };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ api_url: 'http://localhost:8000' }) }));
  await expect(loadConfig()).rejects.toThrow(/연결 설정/);
});

it('opens server selection when bootstrap fails before the settings shell mounts', async () => {
  const controls: DesktopControls = { getState: vi.fn(), newWindow: vi.fn(), zoom: vi.fn(),
    onZoomChange: vi.fn(), selectServer: vi.fn().mockResolvedValue(undefined) };
  window.hogaDesktop = { strictConfig: true, apiOrigin: window.location.origin, controls };
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  render(<DesktopConfigGate><p>workspace-ready</p></DesktopConfigGate>);
  fireEvent.click(await screen.findByRole('button', { name: '서버 선택' }));
  expect(controls.selectServer).toHaveBeenCalledOnce();
  expect(screen.queryByText('workspace-ready')).not.toBeInTheDocument();
  expect(screen.getByText(/Ctrl\+Alt\+S/)).toBeVisible();
});
