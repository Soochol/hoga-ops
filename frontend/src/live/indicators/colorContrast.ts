/** Opaque hex colors used by the indicator palette and theme tokens. Unknown formats stay unknown. */
export function colorContrast(a: string, b: string): number | null {
  function luminance(color: string): number | null {
    if (/^#[\da-f]{3}$/i.test(color)) color = '#' + [...color.slice(1)].map((digit) => digit + digit).join('');
    if (!/^#[\da-f]{6}$/i.test(color)) return null;
    const rgb = [1, 3, 5].map((offset) => {
      const channel = parseInt(color.slice(offset, offset + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  }
  const x = luminance(a);
  const y = luminance(b);
  return x === null || y === null ? null : (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
