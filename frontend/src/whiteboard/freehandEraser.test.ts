import { expect, it } from 'vitest';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { hitInk } from './freehandEraser';

const stroke = { type: 'freedraw', x: 100, y: 100, width: 100, height: 30,
  points: [[0, 0], [50, -30], [100, 0]], angle: 0, strokeWidth: 4, isDeleted: false, locked: false } as unknown as ExcalidrawElement;
it('finds strokes extending above the first point, and rotated strokes', () => {
  expect(hitInk(stroke, 150, 70, 5)).toBe(true);
  expect(hitInk(stroke, 150, 130, 5)).toBe(false);
  expect(hitInk({ ...stroke, angle: Math.PI / 2 }, 165, 85, 5)).toBe(true);
});
it('preserves locked strokes and other content beneath a drawing', () => {
  expect(hitInk({ ...stroke, locked: true }, 150, 70, 5)).toBe(false);
  expect(hitInk({ ...stroke, type: 'image' } as unknown as ExcalidrawElement, 150, 70, 5)).toBe(false);
});
