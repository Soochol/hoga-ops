// frontend/src/chart/DrawingPropertyPanel.tsx
//
// Drawing Property Panel — the floating DOM affordance that lets the user
// edit the selected Drawing's color, stroke width, and line style, and
// delete it. See CONTEXT.md "Drawing Property Panel" and ADR-0032.

import { useDrawingsStore } from '../state/drawings';

export default function DrawingPropertyPanel() {
  const activeTool = useDrawingsStore((s) => s.activeTool);
  const selectedId = useDrawingsStore((s) => s.selectedId);
  const drawing = useDrawingsStore((s) => {
    if (s.activeCode == null || s.selectedId == null) return null;
    return s.byCode.get(s.activeCode)?.find((d) => d.id === s.selectedId) ?? null;
  });

  // Visibility gate — both clauses required.
  if (activeTool !== 'select' || selectedId == null || drawing == null) return null;

  return (
    <div
      data-drawing-property-panel
      className="absolute z-30 inline-flex items-center gap-0.5 bg-bg-card border border-border rounded-lg p-1 shadow-lg"
      style={{ top: 20, left: 14 }}
    >
      {/* controls land in subsequent tasks */}
    </div>
  );
}
