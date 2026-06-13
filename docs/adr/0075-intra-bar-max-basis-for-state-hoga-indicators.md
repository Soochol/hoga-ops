# Intra-Bar Max basis for state hoga indicators (opt-in)

**Status**: accepted

The three state hoga indicators — **Quote Totals**, **호가비**, **당일 매도 최대벽 (Day Ask Peak)** —
each represent a minute bucket by its **close** (the bucket's last continuous-trading snapshot). We add an
opt-in per-indicator **분봉 내 최댓값 기준 (Intra-Bar Max)** basis that instead represents the bucket by its
intra-bar maximum, so a user viewing minute bars can see the bar's peak the way a candle shows its high.
Default stays close; the basis is a pure client render switch over peak fields shipped alongside close on
the wire (no `mode=` param, **Past/Today Split Cache** preserved).

## Considered Options

- **Drop Day Ask Peak from the Intra-Bar Max scope** (keep only Quote Totals + 호가비). Rejected: the user
  explicitly wants the matched peak for the wall too.
- **Bypass the 호가비 Outlier Mask for the peak value** (always show the raw extreme). Rejected: a single
  thin-book snapshot (e.g. bid=1/ask=9999 under the unbounded `ask/bid−1` formula) would destroy RatioPane
  autoscale — exactly what the Outlier Mask exists to prevent. The mask stays orthogonal; turn the filter off
  to see raw extremes.

## Consequences

- **Day Ask Peak's Intra-Bar Max mode deliberately reverses #96**, whose stated rationale (CONTEXT.md) is that
  a wall spiking and receding *between* bucket representatives is a "sub-bucket transient — invisible at the
  displayed 1m/3m resolution — and is correctly skipped." Close mode answers "what wall could I actually see
  and act on at this resolution?"; Intra-Bar Max answers "what was the largest wall this minute, even if
  fleeting (spoof-prone)?" Both are legitimate; the user picks per indicator, default close.
- **총잔량 급증 detection stays close-based** regardless of the toggle (display-only). Feeding peak-per-bucket
  into its running-peak detector would double-peak and shift the 95%/85% trigger; isolation is free because
  `detectSurgeSide` hardcodes the `ask_total`/`bid_total` field names. The surge marker height rides the
  displayed line.
- **호가비 Intra-Bar Max still passes the Outlier Mask** (default on), so spike peaks may render as 0 until the
  filter is turned off — an accepted interaction, surfaced in the spec/UI.
- **Today is approximate, history is precise.** The live ratchet / SSE buffer drives today's peak; the backend
  confirms exact close/peak values once a bar ages into history (a bar's peak may revise upward at that seam —
  close is immune). For Day Ask Peak specifically the live ratchet is already a running max, so today's toggle
  is visually inert (close↔peak differ only on past trading days).

Spec: `docs/superpowers/specs/2026-06-13-live-hoga-peak-basis-design.md`.
