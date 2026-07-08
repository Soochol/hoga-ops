import { describe, it, expect, vi } from 'vitest';
import { measureTextCached } from './textWidthCache';

function stubCtx(font: string) {
  const measureText = vi.fn((text: string) => ({ width: text.length * 7 }));
  return {
    ctx: { font, measureText } as unknown as CanvasRenderingContext2D,
    measureText,
  };
}

describe('measureTextCached', () => {
  it('첫 호출은 실측하고 같은 (font, text) 재호출은 캐시를 쓴다', () => {
    const { ctx, measureText } = stubCtx('10px sans-serif');
    expect(measureTextCached(ctx, 'cache-test-라벨')).toBe('cache-test-라벨'.length * 7);
    expect(measureTextCached(ctx, 'cache-test-라벨')).toBe('cache-test-라벨'.length * 7);
    expect(measureText).toHaveBeenCalledTimes(1);
  });

  it('font가 다르면(DPR/줌 변경) 별도 엔트리로 재측정한다', () => {
    const a = stubCtx('10px sans-serif');
    const b = stubCtx('20px sans-serif');
    measureTextCached(a.ctx, 'cache-test-dpr');
    measureTextCached(b.ctx, 'cache-test-dpr');
    expect(a.measureText).toHaveBeenCalledTimes(1);
    expect(b.measureText).toHaveBeenCalledTimes(1);
  });
});
