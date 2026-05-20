# 0002 — Defer source descriptor unification until Phase 2 derived tables exist

**Status:** accepted (2026-05-20)

## Decision

`hoga/parser/__init__.py` keeps two distinct collection paths: `_collect_events` (drives the dispatcher over `first_*.tsv` and fans into trades/snapshots/brokers) and `_collect_candles` (reads `chart.tsv` and feeds `candles.parse_row` directly). The shared mechanics (line iteration + per-line `lenient`/strict error accumulation with `(path, lineno, msg)` skipped records) are factored into `_iter_first_lines` and `_iter_chart_lines`. No `SOURCE` descriptor on table modules; no unified file-source abstraction.

## Why

The natural unit of iteration is **the TSV file**, not the table:
- `first_*.tsv` contains three table flavors interleaved (trades + snapshots + brokers); one pass fans out.
- `chart.tsv` is single-flavor candles.

A `SOURCE` descriptor on each table doesn't fit cleanly — three first.tsv tables would share the same source declaration, creating asymmetry with the candles module. Designing a file-centric source abstraction *now* with only two file types in play risks shaping it to fit exactly two cases, then having a Phase 2 derived table (CVD / anomaly / broker-concentration — see ADR-0001 flavor #3) reveal the abstraction was wrong.

ADR-0001 already names three data-source flavors; only two are live (first.tsv, chart.tsv). When the third flavor (derived-from-Parquet) lands, we will have the empirical third case needed to design the unification properly. Reopen this decision at that point.

## Considered alternatives

- **`SOURCE` descriptor on each table module** (`candles.SOURCE = FileSource(filename="chart.tsv", parse_line=parse_row)`). Rejected for asymmetry: trades/snapshots/brokers can't have an analogous attribute since they share one file. The descriptor lives at the wrong granularity.

- **File-centric `TsvFileSource` registry in a new `hoga/collector/sources.py`**. Rejected as premature. The third case (Parquet-derived) doesn't yet exist, so the abstraction would be shaped to fit two file-based sources and likely fail when the derived flavor appears.

- **Move `chart.tsv` filename string to `candles.SOURCE_FILENAME`**. Rejected as 2-line cosmetic change — buys almost nothing while introducing an inconsistent partial attribute (only candles has it).

## Consequences

- Two collection functions remain. Their similarity is acknowledged but not abstracted.
- The shared mechanics (file iteration, lenient error accumulation) are extracted into `_iter_*_lines` helpers so error reporting is symmetric across both paths.
- When Phase 2 begins (CVD or similar derived table), revisit this ADR: at that point three cases will reveal the correct abstraction shape.
