import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureChartImage, chartImageFilename } from './chartImage';
import { toCanvas } from 'html-to-image';

vi.mock('html-to-image', () => ({ toCanvas: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); document.body.replaceChildren(); });

describe('chart image export', () => {
  it('crops a scrolled chart to the visible viewport and preserves overlays while filtering transient controls', async () => {
    const viewport = document.createElement('div');
    const surface = document.createElement('div');
    surface.dataset.testid = 'live-chart-surface';
    viewport.append(surface);
    document.body.append(viewport);
    Object.defineProperties(viewport, { clientWidth: { value: 400 }, clientHeight: { value: 240 } });
    Object.defineProperties(surface, { offsetWidth: { value: 400 }, offsetHeight: { value: 600 } });
    viewport.scrollTop = 150;
    const source = document.createElement('canvas');
    source.width = 800;
    source.height = 1200;
    vi.mocked(toCanvas).mockResolvedValue(source);
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    const blob = new Blob(['image'], { type: 'image/png' });
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback) {
      expect([this.width, this.height]).toEqual([800, 480]);
      callback(blob);
    });

    expect(await captureChartImage(viewport)).toBe(blob);
    expect(drawImage).toHaveBeenCalledWith(source, 0, 300, 800, 480, 0, 0, 800, 480);
    const filter = vi.mocked(toCanvas).mock.calls[0][1]!.filter!;
    const tooltip = document.createElement('div');
    tooltip.dataset.testid = 'candle-tooltip';
    expect(filter(tooltip)).toBe(false);
    expect(filter(source)).toBe(true);
    expect(filter(surface)).toBe(true);
  });

  it('rejects invisible charts instead of exporting a blank image', async () => {
    await expect(captureChartImage(document.createElement('div'))).rejects.toThrow('not visible');
    expect(toCanvas).not.toHaveBeenCalled();
  });

  it('uses the symbol, timeframe and Korean capture time in filenames', () => {
    expect(chartImageFilename('005930', '5m', Date.UTC(2026, 9, 14, 23, 2, 3)))
      .toBe('chart_005930_5m_20261015_080203.png');
  });
});
