import { realMsToYyyymmdd } from '../live/liveDateTime';
import { unixMsToKSTClock } from '../util/time';
import type { ReviewCandleSection, ReviewCaptureContext, ReviewCaptureData } from './reviewCaptureTypes';

/** Resolve tokens once at the click, so every snapshot uses the same appearance. */
export function reviewCapturePalette(surface: HTMLElement) {
  const style = getComputedStyle(surface);
  const color = (name: string) => style.getPropertyValue(name).trim();
  return { bg: color('--bg-card'), fg: color('--fg'), dim: color('--fg-dim'), grid: color('--grid'),
    up: color('--price-up'), down: color('--price-down'), accent: color('--accent'), font: style.fontFamily };
}
type Palette = ReturnType<typeof reviewCapturePalette>;

function canvasImage(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob)
    : reject(new Error('복기 이미지 생성에 실패했습니다')), 'image/png'));
}

function surface(height: number, palette: Palette, title: string, subtitle: string, width = 1200) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('이미지 캔버스를 만들지 못했습니다');
  ctx.fillStyle = palette.bg; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = palette.fg; ctx.font = `500 24px ${palette.font}`;
  ctx.fillText(title, 24, 36, width - 48);
  ctx.fillStyle = palette.dim; ctx.font = `18px ${palette.font}`;
  ctx.fillText(subtitle, 24, 65, width - 48);
  return { canvas, ctx };
}

export function captureStamp(at: number): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(at)) + ' KST';
}

export function renderReviewCandles(section: ReviewCandleSection, title: string, subtitle: string,
  palette: Palette, context: ReviewCaptureContext, daily = false): Promise<Blob> {
  const height = daily ? 420 : 300;
  const { canvas, ctx } = surface(height, palette, title, subtitle, 1200);
  const rows = section.candles;
  if (!rows.length) {
    ctx.fillStyle = palette.dim; ctx.fillText(section.message || '자료 없음', 24, 150, 1152);
    return canvasImage(canvas);
  }
  const left = 24, right = 1090, top = 98;
  const bottom = height - (section.message ? 56 : 30);
  const priceBottom = daily ? bottom - 70 : bottom - 25;
  const lo = Math.min(...rows.map(row => row.low)), hi = Math.max(...rows.map(row => row.high));
  const pad = Math.max((hi - lo) * 0.12, hi * 0.002);
  const y = (value: number) => top + (hi + pad - value) / (hi - lo + pad * 2) * (priceBottom - top);
  const date = realMsToYyyymmdd(rows[0].t_ms);
  const midnight = new Date(`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6)}T00:00:00+09:00`).getTime();
  const startMs = Math.min(midnight + 9 * 3600000, rows[0].t_ms);
  const endMs = Math.max(midnight + 15.5 * 3600000, rows.at(-1)!.t_ms);
  const step = (right - left) / (daily ? rows.length : Math.max(1, (endMs - startMs) / 300000 + 1));
  const x = (index: number) => daily ? left + step * (index + 0.5)
    : left + step / 2 + (rows[index].t_ms - startMs) / (endMs - startMs) * (right - left - step);
  ctx.font = `18px ${palette.font}`;
  for (let i = 0; i < 4; i++) {
    const value = hi + pad - (hi - lo + pad * 2) * i / 3;
    const yy = y(value);
    ctx.strokeStyle = palette.grid; ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(right, yy); ctx.stroke();
    ctx.fillStyle = palette.dim;
    ctx.fillText(value.toLocaleString('ko-KR', { maximumFractionDigits: daily ? 0 : 2 }), right + 12, yy + 6, 85);
  }
  if (daily) {
    ctx.fillStyle = palette.accent; ctx.globalAlpha = 0.12;
    rows.forEach((row, i) => { if (context.dates.includes(realMsToYyyymmdd(row.t_ms))) ctx.fillRect(x(i) - step / 2, top, step, bottom - top - 20); });
    ctx.globalAlpha = 1;
  }
  const maxVolume = Math.max(1, ...rows.map(row => row.volume));
  rows.forEach((row, i) => {
    const color = row.close >= row.open ? palette.up : palette.down;
    const width = Math.max(1, Math.min(12, step * 0.65));
    ctx.fillStyle = color; ctx.strokeStyle = color;
    ctx.beginPath(); ctx.moveTo(x(i), y(row.high)); ctx.lineTo(x(i), y(row.low)); ctx.stroke();
    ctx.fillRect(x(i) - width / 2, Math.min(y(row.open), y(row.close)), width, Math.max(1, Math.abs(y(row.open) - y(row.close))));
    if (daily) {
      const volumeHeight = row.volume / maxVolume * 42;
      ctx.globalAlpha = 0.6; ctx.fillRect(x(i) - width / 2, bottom - 24 - volumeHeight, width, volumeHeight); ctx.globalAlpha = 1;
    }
  });
  ctx.fillStyle = palette.dim;
  for (let i = 0; i < 4; i++) {
    const at = Math.round((rows.length - 1) * i / 3);
    const xx = daily ? x(at) : left + (right - left) * i / 3;
    const day = realMsToYyyymmdd(rows[at].t_ms);
    const label = daily ? `${day.slice(4,6)}.${day.slice(6)}` : unixMsToKSTClock(startMs + (endMs - startMs) * i / 3).slice(0, 5);
    ctx.textAlign = i === 0 ? 'left' : i === 3 ? 'right' : 'center';
    ctx.fillText(label, xx, bottom, 120);
  }
  ctx.textAlign = 'left';
  if (section.message) { ctx.fillStyle = palette.dim; ctx.fillText(section.message, 24, height - 16, 1152); }
  return canvasImage(canvas);
}

export function renderReviewFlow(flow: ReviewCaptureData['flow'], date: string, stamp: string, palette: Palette): Promise<Blob> {
  const { canvas, ctx } = surface(320, palette, '외인·기관·개인 순매수', `${date} · 당일 누적 · 억원 · 캡처 ${stamp}`);
  const columns = [24, 560, 1000];
  ctx.font = `20px ${palette.font}`; ctx.fillStyle = palette.dim;
  ctx.fillText('투자자', columns[0], 108); ctx.fillText('코스피', columns[1], 108); ctx.fillText('코스닥', columns[2], 108);
  const actors = [['외인', 'foreign'], ['기관', 'institution'], ['개인', 'individual']] as const;
  actors.forEach(([label, key], index) => {
    const yy = 154 + index * 44;
    ctx.fillStyle = palette.fg; ctx.fillText(label, columns[0], yy);
    (['KOSPI', 'KOSDAQ'] as const).forEach((market, i) => {
      const value = flow.markets[market][key];
      ctx.fillStyle = value === null || value === 0 ? palette.fg : value > 0 ? palette.up : palette.down;
      ctx.fillText(value === null ? '미제공' : `${value > 0 ? '+' : ''}${value.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}`, columns[i + 1], yy);
    });
    ctx.strokeStyle = palette.grid; ctx.beginPath(); ctx.moveTo(24, yy + 12); ctx.lineTo(1176, yy + 12); ctx.stroke();
  });
  ctx.fillStyle = palette.dim; ctx.font = `18px ${palette.font}`;
  ctx.fillText(`코스피 ${flow.markets.KOSPI.basis} · 코스닥 ${flow.markets.KOSDAQ.basis}${flow.message ? ` · ${flow.message}` : ''}`, 24, 296, 1152);
  return canvasImage(canvas);
}

/** Preserve the original minute capture resolution while adding a readable source header. */
export async function labelReviewMinute(blob: Blob, title: string, subtitle: string, palette: Palette): Promise<Blob> {
  const image = await createImageBitmap(blob);
  try {
    const scale = Math.max(1, image.width / 1200);
    const header = Math.round(86 * scale);
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height + header;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('분봉 이미지 생성에 실패했습니다');
    ctx.fillStyle = palette.bg; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = palette.fg; ctx.font = `500 ${24 * scale}px ${palette.font}`;
    ctx.fillText(title, 24 * scale, 36 * scale, canvas.width - 48 * scale);
    ctx.fillStyle = palette.dim; ctx.font = `${18 * scale}px ${palette.font}`;
    ctx.fillText(subtitle, 24 * scale, 65 * scale, canvas.width - 48 * scale);
    ctx.drawImage(image, 0, header);
    return await canvasImage(canvas);
  } finally { image.close(); }
}
