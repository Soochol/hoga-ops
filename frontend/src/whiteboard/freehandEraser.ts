import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';

/** Erase an entire ink stroke; preserve images, text, shapes and locked content. */
export function hitInk(element: ExcalidrawElement, x: number, y: number, radius: number): boolean {
  if (element.type !== 'freedraw' || element.isDeleted || element.locked) return false;
  // Freedraw points are relative to the first point, and may extend above/left of it.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of element.points) {
    minX = Math.min(minX, point[0]); maxX = Math.max(maxX, point[0]);
    minY = Math.min(minY, point[1]); maxY = Math.max(maxY, point[1]);
  }
  const cx = element.x + (minX + maxX) / 2, cy = element.y + (minY + maxY) / 2;
  const cos = Math.cos(-element.angle), sin = Math.sin(-element.angle);
  const px = (x - cx) * cos - (y - cy) * sin + (minX + maxX) / 2;
  const py = (x - cx) * sin + (y - cy) * cos + (minY + maxY) / 2;
  const tolerance = radius + element.strokeWidth / 2;
  if (px < minX - tolerance || py < minY - tolerance || px > maxX + tolerance || py > maxY + tolerance) return false;
  return element.points.some((point, index) => {
    const previous = element.points[Math.max(0, index - 1)];
    const dx = point[0] - previous[0], dy = point[1] - previous[1];
    const t = Math.max(0, Math.min(1, ((px - previous[0]) * dx + (py - previous[1]) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(px - previous[0] - t * dx, py - previous[1] - t * dy) <= tolerance;
  });
}
