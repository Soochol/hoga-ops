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

**Auction Window**:
The period leading up to an **Auction Cross** during which limit orders accumulate but no continuous matching happens. KRX has two within the Regular Session: the closing **Auction Window** runs 15:20:00–15:30:00 and resolves with a cross at 15:30:00.000. The opening Auction Window (pre-market, part of the Data Window) is symmetric. **Snapshots are present and meaningful during an Auction Window** — bid/ask quantities at each level accumulate visibly. **Trades are absent** during the window itself; the cross at the window's close produces a single `side = 0` trade. UI metrics that rely on snapshots (호가비, depth intensity) render continuously across an Auction Window; UI metrics that rely on continuous trades (fill strength) show a natural gap then a single bar at the cross.
_Avoid_: "auction period", "auction phase", "auction time" (all overloaded)

**After-Hours Trading**:
The KRX 장후 시간외 종가매매 window that runs from the closing Auction Cross at 15:30:00 to 16:00:00. All trades during this window match at the closing price (the cross price from 15:30:00) — so the price stays flat while volume continues to accumulate. Both snapshots and trades are present in hogaplay's capture across this window. Trades have continuous-trading `side = ±1` (not `side = 0`) — they are aggressor-matched at a fixed price, not auction crosses. Outside `CONTEXT.md`'s strict Regular Session definition (09:00–15:30) but inside hogaplay's Data Window and inside the v1 frontend display range.
_Avoid_: "after-hours" alone (ambiguous with overnight or block-trade markets), "post-market"

**Price Tick**:
A 3-field `section=3 type=5 price` heartbeat broadcast emitted by hogaplay throughout the session. Carries only the current price — no qty, side, or seq. Discovered during E2E validation 2026-05-20. Parser drops these rows entirely; the same information is already present in trade events.

**Entity**:
The in-memory frozen-dataclass representation of one row of table data inside hoga-ops. Carries every field including **forensic** ones — fields whose meaning is partially or fully undecoded (`unknown_14`, `unknown_16`, `unknown_17`, `unknown_18`) kept to enable later decoding without re-collection. Used by the parser on the write path. Internal — never returned by the API. Examples: `Trade`, `Orderbook`, `BrokerRow`, `Candle` in `hoga/tables/*`.
_Avoid_: "model", "domain object", "record"

**Wire Model**:
The pydantic model returned by API endpoints — the shape clients see. Strips forensic fields (and any other internal-only data). Each table module pairs an **Entity** with its Wire Model: `Trade`↔`ApiTrade`, `Orderbook`↔`ApiOrderbookSnapshot`, `BrokerRow`↔`ApiBrokerEntry`, `Candle`↔`ApiCandle`. Query helpers (`query_at`, `query_up_to`, etc.) return Wire Models directly — there is no intermediate dict materialization.
_Avoid_: "API model" alone (ambiguous with response containers like `OrderbookResponse`), "DTO"

## Relationships

- A **Stock-Date** has exactly one **Data Window** and exactly one **Full Capture**.
- A **Stock-Date**'s **Regular Session** sits inside its **Data Window**.
- A **Full Capture** is built from N **Pages**; consecutive Pages may overlap.
- The collector captures the entire **Data Window**; UI and analysis default to the **Regular Session** but can extend to the **Data Window**.
- Each Parquet table has one **Entity** type (for the parser write path) and one **Wire Model** type (for the API read path). Both live in the same `hoga/tables/*.py` module.

## Flagged ambiguities

- "session" was used ambiguously to mean both **Regular Session** (info.tsv's `session_open`/`session_close` fields) and **Data Window** (collector loop range, scrubber range) — resolved 2026-05-19: these are distinct, use the precise term.
