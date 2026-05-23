# 0018 — CandlePane muting is not Auction Mask

**Status:** accepted (2026-05-24)

## Decision

`projectCandle` in `frontend/src/chart/projectors/candle.ts` dims candles inside the closing **Auction Window** to a muted color (`--fg-dim`) unconditionally — it does **not** consult the per-tab `auctionWindowMask` toggle. The candle never disappears; only its color changes.

This is intentional. CandlePane muting is **not** a participant of the **Auction Mask** as defined in `CONTEXT.md`. It is a separate, always-on visual cue that survives any future expansion of the Auction Mask toggle.

## Why

The `auctionWindowMask` toggle exists to suppress _misleading_ derived-ratio values during the closing Auction Window — one-sided order accumulation makes `ask_total / bid_total` read as extremes that are not signal. `RatioPane` and `TotalQtyBar` hide their values entirely when the mask is active because rendering them anyway would communicate something false.

Candle data during the Auction Window is structurally different:

- **Candle values are not misleading.** Open / high / low / close come from accumulating limit orders, not from a derived ratio. They still describe what happened at that bucket. They are simply formed by a different mechanism (call auction price discovery) than continuous-trading candles.
- **Hiding candles would create a gap.** A 10-minute hole in the candle series before the close would be more disorienting than the muted color it replaces. Users expect price continuity; the muted color communicates "this is auction-formed data, read carefully" without breaking the visual timeline.
- **The toggle's name is about masking — hiding misleading derived values.** Repurposing it to also mean "stop tinting candles" would conflate two distinct user intents into one switch.

The two behaviors share a predicate (`VirtualAxis.inClosingAuctionWindow`) but answer different questions about it.

## Consequences

- `projectCandle` keeps the inline call to `axis.inClosingAuctionWindow(c.ts_ms)` with no toggle gate.
- The `useAuctionMaskActive` hook (introduced 2026-05-24) does not affect candle rendering. CandlePane has no reason to call it.
- `CONTEXT.md`'s "Auction Mask" entry explicitly names CandlePane as a known non-participant and links here.
- If a future user-facing setting wants to control candle muting separately, it must be a distinct toggle (e.g., `auctionCandleMuting`), not a repurposing of `auctionWindowMask`.

## Alternatives considered

**Make CandlePane respect `auctionWindowMask`.** Rejected. The toggle's current default is `true`, so a typical user enables masking to suppress the RatioPane ratio. Coupling candle muting to it would mean: turning off the ratio mask would also stop tinting candles — two unrelated visual changes from one click. Users would mentally separate them anyway; the UI would lie about coupling.

**Introduce a second toggle for candle muting now.** Rejected as YAGNI. No user has asked for candles to be un-muted in the closing Auction Window. The muting is information-preserving, not destructive. Adding a settings switch for a hypothetical preference inflates the Settings modal without evidence of need.

**Hide candles inside the Auction Window when masked.** Rejected. Breaks price continuity. The Auction Window's candles are a legitimate part of the price history.
