# Ticklane application icon

`icon.png` is the production app icon used by Electron, Linux packaging and the local launcher. The selected F design uses three forward-slanting lime bars of different lengths on an olive-black rounded-square tile, suggesting rapid price updates. Corners outside the tile are transparent. Electron and the desktop shell scale the high-resolution PNG for their display sizes.

Generated on 2026-10-16 with the built-in ImageGen tool and selected by the user. The original amber source proposal is `proposals/2026-10-16/f-price-ticks.png`; the application uses the repository copy and does not depend on the generation folder. On 2026-10-29 the user requested the Trading Desk palette for both Electron apps. The client was recolored with built-in ImageGen, targeting olive-black `#0B0F0B` and lime `#C7FA79`; generated raster colors are approximate. The launcher uses the versioned `ticklane-local-v2.png` basename to refresh existing icon caches.

## Server manager icon

`server-icon.svg` is the vector source for the separate **Ticklane 서버** app. Two lime (`#C7FA79`) server chassis and a network connection sit on an olive-black (`#0B0F0B`) tile matching the Ticklane client palette. `server-icon.png` is the transparent 1024px raster export used for the management window, header and Linux shortcuts. The client continues using `icon.png`; the server shortcut uses `ticklane-server-v3.png` to refresh desktop icon caches. Tray status icons keep their existing semantic colors.

## Trading Desk client recolor prompt (2026-10-29)

Built-in ImageGen edit, with the previous `icon.png` as its reference and transparency enabled:

> Use case: precise-object-edit. Asset: production Ticklane Electron desktop app icon. Input image is the edit target. Recolor ONLY the existing icon: rounded-square tile must be flat solid olive black #0B0F0B, all three diagonal bars must be flat solid lime #C7FA79. Preserve the exact existing three bars, their positions, widths, lengths, angles, rounded corners, spacing, silhouette and tile footprint. Preserve transparent exterior corners, no opaque background outside tile. Remove existing texture/shading so fills are solid flat colors. No new symbols, no text, no borders, no gradients, no shadows, no glow. Export a square high-resolution PNG icon with actual alpha transparency.

## Generation prompt for the client (original project name preserved)

Use case: logo-brand. Asset: one premium Linux desktop app icon for Hoga Ops, a professional Korean stock orderbook and chart terminal. Square composition. Deep graphite (#121216) rounded-square tile occupying 90% of canvas with genuinely transparent outside corners. One solid warm amber (#F0B429) emblem centered on the tile. Quiet industrial financial terminal identity. Flat vector-like precision, bold strokes, balanced negative space, recognizable at 32 pixels. No text or letters, no numbers, no candles, no upward chart line, no gradients, textures, shadows, glow, bevels, 3D, mockup, watermark, tiny details or decorative border. Subject: a distinctive PRICE TICKS emblem. Exactly three thick diagonal rounded parallelogram bars arranged in a tight ascending offset sequence, slanting forward about 25 degrees. The left bar is short, middle bar is longest, right bar is medium length. Create a unified dynamic emblem with even dark slits between bars, strong optical balance and sculptural negative space. The mark suggests rapid quotation updates and a precise professional trading tool. No connecting line, no candle wicks, no arrowheads. Confident minimal brand identity.
