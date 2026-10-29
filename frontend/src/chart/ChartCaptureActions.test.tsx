import { useRef } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChartCaptureActions } from './ChartCaptureActions';
import { captureChartImage, downloadChartImage } from './chartImage';
import { useDrawingsStore } from '../state/drawings';
import { useDrawingToolContextMenuReset } from './drawing/contextMenuReset';

vi.mock('./chartImage', () => ({
  captureChartImage: vi.fn(), downloadChartImage: vi.fn(), chartImageFilename: () => 'chart.png',
}));

function Host({ available = true }: { available?: boolean }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  useDrawingToolContextMenuReset();
  return <div ref={viewportRef} data-testid="chart">
    <div data-testid="overlay" onContextMenu={() => useDrawingsStore.getState().exitDrawingMode()} />
    <ChartCaptureActions viewportRef={viewportRef} code="005930" timeframe="1m" available={available} />
  </div>;
}

const blob = new Blob(['png'], { type: 'image/png' });
const write = vi.fn();
const clipboard = navigator.clipboard;

beforeEach(() => {
  vi.clearAllMocks();
  useDrawingsStore.getState().__resetForTests();
  vi.mocked(captureChartImage).mockResolvedValue(blob);
  write.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write } });
  vi.stubGlobal('ClipboardItem', class {
    data: Record<string, Promise<Blob>>;
    constructor(data: Record<string, Promise<Blob>>) { this.data = data; }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
});

describe('chart toolbar capture actions', () => {
  it('exposes copy and PNG saving as separate icon buttons with accessible names and tooltips', async () => {
    render(<Host />);
    for (const name of ['차트 이미지 복사', 'PNG로 저장']) {
      const button = screen.getByRole('button', { name });
      expect(button.textContent).toBe('');
      expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
      expect(button).not.toHaveAttribute('title');
      fireEvent.pointerEnter(button, { pointerType: 'mouse', buttons: 0 });
      expect(await screen.findByRole('tooltip')).toHaveTextContent(name);
      fireEvent.pointerLeave(button);
    }
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '차트 메뉴' })).not.toBeInTheDocument();
  });

  it('keeps right-click for drawing cancellation without opening an export menu', () => {
    useDrawingsStore.getState().setActiveTool('trendline');
    render(<Host />);
    fireEvent.contextMenu(screen.getByTestId('overlay'));
    expect(useDrawingsStore.getState().activeTool).toBe('select');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.contextMenu(screen.getByTestId('overlay'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '차트 이미지 복사' })).toBeEnabled();
  });

  it('writes the PNG promise to the clipboard during the click and prevents duplicate exports', async () => {
    let resolve!: (value: Blob) => void;
    const pending = new Promise<Blob>(done => { resolve = done; });
    vi.mocked(captureChartImage).mockReturnValue(pending);
    write.mockImplementation(async (items: { data: Record<string, Promise<Blob>> }[]) => {
      await items[0].data['image/png'];
    });
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: '차트 이미지 복사' }));
    expect(write).toHaveBeenCalledTimes(1);
    expect(captureChartImage).toHaveBeenCalledWith(screen.getByTestId('chart'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'PNG로 저장' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '차트 이미지 복사' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '차트 이미지 복사' }));
    await act(async () => resolve(blob));
    expect(await screen.findByText('차트 이미지를 복사했습니다')).toBeInTheDocument();
    expect(captureChartImage).toHaveBeenCalledTimes(1);
  });

  it('offers the already captured PNG when clipboard permission is denied', async () => {
    write.mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: '차트 이미지 복사' }));
    fireEvent.click(within(await screen.findByRole('alert')).getByRole('button', { name: 'PNG로 저장' }));
    expect(downloadChartImage).toHaveBeenCalledWith(blob, 'chart.png');
    expect(captureChartImage).toHaveBeenCalledTimes(1);
  });

  it('shows capture failures without downloading an empty image', async () => {
    vi.mocked(captureChartImage).mockRejectedValue(new Error('Canvas failure'));
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'PNG로 저장' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('차트를 캡처하지 못했습니다');
    expect(downloadChartImage).not.toHaveBeenCalled();
  });

  it('keeps PNG saving available without clipboard support, and disables capture before chart data exists', async () => {
    vi.stubGlobal('ClipboardItem', undefined);
    const { rerender } = render(<Host />);
    expect(screen.getByRole('button', { name: '차트 이미지 복사' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'PNG로 저장' }));
    await waitFor(() => expect(downloadChartImage).toHaveBeenCalledWith(blob, 'chart.png'));
    rerender(<Host available={false} />);
    expect(screen.getByRole('button', { name: 'PNG로 저장' })).toBeDisabled();
  });
});
