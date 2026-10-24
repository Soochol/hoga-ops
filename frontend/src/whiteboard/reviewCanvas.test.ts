import { describe, expect, it } from 'vitest';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { emptyRecord, emptyReview } from './review';
import { reviewCanvasPlan, reviewPages } from './reviewCanvas';

describe('structured review preservation on a free canvas', () => {
  it('projects every old field and image without mutating the archived review', () => {
    const review = { ...emptyReview('2026-10-24'), summary: '하루 결론', good: '지킨 기준', change: '바꿀 행동', principle: '다음 원칙',
      records: [{ ...emptyRecord(), title: '눌림 관찰', stock: '삼성전자', code: '005930', timeframe: '5m',
        captured_at_ms: 1792800000000, image_file_id: 'chart', judgment: '거래량 확인', action: '기다렸다', result: '계획대로' }] };
    const original = structuredClone(review);
    const plan = reviewCanvasPlan('note', '한 주 복기', review, { files: { chart: { asset_id: 'asset', mime_type: 'image/png', width: 1600, height: 1000, size: 1000, created: 1 } } }, []);
    const text = plan.filter(el => el.type === 'text').map(el => el.type === 'text' ? el.text : '').join('\n');
    for (const value of ['하루 결론', '지킨 기준', '바꿀 행동', '다음 원칙', '삼성전자', '005930', '5m', '눌림 관찰', '거래량 확인', '기다렸다', '계획대로']) expect(text).toContain(value);
    const image = plan.find(el => el.type === 'image');
    expect(image).toMatchObject({ fileId: 'chart', width: 720, height: 450, link: '/live?code=005930', frameId: 'review-page-note' });
    expect(review).toEqual(original);
  });
  it('never duplicates the projection after saving or deleting its page', () => {
    const marker = { type: 'frame', customData: { reviewCanvasVersion: 1 }, isDeleted: true } as unknown as ExcalidrawElement;
    expect(reviewCanvasPlan('id', '제목', emptyReview('2026-10-24'), { files: {} }, [marker])).toEqual([]);
    expect(reviewPages([marker])).toEqual([]);
  });
  it('starts new days with an empty page and preserves pre-existing canvas objects', () => {
    const empty = reviewCanvasPlan('id', '제목', emptyReview('2026-10-24'), { files: {} }, []);
    expect(empty).toHaveLength(1);
    expect(empty[0]).toMatchObject({ type: 'frame', children: [], width: 1100, height: 760 });
    const previous = { type: 'rectangle', x: 100, y: 0, width: 200, height: 100 } as ExcalidrawElement;
    expect(reviewCanvasPlan('id', '제목', emptyReview('2026-10-24'), { files: {} }, [previous])[0]).toMatchObject({ x: 380 });
  });
  it('keeps long original paragraphs complete and expands the page to fit', () => {
    const summary = '매일 기록한 원칙을 돌아본다.\n'.repeat(200);
    const plan = reviewCanvasPlan('id', '제목', { ...emptyReview('2026-10-24'), summary }, { files: {} }, []);
    expect(plan.find(el => el.type === 'text' && el.id?.endsWith('-summary'))).toMatchObject({ text: `하루 결론\n${summary}` });
    expect(plan[0].height).toBeGreaterThan(6000);
  });
});
