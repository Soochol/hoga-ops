/** Capture the chart's canvases and DOM overlays together, then crop to its viewport. */
export async function captureChartImage(viewport: HTMLElement): Promise<Blob> {
  const surface = viewport.querySelector<HTMLElement>('[data-testid="live-chart-surface"]');
  if (!surface || viewport.clientWidth === 0 || viewport.clientHeight === 0) {
    throw new Error('Chart is not visible');
  }
  const { clientWidth: width, clientHeight: height, scrollTop, scrollLeft } = viewport;
  const surfaceWidth = surface.offsetWidth;
  const surfaceHeight = surface.offsetHeight;
  if (!surfaceWidth || !surfaceHeight) throw new Error('Chart surface is not visible');
  const { toCanvas } = await import('html-to-image');
  const image = await toCanvas(surface, {
    width: surfaceWidth,
    height: surfaceHeight,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    backgroundColor: getComputedStyle(viewport).getPropertyValue('--bg-card').trim(),
    filter: node => !(node instanceof Element && node.matches(
      '[data-testid="candle-tooltip"], [data-testid="drawing-property-panel"], '
      + '[data-testid="drawing-multi-selection-panel"], [data-chart-image-exclude]',
    )),
  });
  const scaleX = image.width / surfaceWidth;
  const scaleY = image.height / surfaceHeight;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scaleX);
  canvas.height = Math.round(height * scaleY);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is unavailable');
  context.drawImage(image, scrollLeft * scaleX, scrollTop * scaleY,
    canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG export failed')), 'image/png');
  });
}

export function chartImageFilename(code: string, timeframe: string, now = Date.now()): string {
  const timestamp = new Date(now + 9 * 60 * 60 * 1000).toISOString()
    .slice(0, 19).replace(/[-:]/g, '').replace('T', '_');
  const symbol = code.replace(/[^a-zA-Z0-9가-힣._-]/g, '_');
  return `chart_${symbol}_${timeframe}_${timestamp}.png`;
}

export function downloadChartImage(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Leave the object URL alive until the browser has started the download.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
