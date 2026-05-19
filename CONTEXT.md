# hoga-ops

Single-user local tool that captures Korean stock orderbook + trade replay data from `hogaplay.com` and exposes it for analysis.

## Language

**Regular Session**:
The continuous-trading window of the KRX day, 09:00:00–15:30:00 (includes the closing single-price auction 15:20–15:30).
_Avoid_: "session" alone, "market hours"

**Data Window**:
The full span of data hogaplay returns for a stock-date, broader than the Regular Session. Includes pre-market single-price activity from ~08:40 and any closing-auction residuals. Outer bounds are the earliest and latest event timestamps in the captured TSV.
_Avoid_: "session" alone, "trading day"

**Code**:
A 6-digit KRX ticker, e.g. `005930`. Strings, not integers — leading zeros matter.
_Avoid_: "symbol", "ticker"

**Stock-Date**:
The unit of capture and storage: one (Code, YYYYMMDD) pair. All paths and queries are scoped to a Stock-Date.

**Page**:
One `first.php` HTTP response. Bounded in size (~500–1000 events). Multiple Pages cover one Stock-Date's Data Window.
_Avoid_: "chunk", "batch", "section" (overloaded — see TSV Section below)

**Full Capture**:
The union of all Pages for one Stock-Date, deduplicated. The artifact the collector must produce before the parser runs.

**TSV Section**:
The first field of every row in a Page's TSV (`1` = events that occurred before the requested `time`, `2` = events from the requested `time` onward). A presentation marker dependent on the call's `time` parameter — *not* an intrinsic property of an event. The same event can appear as TSV Section 1 in one Page and TSV Section 2 in another with all other fields identical (verified 2026-05-19). Dropped during parsing.
_Avoid_: "section" alone (ambiguous with Regular Session, Page)

**Global Sequence (global_seq)**:
Field 4 of every event row. Strictly increasing per-Stock-Date counter across all event types. The dedup key when merging Pages into a Full Capture: verified unique-within-Page and stable-across-Pages.

**Page Step**:
The increment applied to the `time` query parameter between successive collector calls. Variable, not fixed. Default 60000ms (1 minute) matching hogaplay's UI step; collector halves the step (30s, 15s, ...) when a response fails to cover the requested window — indicating the response cap was hit before reaching `time + step`.

**Auction Cross**:
A trade matched via a call auction (단일가 매매), not continuous trading. Occurs at the open (~09:00:00.000), the close (~15:30:00.000), and pre-market single-price periods. Recognizable in the trade schema by **absence of `+`/`-` sign** on the qty field (event type 1) OR by being an event type 3 row (single-price summary, used for both opening and closing auctions — confirmed in production 2026-05-20). Stored as `side = 0` (distinct from continuous-trading `+1` buy-aggressor / `-1` sell-aggressor). Excluded from CVD, aggressor-based metrics, and `cum_vol` monotonicity validation (`side=0` rows carry `cum_vol=0`).
_Avoid_: "auction trade" alone, "opening trade", "closing trade"

**Price Tick**:
A 3-field `section=3 type=5 price` heartbeat broadcast emitted by hogaplay throughout the session. Carries only the current price — no qty, side, or seq. Discovered during E2E validation 2026-05-20. Parser drops these rows entirely; the same information is already present in trade events.

## Relationships

- A **Stock-Date** has exactly one **Data Window** and exactly one **Full Capture**.
- A **Stock-Date**'s **Regular Session** sits inside its **Data Window**.
- A **Full Capture** is built from N **Pages**; consecutive Pages may overlap.
- The collector captures the entire **Data Window**; UI and analysis default to the **Regular Session** but can extend to the **Data Window**.

## Flagged ambiguities

- "session" was used ambiguously to mean both **Regular Session** (info.tsv's `session_open`/`session_close` fields) and **Data Window** (collector loop range, scrubber range) — resolved 2026-05-19: these are distinct, use the precise term.
