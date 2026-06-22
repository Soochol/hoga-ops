# Capture-enabled folders gate live storage

Status: accepted

The Watchlist remains the user's organised list of Codes, but live KIS storage is now gated by folder-level `capture_enabled`: only Codes in capture-enabled folders become Capture Candidates. The old model treated the whole Watchlist as the Live Set input, but that made the new REST 30s storage mode ambiguous: users expected "checked groups" to control whether data is stored at all. The chosen model makes the rule explicit: group opt-in decides *whether* a Code is saved, and Storage Policy decides *how* it is saved (`kis_live`, `kis_api`, or both).

Consequences: existing folders migrate as capture-enabled to preserve current capture behavior; new folders default to disabled so live storage remains an explicit opt-in. The internal WS source id stays `kis_live`; "KIS WS" is a UI label, not an on-disk/source-id migration.
