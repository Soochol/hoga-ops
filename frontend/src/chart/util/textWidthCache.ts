/** canvas measureText 캐시 — primitive draw()는 팬/줌 중 매 프레임 호출되어 같은
 *  라벨을 반복 측정한다. 키에 ctx.font(픽셀 배율 반영)가 들어가 DPR/줌 변경 시
 *  자연 무효화된다. 상한 도달 시 통째로 비운다(라벨 어휘는 수백 수준이라 사실상
 *  미발동; LRU 관리 비용이 이득보다 크다). */
const MAX_ENTRIES = 4096;
const widthByFontAndText = new Map<string, number>();

export function measureTextCached(ctx: CanvasRenderingContext2D, text: string): number {
  const key = `${ctx.font}|${text}`;
  const cached = widthByFontAndText.get(key);
  if (cached !== undefined) return cached;
  const width = ctx.measureText(text).width;
  if (widthByFontAndText.size >= MAX_ENTRIES) widthByFontAndText.clear();
  widthByFontAndText.set(key, width);
  return width;
}
