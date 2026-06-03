# 아키텍처 Deepening — 설계 수렴 (improve-codebase-architecture)

**Date**: 2026-06-03
**Status**: Design (구현 미착수 — 별도 브랜치 예정)
**Method**: `/improve-codebase-architecture` — 3개 병렬 탐색 에이전트가 friction 발굴, 후보별 grilling으로 설계 수렴.
**Vocabulary**: architecture = LANGUAGE.md(Module/Interface/Depth/Shallow/Seam/Leverage/Locality/deletion test), domain = CONTEXT.md.

이전 아키텍처 리뷰(`docs/architecture-review-2026-05-30.md`)가 settled한 결정은 재litigate 안 함. 후보 2는 그 리뷰 *다음 날* 착지한 ADR-0055로 새로 생긴 중복.

---

## 후보 1 — Invariant 카탈로그 read-path seam leak (correctness teeth) ✅ 설계 수렴

### 검증된 전제 (1차 자료)
- **Write-path** `hoga/parser/__init__.py:165-172`: `_check_meta(meta) + _check_series(StockDateArtifacts(...))` → `meta["invariant_violations"]`에 archive.
- **Read-path** `hoga/api/disk_state.py:85-95` `classify_from_meta`: `check(meta)`(meta-only) 실행, error면 `INVALID`. **archived 필드·`check_series` 안 읽음.**
- **archived 필드 소비처**: grep 결과 `hoga/cli.py --fix`(forensic) **단 하나**. `disk_state`/`bundle`/`queries`/`routes` 0회.
- **단일 funnel 확인**: per-source 경로(`classify_stock_date`, ADR-0037)도 `classify_from_meta`에 위임 → 두 경로 모두 이 함수를 거침.
- **크래시 live 여부**: read-path가 candle `ts_ms` dedup 안 함(`candles.query_all`=`ORDER BY ts_ms ASC`만, `write_parquet`=sort만, `downsample_candles`=1m에서 그대로). 중복 ts_ms → `build_range_bundle` serve → lwc setData assert.

### Problem (vocabulary)
`invariants.py:3-9`·CONTEXT.md는 카탈로그가 "단일 진실원, 4 체크포인트가 같은 레지스트리 소비"라 주장하나 **절반만 사실**. **Invariant**가 meta/series로 나뉘어 **비대칭 소비**: write는 둘 다, read는 meta만. `series.candles_ts_monotonic`(severity=`error`, 차트 크래시 직접 원인)이 archive돼도 `DiskState`를 `INVALID`로 못 바꿔 `build_range_bundle`이 **Stock-Date**를 serve. **interface가 약속한 계약(`invariants.py:196-199` "read는 archived field를 trust")을 seam이 이행 안 하는 leak.** deletion test 역전: 버그가 *이미* "read-path가 더 작은 규칙셋을 재유도하는 방식" 안에 산다.

### Solution (설계 수렴)
- **위치:** `classify_from_meta` (단일 seam, 검증됨).
- **형태:** `live meta violations(check(meta)) + archived series.* violations`. archived `meta["invariant_violations"]`에서 **`id.startswith("series.")`만 필터**(meta는 live 재계산이 진실원이라 double-count 방지; series는 archived가 유일원 — parquet 재로드 회피로 per-request SLO 보존). error-severity 있으면 `INVALID`, `warn`은 `Classification.warnings`.
- archived dict는 `Violation.as_dict()`로 `severity=.value`(문자열) 저장 → 되살리기 가능(`Violation.from_dict` 또는 inline severity 비교).
- **stale 신뢰 정책 (사용자 결정):** archived as-is 신뢰 + `hoga validate --fix` 1회 sweep으로 수정 이전 false-positive 정리. 단일 사용자 로컬 툴(ADR-0036)이라 proportionate. (대안: version-gate self-healing — 분산 배포라면 그쪽.)

### Benefits
- *Locality:* INVALID 결정이 완전한 규칙셋으로 한 곳. write/read 비대칭이 다음 series error 추가자에게 silent trap이던 게 사라짐.
- *Leverage:* `Classification` 모든 소비자(bundle 제외·캘린더 마커·eligibility·inventory)가 즉시 series error 존중, per-caller 변경 0.
- *Tests:* archived series-error fixture(plain dict)로 `classify_from_meta(meta)` → `state==INVALID` 단위 테스트. 지금은 malformed parquet 작성→parser→`build_range_bundle` 구동이라야 증명 가능 → dict-in/state-out으로 붕괴.

### Side-effects (구현 시)
- **ADR-0020 amendment**: read-path가 archived series-error를 INVALID 게이트로 소비(의도된 갭 메우기, reopen 아님). stale 신뢰 정책(as-is + --fix) 명문화.
- **CONTEXT.md Invariant 항목**: "4 체크포인트가 같은 레지스트리 소비"가 series까지 *진짜*가 됨 — 현 비대칭 단서 제거.

### Risks / open
- write-path가 중복 ts_ms parquet을 **애초에 쓰는지**(쓰면 활성 버그, 안 쓰면 defense-in-depth) — 구현 시 parser 동작 확인. 어느 쪽이든 fix는 가치 있음.

---

## 후보 2 — 일봉/투자자-net 핸들러 + KIS client walk-back 쌍둥이 ✅ 설계 수렴

### 검증된 전제 (1차 자료)
- `hoga/live/api.py:384-497`(`_get_past_daily_candles`) vs `:499-614`(`_get_past_investor_net`): near-verbatim. 차이 = `daily_cache_instance`/`investor_cache_instance`(같은 `PastDailyCandlesCache` 클래스), `kis.fetch_past_daily_candles`/`kis.fetch_investor_net`, `_candle_to_dict`/`_investor_point_to_dict`, `result.candles`/`result.points`, output key `"candles"`/`"points"`, 503 메시지, 지역변수명.
- **에이전트 오류 정정:** 에이전트가 주장한 `fresh_batches` drift(일봉만 비거래일에 append)는 **실재 안 함** — 투자자도 `:584-585`에서 append. 현재 drift 버그 없음. 중복 자체(+테스트 중복)만 실재.
- KIS client `kis_client.py:646-776` vs `793-891`: 60-iter cursor walk-back skeleton(seen set·page_progress·termination triple·cursor decrement) 동일; per-row parse + violation taxonomy만 다름.

### Problem (vocabulary)
**Live Candle Backfill**(일봉)과 **Live Investor Net**가 gap/cache/today-tristate/dedupe orchestration을 복붙(missing **locality**). deletion test: 투자자 핸들러 삭제해도 동일 조립이 30줄 위 일봉 핸들러에 재출현 → 복잡도 집중. **two real callers**라 `be-live-02`(minute, single-caller) 기각과 다름. 캐시는 *이미 공유*(ADR-0055) → seam 반쯤 지어짐.

### Solution (결정: closure 시드 + 양 층)
- **핸들러 seam:** deep orchestrator `batched_daily_walkback(cache, fetch_batch, output_key, *, code, frm, too, today_d) -> dict`. adapter가 `fetch_batch:(code, from_s, to_s) -> Awaitable[(rows:list[dict], violations)]` 클로저 하나 제공(새 타입 0). orchestrator가 gap-intersect/per-gap fetch+rate-limit·api-error/today tri-state/dedupe·sort·filter/output_key 전부 소유. 두 라우트 = ~10줄 adapter.
- **client 층도:** `_walk_back_daily(path, tr_id, base_params, *, from_yyyymmdd, to_yyyymmdd, parse_row)` driver가 60-iter cursor 루프·`seen`·`page_progress`·`cursor_to` decrement 소유, 주입된 `parse_row(row) -> Result | Violation` 호출. 두 public 메서드는 distinct parse closure 유지(두 real adapter).
- **위치:** 새 모듈 `hoga/live/daily_backfill.py`(핸들러 orchestrator) + `kis_client.py` 내부 private driver.
- **결정 근거:** closure가 최소(Protocol+result 타입 불필요), 양 층은 같은 중복의 두 켜라 함께. minute 핸들러 제외(`be-live-02` 보존).

### Benefits
- *Locality:* gap→fetch→dedupe 한 곳, 비대칭 재발 불가. client walk-back 종료 off-by-one(`<= from` 경계 + fixture-replay `page_progress=False` 가드)을 한 곳에서.
- *Leverage:* 세 번째 일별 시리즈(KIS가 이미 주는 won-value net 등)=10줄 adapter.
- *Tests:* orchestration이 fake `fetch_batch`로 **1회**(지금은 route-driving ×2, 투자자 테스트가 일봉 테스트 verbatim 복사 — `test_api.py:547-781` vs `782-949`); 각 라우트는 얇은 adapter smoke; client 루프 종료/decrement를 trivial fake `parse_row`로 격리.

### Side-effects (구현 시)
- ADR 불요(ADR-0055 reuse 의도 *완성*, 충돌 없음). CONTEXT.md 변경 불요(mechanism, 도메인 용어 아님).

---

## 후보 3 — Source 우선순위가 불일치하는 4 resolver에 흩어짐 ✅ 설계 수렴

### 전제 (에이전트 증거, 구현 시 재확인)
"(date, code)에 어느 **Source**가 이기나"의 공유 정책 없이 4곳이 *다른* tie-break: `queries.py:154-173`(`_find_winning_meta`, kis_live **제외**) · `:272-311`(pref→flat→any) · `sources.py:22-46`(`resolve_source`, `next(iter())`) · `disk_state.py:229-255`(COMPLETE-wins). bundle.py 슬라이스마다 존재가드 5회(`:105/128/182/245/313`). 확인된 drift: kis_live COMPLETE + hogaplay 부분-incomplete가 resolver마다 다르게 분류; kis_live-only는 inventory invisible.

### Problem (vocabulary)
deletion test **통과** — 규칙이 이미 4번 재출현(흩어진 복잡도). 공유 정책 모듈이 없어 각 resolver가 자기 precedence를 hard-code. bundle.py의 반복 존재가드는 "resolved-source 객체를 thread할 seam이 없어서" 생기는 downstream 증상.

### Solution (결정: 정책 모듈 + 타입드 accessor, 동작 보존)
- Source 우선순위 **정책 모듈** 하나가 ordering(pref→fallback chain→kis_live-eligibility)을 소유. 4 accessor는 **위임**: `resolve_source`(→SourceName), `resolved_parquet_dir`(→Path|None), `winning_meta`(→dict), `aggregate_state`(→DiskState). god-function로 합치지 **않음**(서로 다른 질문 — 다른 반환 타입 유지). bundle 슬라이스 빌더는 pre-resolved `(source, dir)`를 받아 반복 존재가드 제거.
- **kis_live 제외**가 `_find_winning_meta` docstring에 묻힌 암묵 비대칭 → 명시적 **policy flag** 1개로.
- **결정: 동작 보존**(현 precedence를 그대로 중앙화). "kis_live-only Stock-Date가 inventory invisible"은 **별도 product 결정**으로 표면화하되 이 deepening에서 행동 변경 안 함(seam 만들고, product 결정은 분리).

### Benefits
- *Locality:* "어느 source가 이기고 kis_live가 eligible한가"가 한 곳(지금 4파일 4관용구). 세 번째 source 추가 = 1곳.
- *Leverage:* bundle 빌더가 resolved `(source,dir)` 받아 guard 삭제.
- *Tests:* precedence가 `{source: state}` dict 위 순수함수 — 디스크 트리 없이. 지금은 2개 source subdir를 tmp에 짓고 4 함수가 불일치함을 봐야 증명.

### Side-effects (구현 시)
- ADR-0037/0039가 *가정*하는 단일 규칙을 **구현**(reopen 아님). kis_live-inventory-invisibility를 latent product gap으로 issue 등록 권장(이 작업에서 고치진 않음).

---

## 후보 4 — 차트 viewport/backfill orchestration이 deep module 아니라 effect-sprawl (프론트 flagship) ✅ 설계 수렴

### 전제 (이번 세션 1차 지식 — 직접 구현함)
`LiveChartRoot.tsx`에 4개 얽힌 effect(lazy-fetch 핸들러 `:484-531`·prepend-restore `:273-327`·settle-loop `:333-365`·initial-view `:196-237`) + 공유 ref 5개 + store 필드가 하나의 암묵 state machine. 순수 커널(`liveDateTime.ts:154-201` `nextHistoricalFrom`/`planFillStep`/`stepChunkDays`)은 깨끗·table-tested지만, **그걸 호출하는 orchestration**은 effect-sprawl이고 lightweight-charts mock(`LiveChartRoot.test.tsx`의 `getVisibleLogicalRange` `+5000` re-anchor 가짜)으로만 테스트됨.

### Problem (vocabulary — 본 스킬 핵심 패턴)
"좌측 팬 prepend가 viewport를 어떻게 보존하나" 한 개념 이해에 5개 결합 채널(handler→store→`useLiveBundle` `isExtending`→restore→settle)을 오가야 하고, 정확성이 **effect 선언 순서**(settle은 restore 뒤)와 **parent-vs-child effect 순서**에 의존하는데 prose 주석에만 있음. "**순수 커널은 추출됐으나 진짜 버그는 그걸 호출하는 imperative effect에 숨는**" 교과서 케이스(이번 스킬이 본 영역에서 지목한 바로 그 패턴). caller 1개라 **leverage는 modest(정직히)** — 진짜 win은 **locality + test surface**("the interface is the test surface").

### Solution (결정: headless ViewportBackfillController — 단, 신중·후순위)
- headless **viewport/backfill 컨트롤러** 추출(팀이 `useDrawingHost`로 이미 검증한 move). anchor 캡처·prepend 감지·logical-shift 수학·settle 결정·step 부기를 얇은 **TimeScale port**(쓰는 chart 연산만: `getVisibleRange`/`getVisibleLogicalRange`/`timeToIndex`/`setVisibleLogicalRange`/`scrollToPosition`/`subscribe…`) + `VirtualAxis`(이미 있는 stable seam)로 구동. `LiveChartRoot`엔 chart 생성·port 전달·pane 마운트만.
- **second adapter = test fake**(production=lwc)가 정당한 two-adapter 근거. 차트 라이브러리 교체용 seam은 *아님*(그건 hypothetical).
- **결정: 넷 중 가장 크고 회귀 위험 높음**(방금 착지한 코드를 건드림). 전제조건: **Task 8 수동 QA 통과 후**(미검증 동작 위에 리팩터 금지) + 기존 LiveChartRoot 테스트 + 새 progressive-fill 테스트를 안전망으로. 우선순위는 1·2·3 이후.

### Benefits
- *Locality:* prepend-보존 불변식(anchor→detect→shift→settle + 순서 규칙)이 한 모듈에 top-to-bottom.
- *Tests:* port 호출 시퀀스 스크립트("팬→bundle 성장→settle")로 emit된 `setVisibleLogicalRange` shift 단언 — `render()`·`createChartEx` mock·lwc `setData` re-anchor 가짜 불필요.

### Side-effects (구현 시)
- ADR 불요(SR-3 의도 *완성* — `LiveChartRoot.tsx:515-518` "effect는 imperative shell만"에 집을 줌). 후보 2 프론트 state-machine 분산(historicalFromDate write/read-back)을 이 컨트롤러가 흡수.

---

## Minor (full candidate 미만, 기록만)
- **5. HHMMSSmmm 디코드 3중 중복:** `timeenc.py:29-39`·`:47-89`(SQL) + `disk_state.py:264-276`("Mirrors the SQL" 주석). canonical Python 1개 + SQL parity test(경계 입력 `...59999→...100000`·hour rollover)로. ADR-0003 구현 DRY(reopen 아님).
- **6. `buildLiveBundle` segment 합성:** `:82-134`이 `VirtualAxis.contains` 필터 만족시키려 segment 합성(builder가 다른 모듈 predicate를 forward-reach) + Half-Day footgun(`:123-124` 고정 6.5h) 재유입. candle-admissibility 규칙을 단일 소유(axis가 candle array에서 직접 coverage 유도)로. ADR-0040 의도 정합.
- **(비후보) `paneSpecsForTimeframe`** `LiveChartRoot.tsx:539`·`:621` 2회 동일 호출 → memo 1개로 drift 위험 제거.

## 우선순위 (제안)
1. **후보 1**(correctness teeth) → 2. **후보 2**(저위험·테스트 중복 ×2 제거) → 3. **후보 3**(drift 위험·중간) → 4. **후보 4**(최대·flagship, Task 8 QA 후). 1·2·3은 백엔드라 한 묶음, 4는 프론트 별도.
