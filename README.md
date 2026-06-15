# hoga-ops

Personal local-first tool to capture, store, and replay Korean stock orderbook + trade data from hogaplay.com.

See [`CONTEXT.md`](./CONTEXT.md) for the glossary and [`docs/superpowers/specs/`](./docs/superpowers/specs/) for the design.

## Phase 1 status

Backend only. Frontend is Phase 2 (separate plan).

## Quickstart

```sh
pip install -e .[dev]
echo "k_=...; n_=..." > .cookie   # paste from your hogaplay session
hoga collect --code 003490 --date 20260519
hoga parse   --code 003490 --date 20260519
hoga serve
```
