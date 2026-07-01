# Live Peak Wall Trailing Labels Design

## Problem

Docking today/live peak-wall labels to a fixed right-side lane keeps labels away from candles, but it weakens the visual connection between each label and its line. The label can feel like a price-axis marker instead of a description of the horizontal peak-wall line.

## Decision

Render today/live ask and bid peak-wall labels in the chart's right-side empty padding area, aligned to each line's y-coordinate and placed immediately after the visible live segment endpoint.

- Labels stay out of the candle body area.
- Labels are not y-axis labels.
- The line-to-label relationship is preserved by starting the label near the live segment's right endpoint.
- If the live segment is outside the visible range, keep hiding the label.
- Historical inline labels keep their existing behavior.
- If there is not enough empty right padding to fit the label after the segment endpoint, hide that label instead of drawing over candles.

## Testing

Add focused unit coverage for docked label candidate placement:

- labels use the segment endpoint plus a gap when there is enough right padding;
- labels are hidden when the endpoint leaves insufficient right-padding space;
- existing y-coordinate and empty-label filtering behavior remains intact.
