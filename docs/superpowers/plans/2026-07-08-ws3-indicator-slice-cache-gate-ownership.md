# WS3: 지표 슬라이스 빌더의 캐시 게이트 소유권 내재화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox 문법.

**Goal:** ADR-0043/0090의 "과거=디스크 1분 캐시, 오늘=TTL" 게이트 선택을 호출자 책임에서 빌더 내부 기본값으로 옮겨, 새 지표/새 호출자가 캐시 계약을 공짜로 상속하게 한다.

**Architecture:** `_RESOLVE` 센티널 기본값. 4개 빌더(`build_quote_ratio_slice`, `build_fill_strength_slice`, `build_ask_bid_peak_slices`, `build_trade_volume_poc_slice`)의 `cache`/`today_kst`가 미지정이면 빌더가 `engine.indicators_cache` / 현재 KST 날짜로 자가-해석한다. `None` 명시는 기존대로 "캐시 미적용"(테스트 주입 시맨틱 보존). **세션 경계 인자는 현행 유지** — 탐색 결과 (a) 루프 meta는 직접-읽기 폴백이 있고 (b) `get_meta`는 매 호출 파일을 읽어 date당 3-4회 중복 읽기가 생기며 (c) 캐시 키에 close가 없어 임의 close 주입과 캐시 활성의 조합은 오염 위험이 있으므로, 세션 경계는 per-date 데이터 인자로 남긴다. `build_range_bundle` 루프에서 `cache=`/`today_kst=` 보일러플레이트 4곳 제거.

**검증한 안전 조건:** 빌더를 직접 호출하는 테스트 전부(decontam·day_window_invariant·cache_integration·today_ttl_integration)가 실제 `QueryEngine(tmp_path)` 사용 — 자가-해석 캐시는 tmp 격리(`data_dir/kis-past-indicators`), 결과는 재집계 계약(test_indicator_reaggregate)으로 동일. bundle 루프 테스트의 MagicMock 엔진은 `eng.indicators_cache = None`을 명시 세팅(test_bundle.py:129) 또는 빌더를 패치.

### Task 1: 센티널 + 4개 빌더 자가-해석 + 루프 단순화 + 회귀 테스트

**Files:**
- Modify: `hoga/api/bundle.py`
- Test: `tests/unit/api/test_indicator_slice_self_resolution.py` (신규)

- [ ] Step 1: 실패 테스트 — 인자 최소 호출이 디스크 캐시를 자동 적용(파일 생성)함을 단언; `cache=None` 명시는 미적용
- [ ] Step 2: `_RESOLVE` + 빌더 4곳 해석 로직 + 루프 call site 단순화
- [ ] Step 3: `uv run --extra dev pytest tests/unit/api/ tests/hoga/api/test_bundle.py tests/test_api_range.py -q` 전부 PASS
- [ ] Step 4: 커밋 `refactor(api): 지표 빌더 캐시 게이트 자가-해석 — ADR-0043/0090 계약을 seam 안쪽으로 (WS3)`
