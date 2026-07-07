# WS4: 무제한 인메모리 캐시 상한 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. 체크박스 문법.

**Goal:** 장수명 프로세스에서 무한 성장하는 인메모리 캐시 3곳에 LRU 상한을 부여한다. 디스크 계층·정확성 계약은 불변 — 축출은 재읽기/재fetch 비용일 뿐.

**대상 (탐색 확정):**
1. `hoga/api/past_indicators_cache.py` — 디스크 캐시의 인메모리 오버레이 5개 dict(`_mem_ratio`/`_mem_fill`/`_mem_ask_peak`/`_mem_bid_peak`/`_mem_trade_volume_poc`), (Code×Stock-Date×source×bucket) 조합만큼 무한 성장. → OrderedDict + dict당 512 상한(생성자 `mem_max_entries` 주입 가능). 축출돼도 디스크 read-through로 값은 보존.
2. `hoga/live/index_minute_candles_cache.py` — exact-match dict가 (from,to) 조합마다 분봉 결과(수천 캔들)를 영구 축적. → OrderedDict LRU 64 (`max_exact_entries`).
3. `hoga/live/index_candles_cache.py` — per-key 배치 리스트 무한 append. 키 자체는 대표지수 5종으로 유계이므로 per-key 배치 수만 128로 캡(oldest drop → coverage 구멍은 covered()가 None을 돌려 재fetch로 회복).

**제외 (탐색 근거로 무변경):** `QueryEngine._stock_date_cache`(mtime 검증+prune 존재), `calendar._month_cache`(설계상 무제한 — per-month set 소형·유계), `TodayTtlCache`(TTL 자체 정리), `session_confirmed`(프로세스 러닝일수 유계).

### Task 1: PastIndicatorsCache 오버레이 상한 (+ 회귀 테스트)
### Task 2: IndexMinuteCandlesCache LRU (+ 테스트)
### Task 3: IndexCandlesCache per-key 배치 캡 (+ 테스트)

각 Task: 실패 테스트 → 구현 → 해당 스위트 PASS → 전체 스위트 → 커밋 1개로 합침 (3곳 모두 같은 성격의 소형 변경).
