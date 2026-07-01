# KIS Venue Quote Consistency Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the minimal TDD pass for KIS quote venue consistency.

**Architecture:** Keep the existing venue resolver and `/api/live/quotes` route. Add only missing behavior tests and minimal code if a test exposes a gap.

**Tech Stack:** Python, FastAPI TestClient, pytest.

## Global Constraints

- KRX uses KIS `J`.
- NXT uses KIS `NX`; unsupported symbols render unavailable and never fall back to KRX.
- Integrated uses KIS `UN`; the app does not manually combine KRX and NXT.
- AUTO quotes use NXT outside regular session and KRX during 09:00:00-15:30:00 KST.

---

### Task 1: AUTO After-Close Quote Venue

**Files:**
- Modify: `tests/unit/live/test_live_quotes_route.py`
- Modify only if needed: `hoga/live/kis_venue.py`

**Interfaces:**
- Consumes: `quote_venue_for_policy(policy: LiveVenuePolicy, now: datetime) -> KisVenue`
- Produces: test coverage proving AUTO uses NXT after 15:30.

- [ ] **Step 1: Write the failing test**

Add:

```python
def test_quotes_route_auto_uses_nxt_after_regular_session(monkeypatch, tmp_path):
    class _FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):  # noqa: ANN001
            return datetime(2026, 7, 1, 16, 30, tzinfo=tz)

    monkeypatch.setattr(live_api, "datetime", _FixedDatetime)
    fake = _FakeKis(QUOTES)
    kis_runtime.set_kis_client(fake, 0)  # type: ignore[arg-type]
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))

    r = TestClient(app).get("/api/live/quotes", params={"codes": "005930", "venue": "AUTO"})

    assert r.status_code == 200
    assert r.json()["phase"] == "open"
    assert fake.venues == ["NXT"]
```

- [ ] **Step 2: Run the test**

Run:

```bash
pytest tests/unit/live/test_live_quotes_route.py::test_quotes_route_auto_uses_nxt_after_regular_session -q
```

Expected: FAIL if AUTO after-close is not implemented; PASS if prior work already covers it.

- [ ] **Step 3: Implement only if needed**

If the test fails, adjust `auto_minute_venue_for_hhmmss` so only
`090000 <= hhmmss <= 153000` returns `KRX`; all other times return `NXT`.

- [ ] **Step 4: Re-run**

Run the same pytest command. Expected: PASS.

### Task 2: NXT Unsupported Quote Renders Unavailable

**Files:**
- Modify: `tests/unit/live/test_live_quotes_route.py`
- Modify only if needed: `hoga/live/quote_change_resolver.py`

**Interfaces:**
- Consumes: `/api/live/quotes?venue=NXT`
- Produces: route response with `price=0`, `change_pct=null`, `change_pct_source="unavailable"`, and `adjusted_baseline_unavailable`.

- [ ] **Step 1: Write the failing test**

Add:

```python
def test_quotes_route_nxt_zero_price_stays_unavailable(monkeypatch, tmp_path):
    baseline_date = _route_baseline_date()
    _seed_quote_adjusted_daily(
        tmp_path,
        [("067310", baseline_date, 48650, 48650, 48650, 48650, 100)],
    )
    fake = _FakeKis([KisQuote("067310", 0, None, None)])
    kis_runtime.set_kis_client(fake, 0)  # type: ignore[arg-type]
    monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "open")
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))

    r = TestClient(app).get("/api/live/quotes", params={"codes": "067310", "venue": "NXT"})

    assert r.status_code == 200
    q0 = r.json()["quotes"][0]
    assert q0["price"] == 0
    assert q0["change_pct"] is None
    assert q0["change_won"] is None
    assert q0["change_pct_source"] == "unavailable"
    assert q0["warnings"] == ["adjusted_baseline_unavailable"]
    assert fake.venues == ["NXT"]
```

- [ ] **Step 2: Run the test**

Run:

```bash
pytest tests/unit/live/test_live_quotes_route.py::test_quotes_route_nxt_zero_price_stays_unavailable -q
```

Expected: FAIL if zero-price NXT rows are recomputed against daily baseline; PASS if prior work already covers it.

- [ ] **Step 3: Implement only if needed**

If the test fails, update `QuoteChangeResolver.resolve_quote` to treat
`quote.price <= 0` as unavailable and skip baseline recomputation.

- [ ] **Step 4: Re-run focused suite**

Run:

```bash
pytest tests/unit/live/test_kis_venue.py tests/unit/live/test_kis_multi_price.py tests/unit/live/test_live_quotes_route.py -q
```

Expected: PASS.
