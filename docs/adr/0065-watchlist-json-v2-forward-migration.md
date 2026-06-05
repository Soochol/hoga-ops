# 0065 — watchlist.json v2: forward-migrate in place, never quarantine

**Status:** accepted (2026-05-31)

**Related:**
- ADR-0015 (Symbol Master disk persistence) and ADR-0019 (Capture Queue manifest persistence) — both establish the `schema_version` + **quarantine-on-mismatch** convention for disk-persisted JSON. ADR-0019 explicitly **deferred** a real schema-migration policy ("v2 마이그레이션은 별도 ADR"). This is that ADR, for the **Watchlist**.
- ADR-0004 (Wire Model = consumer shape; no adapter) — constrains how the v2 shape reaches the frontend (see Consequences).
- `docs/superpowers/specs/2026-05-31-watchlist-folders-design.md` — the spec this ADR records reasoning for.

## Decision

`<data_dir>/watchlist.json` moves from v1 (`{version: 1, entries: [...]}`) to **v2**:

```jsonc
{ "schema_version": 2,
  "folders":  [{ "id": "f_…", "name": "…", "order": 0 }, …],
  "entries":  [{ …v1 fields…, "folder_id": null | "f_…", "order": 0 }, …] }
```

Three load-path rules, all distinct from the sibling persisters:

1. **Forward-migrate in place, never quarantine.** On reading a v1 (or field-less legacy) document, normalise it in memory to v2 — every entry gets `folder_id = null` and `order =` its current index, `folders = []`. The migration is **lazy**: `load_document` returns the v2-normalised value but does **not** itself write to disk — it is called lock-free by the GET endpoint / the Daily Scheduler / the live poller, and writing there would violate rule 2's single-`_lock` discipline. The normalised shape is persisted on the **next** mutation, which round-trips the whole document under `_lock`. The migration is **forward-only and idempotent** (a v2 document loads unchanged). A version we do *not* recognise (e.g. a future v3 on a downgraded binary) **raises** (`ValueError`, not caught by the corrupt-file backup path) rather than being silently downgraded.

2. **The whole document is the unit of read and write.** `load_watchlist` returns the full `WatchlistDocument` (folders + entries), and **every** writer — `add_entry`, `remove_entry`, `bump_last_success`, `set_last_success`, and all new folder/move/reorder mutations — round-trips that whole document under the single shared `_lock`. There is no entries-only save path.

3. **Typed envelope, not an ad-hoc dict.** The document is a Pydantic `WatchlistDocument` (mirroring the `QueueManifest` precedent), validated on load via `model_validate_json`, with a document-level `model_validator` enforcing referential integrity: every `entry.folder_id` is `null` or the `id` of a folder in `folders[]`. The field is named `schema_version` to match `QueueManifest` / Symbol Master.

## Context

Three JSON files persist under `<data_dir>`: the Symbol Master cache, the Capture Queue manifest (`.queue.json`), and the Watchlist (`watchlist.json`). The first two **quarantine** a schema-version mismatch — rename the file aside and rebuild from source (`pykrx` re-fetch / an empty queue). That is safe precisely because their contents are **rebuildable or ephemeral**.

The Watchlist is neither. It is the one piece of **irreplaceable, user-authored** state in the tool: the Codes the user chose to track, and now the folders they organised them into. Quarantining it on a version bump would silently erase the user's entire watchlist on first launch of the new build — the worst possible outcome of shipping a feature.

Two latent traps made this worth an ADR rather than a code comment:

- The Watchlist's existing `load`/`save` pair round-tripped **only `entries`** and hard-coded `{"version": 1}` on write. A v2 that merely *added* a folders path would have every legacy writer — including the **Daily Scheduler**'s `bump_last_success`, which fires on **every** capture success — rewrite the file without `folders`, wiping the user's folders within hours of use. Rule 2 closes that.
- A future maintainer, seeing the two sibling files quarantine on mismatch, would reasonably "fix" the Watchlist to match — and delete user data. Rule 1, recorded here, is the explicit "do not do that, and here's why."

## Alternatives considered

### A. Quarantine on mismatch, like the siblings (rejected)
Consistent with ADR-0015/0019. **Rejected**: watchlist.json holds unrecoverable user data; quarantine = silent total data loss on upgrade. Consistency with rebuildable-data persisters is the wrong consistency to optimise for.

### B. Separate `folders.json` file, leave watchlist.json at v1 (rejected)
Avoids touching the legacy writers. **Rejected**: splits one cohesive aggregate across two files with no transaction spanning them, and re-creates the dangling-reference problem across a file boundary (entry deleted in one file, folder membership stale in the other). The Watchlist is one aggregate; it persists as one document.

### C. Forward-migrate, whole-document round-trip, typed envelope (chosen)
One atomic v1→v2 transform, every writer preserves the whole document under one lock, integrity enforced by a typed validator. Cost: the legacy `load`/`save` signature changes from `list[WatchlistEntry]` to `WatchlistDocument`, touching all four existing writers — a deliberate, contained churn that is the point, not a side effect.

## Consequences

**Positive:**
- User folders survive every capture-success write and every server restart. No upgrade-time data loss.
- A single typed envelope + `model_validator` makes "no dangling `folder_id`" a structural property checked at load, not a scattered imperative check.

**Negative / watch:**
- The Watchlist is now the **one** disk persister that forward-migrates instead of quarantining. The divergence is intentional and recorded here; the load path carries a comment pointing back to this ADR so it is not "consistency-fixed" into data loss.
- `schema_version` here is a real migration trigger, not just a quarantine sentinel — future bumps (v2→v3) must add another forward transform, not a quarantine branch.
- Per ADR-0004 the frontend mirrors the v2 wire shape verbatim: `folders: Folder[]` + per-entry `folder_id`/`order`. **미분류** stays `folder_id === null` end to end — the client must not synthesise an "uncategorized" folder object, which would reshape the wire model.
