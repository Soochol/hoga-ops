/** Shared text geometry for canvas rendering, selection, alignment and editing.
 * Explicit newlines only: width never introduces a different wrap on the chart.
 * Keep the single-line height unchanged for existing saved drawings. */
export function textLayout(
  text: string,
  fontSize: number,
  measureLine?: (line: string, fontSize: number) => number,
) {
  const lines = text.split(/\r\n|\r|\n/);
  const lineHeight = fontSize * 1.25;
  const width = lines.reduce((max, line) => Math.max(max, measureLine?.(line, fontSize) ?? 0), 0);
  return { lines, lineHeight, width, height: fontSize + (lines.length - 1) * lineHeight };
}
