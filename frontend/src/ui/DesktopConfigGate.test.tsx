import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import DesktopConfigGate from './DesktopConfigGate';
import { loadConfig } from '../config';

afterEach(() => { delete window.hogaDesktop; vi.unstubAllGlobals(); });
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
