export type ZoomCommand = 'in' | 'out' | 'reset';
export const ZOOM_FACTORS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;

export function validZoomFactor(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0.5 && value <= 3;
}

export function nextZoomFactor(current: number, command: ZoomCommand): number {
  if (command === 'reset') return 1;
  const factor = validZoomFactor(current) ? current : 1;
  return command === 'in'
    ? ZOOM_FACTORS.find(value => value > factor + 0.000001) ?? 3
    : [...ZOOM_FACTORS].reverse().find(value => value < factor - 0.000001) ?? 0.5;
}

/** Consume only app zoom keys. Wheel events remain owned by the chart. */
export function zoomCommand(input: { type: string; key: string; code?: string; control: boolean; meta: boolean; alt: boolean }): ZoomCommand | null {
  if (input.type !== 'keyDown' || input.alt || (!input.control && !input.meta)) return null;
  if (['+', '=', 'Add'].includes(input.key) || input.code === 'NumpadAdd') return 'in';
  if (['-', 'Subtract'].includes(input.key) || input.code === 'NumpadSubtract') return 'out';
  if (input.key === '0') return 'reset';
  return null;
}
