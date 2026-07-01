# Live Peak Wall Visible Docked Labels Design

## Problem

Today/live peak-wall labels are now docked into a right-side chart-pane lane, which solves direct candle overlap near the live edge. When the user pans back to older chart history, those same today labels remain visible even though the today segment is outside the visible time range. That makes the labels feel out of context and reduces readability while inspecting past candles.

## Decision

Show today/live docked ask and bid peak-wall labels only when their source segment overlaps the current visible time range.

- If the visible range includes any part of the today/live peak-wall segment, show the docked label.
- If the visible range is fully outside that segment, hide the docked label.
- Historical inline labels keep their existing behavior.
- Ask and bid peak-wall labels use the same visibility rule.
- If lightweight-charts has not produced a visible range yet, keep the existing behavior and show the labels.

## Testing

Add focused unit coverage around the segment-to-docked-label transformation:

- live labels are returned when the segment overlaps the visible range;
- live labels are filtered when the segment is outside the visible range;
- null visible range preserves current label output;
- ask and bid callers can share the same helper because both produce the same segment shape.
