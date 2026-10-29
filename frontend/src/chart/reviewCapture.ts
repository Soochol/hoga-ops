import { loadReviewCaptureData } from './reviewCaptureData';
import { captureStamp, labelReviewMinute, renderReviewCandles, renderReviewFlow, reviewCapturePalette } from './reviewCaptureImage';
import type { ReviewCaptureContext } from './reviewCaptureTypes';
import type { ChartAttachment, ChartTransfer } from '../whiteboard/chartTransfer';

export async function createReviewCapture(code: string, timeframe: string, context: ReviewCaptureContext,
  minute: Promise<Blob>, palette: ReturnType<typeof reviewCapturePalette>, capturedAt: number): Promise<ChartTransfer> {
  // Attach a rejection handler immediately; network and the PNG export run independently.
  const [data, minuteBlob] = await Promise.all([loadReviewCaptureData(code, context), minute]);
  const stamp = captureStamp(capturedAt);
  const dateLabel = `${data.date.slice(0,4)}-${data.date.slice(4,6)}-${data.date.slice(6)}`;
  const source = { code, timeframe, captured_at_ms: capturedAt, url: `/live?code=${encodeURIComponent(code)}` };
  const snapshot = { captured_at_ms: capturedAt, review_date: dateLabel, dates: context.dates };
  const sections: Promise<ChartAttachment>[] = [
    ...(['KOSPI', 'KOSDAQ'] as const).map(async id => ({
      blob: await renderReviewCandles(id === 'KOSPI' ? data.kospi : data.kosdaq,
        `${id === 'KOSPI' ? '코스피' : '코스닥'} 분봉`, `${dateLabel} · KRX · 5분 · 캡처 ${stamp}`, palette, context),
      source: { ...snapshot, index_id: id, timeframe: '5m', venue: 'KRX', url: `/live?index=${id}`, section: 'market',
        data_message: (id === 'KOSPI' ? data.kospi : data.kosdaq).message },
    })),
    renderReviewFlow(data.flow, dateLabel, stamp, palette).then(blob => ({ blob,
      source: { ...snapshot, timeframe: 'D', url: '/market', section: 'investor-flow', markets: data.flow.markets, data_message: data.flow.message } })),
    renderReviewCandles(data.daily, `${context.name} 일봉`,
      `${code} · ${context.venue} · 일봉 ${data.daily.candles.length}개 · 강조: 분봉 거래일 · 캡처 ${stamp}`, palette, context, true)
      .then(blob => ({ blob, source: { ...snapshot, ...source, timeframe: 'D', venue: context.venue, section: 'stock-daily', data_message: data.daily.message } })),
    labelReviewMinute(minuteBlob, `${context.name} 분봉`,
      `${code} · ${context.venue} · ${timeframe} · ${captureStamp(context.fromMs)}–${captureStamp(context.toMs)} · 캡처 ${stamp}`, palette)
      .then(blob => ({ blob, source: { ...snapshot, ...source, venue: context.venue, section: 'stock-minute', from_ms: context.fromMs, to_ms: context.toMs } })),
  ];
  return { blob: minuteBlob, source, attachments: await Promise.all(sections) };
}

export { reviewCapturePalette };
