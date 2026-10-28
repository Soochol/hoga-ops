import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import DesktopSection from './DesktopSection';
import type { DesktopControls } from '../../desktop';
afterEach(() => { delete window.hogaDesktop; });
it('uses desktop controls, follows zoom events and releases its subscription', async () => {
  let notify!: (factor: number) => void;
  const unsubscribe = vi.fn();
  const controls: DesktopControls = {
    getState: vi.fn().mockResolvedValue({ serverName: '로컬', origin: 'http://localhost:8000', apiOrigin: 'http://localhost:8000', zoomFactor: 1 }),
    selectServer: vi.fn().mockResolvedValue(undefined), newWindow: vi.fn().mockRejectedValue(new Error('closed')),
    zoom: vi.fn().mockResolvedValue(1.1), onZoomChange: vi.fn(callback => { notify = callback; return unsubscribe; }),
  };
  window.hogaDesktop = { strictConfig: true, apiOrigin: 'http://localhost:8000', controls };
  const view = render(<DesktopSection />);
  await screen.findByText('로컬');
  fireEvent.click(screen.getByRole('button', { name: '서버 선택' }));
  await waitFor(() => expect(controls.selectServer).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.getByRole('button', { name: '새 작업 창' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '화면 배율 확대' }));
  await waitFor(() => expect(screen.getByLabelText('현재 화면 배율')).toHaveTextContent('110%'));
  expect(controls.zoom).toHaveBeenCalledWith('in');
  act(() => notify(.5));
  expect(screen.getByRole('button', { name: '화면 배율 축소' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '새 작업 창' }));
  await screen.findByRole('alert');
  view.unmount(); expect(unsubscribe).toHaveBeenCalledOnce();
});
it('does not show desktop controls in a browser', () => {
  const { container } = render(<DesktopSection />);
  expect(container).toBeEmptyDOMElement();
});
