# KIS 제거 · 키움 전면 대체 — PR 분할 플랜

- 근거 ADR: [0136](../adr/0136-kis-removal-kiwoom-full-replacement.md)
- 지도: [#1005](https://github.com/Soochol/hoga-ops/issues/1005) — 조사 4건·결정 5건 전부 해소
- 작성: 2026-08-03 ([#1016](https://github.com/Soochol/hoga-ops/issues/1016))

## 원칙 셋

1. **이관 PR 은 KIS 코드를 지우지 않는다.** 키움으로 갈아끼우기만 하고, 삭제는 **마지막 PR-J 하나**에 모은다. 그래야 각 이관 PR 이 독립적으로 revert 가능하고, 되돌림 노브를 따로 만들 필요가 없다(#686 의 "fix-forward, 킬스위치 불제작" 을 구조로 달성).
2. **seam·거버너가 모든 이관보다 먼저.** 순서를 뒤집으면 12개 TR 이 각자 유량을 모른 채 같은 버킷을 두드리는 상태로 착지한다.
3. **표면별 컷오버.** prod 가 가동 중이므로 한 번에 갈아엎지 않는다. 표면 하나씩, 각 PR 이 자체 검증을 갖는다.

## 선행 (이관 전)

### PR-A — 브로커 중립 타입 이사 ✅ **[#1022](https://github.com/Soochol/hoga-ops/pull/1022) 로 존재**

`candle_models`(`LiveCandle`·`IndexCandlePoint`) / `investor` / `venue`(`Venue`) 신설, `kis_models` 삭제, `KIS_KST` 소멸. **동작 변경 0.** ADR-0116 규율 1 위반(`kiwoom_index_candles` → `kis_models`)도 해소한다.

### PR-B — 키움 REST seam + TR별 유량 거버너

ADR-0136 §2 의 구현. **이 지도에서 가장 큰 단일 PR.**

- 선언적 TR 스펙 테이블 `(api-id, path, 래퍼 키, 필수 파라미터, 응답 모양, 커서 지원, 반환 어댑터)`
- 단일 호출기 `call()` / 커서 워커 `walk()` — **응답 모양 두 갈래**(`list` 래퍼 키 / `flat` 최상위) 모두 처리
- 단일 우선순위 큐 + **TR별 토큰 버킷(5 req/s)** — 기계 **넷**: 2단 우선순위 · 중복제거 · **승격** · **양보**
- `httpx.AsyncClient` 통일. 기존 3모듈(`kiwoom_index_candles`·`kiwoom_rankings`·`kiwoom_stock_info`) 이주
- 에러 분류기: **HTTP status + `return_code` 두 축**(429 만 HTTP 레벨)
- 테스트 이음매 2층: 큐 제출 함수 1곳 몽키패치 / `httpx.MockTransport`
- 거버너 `snapshot()` — 큐 깊이·대기시간·TR별 카운트

**검증**: 기존 3모듈 테스트 그린 유지 + seam 자체 테스트(양쪽 응답 모양·커서·429 분류·승격·양보).

## 표면별 이관 (PR-B 후, 서로 독립 — 순서 무관)

각 PR 은 ①키움 어댑터 추가 ②소비자 배선 전환 ③KIS 경로는 **그대로 둠** ④검증.

| PR | 표면 | 키움 TR | 주의 |
|---|---|---|---|
| **PR-C** | 지수 현재가·일봉 | `ka20001` · `ka20006` | `ka20001` 이 **시각별 20행**을 주므로 스냅샷 반환 어댑터 필요. `ka20005`(분봉)는 이미 이관됨 — **가장 쉬운 표면이므로 첫 이관 권장** |
| **PR-D** | 관심종목 복수시세 | `ka10095` | `stk_cd` 를 `\|` 로 복수 지정. **배치 상한 미측정**(3종목만 확인) — 이 PR 에서 실측할 것 |
| **PR-E** | 투자자 3종 | `ka10059`·`ka10051`·`ka10064` | `ka10051` 은 `base_dt` **하루치**라 N일 = N콜(KIS 는 시계열) → 콜 수 증가. `ka10064` 가 장중 추정(`tm`↔슬롯) |
| **PR-F** | 과거 일봉 | `ka10081` | `upd_stkpc_tp` **1=수정/0=원주가** — `screener_backfill.py:257,272` 의 2벌 요구 충족. 600행 ≈ 2.4년 |
| **PR-G** | 과거 분봉 + 팬 | `ka10080` | **두 번째로 큰 PR.** ADR-0136 §3 커서 규칙. 아래 체크리스트 필수 |
| **PR-H** | 거래일 달력 | 지수 일봉 역산 | 결과를 **리포에 커밋**. `calendar.py` 의 `_month_cache`·`TradingDayUnavailableError` 계약 재정의 |
| **PR-I** | 종목 마스터 | `ka10099` + 시드 | **캐시 schema bump 필수**(아래) |

### PR-G 체크리스트 (과거 팬)

- 커서 = **응답의 최古 날짜**. 캐시에 넣지 않고 다음 `base_dt` 로 재사용
- **진행 보장 가드**: `다음 커서 == 현재 커서` 면 중단 — 조사 실험이 이 가드 없이 무한 루프에 빠졌다
- **`_MAX_PAGES` + `out_of_range` violation** — 조용한 절단 금지(`kiwoom_index_candles` 선례)
- 완결성 판정에 **봉 개수·첫 봉 시각 금지** — 333봉 정상일·`09:02` 개장일 반례
- `past_candles_cache` 는 **memory-only 유지**(ADR-0095 재확인)

### PR-H 세부 (달력)

- 시드 범위(2007년부터 전량 vs 최근 N년), 파일 위치·형식
- 갱신 주체 — 스케줄러 편승 권장(새 거래일은 하루 하나)
- **#976 의 "영구 결여는 평일 폴백 · 일시 장애는 fail-fast" 재정의** — 정적 소스에는 "일시 장애" 가 없으므로 **폴백 자체가 불필요해질 가능성이 크다**
- `is_trading_session_today` 의 오늘 판정 경로 유지

### PR-I 세부 (마스터)

- **캐시 schema bump 필수** — 기존 캐시에 `Q` 접두 ETN **380건**. bump 없이 전환하면 stale 은 `Q500061`, 새 fetch 는 `500061` 을 주어 **검색 결과가 이원화**된다
- ETN `Q` 접두 정규화 (저장 상태 노출은 실측 **0건** — watchlist·heatmap·캡처 전부)
- `mrkt_tp` **두 번 호출**(`0`/`10`)로 시장 태깅 — 시장은 응답이 아니라 요청이 결정
- `marketCode` → `security_type`(`8`=etf · `60`/`90`=etn · 나머지 stock), SPEC 밖(리츠·외국주·인프라) 필터
- 부트스트랩 시드 스냅샷을 리포에 커밋(403 KB) — **가끔만 갱신**, 최신화는 런타임

## 최종

### PR-J — KIS 삭제

**모든 이관 PR 이 안정화된 뒤 한 번에.** 삭제 표면은 [#1010 전수조사](../research/2026-08-03-kis-removal-surface.md)가 이미 목록화했다.

- **A 분류 1,574줄** — `kis_endpoints`(1162)·`kis_token_provider`·`kis_account_pool`·`kis_errors`
- **B 분류 1,279줄** — `kis_client`·`kis_capacity_scheduler`·`kis_runtime`·`kis_access`·`kis_capacity_runtime` (PR-B 가 대체물 제공 완료 전제)
- **D 분류** — `kis_holidays`(PR-H 후) · `kis_master`(PR-I 후)
- **잔존** — `kis_venue` 의 `_KIS_DIV` 등 KIS wire 인코딩도 이때 함께 삭제
- **테스트**: 전용 20파일 / 5,317줄 / 218 함수 삭제 + 간접 75파일 수정
- **프론트**: 배너 문구 · `KisRestUnavailableToastHost` 컴포넌트 전체 · `DataSourceDetail` 패널 재설계 · `state/kisRestMode.ts` + localStorage 2키 정리 · **`reason` 유니온 4곳**(유니온에서 KIS 값을 지우면 누락 문구가 **컴파일 에러로 잡힌다** — 이관 체크리스트로 활용)
- **관측**: `kis_calls_today`/`kis_rate_limit_remaining` **삭제**(죽은 필드), 거버너 `snapshot()` 노출 범위 결정
- **설정**: `kis_rest_bypass_enabled` — API·**디스크 영속 설정**·프론트 토글 전부. 기존 설정 파일에 남은 키 처리
- **에러 코드 4종** · `.env.example`/`README`/`CLAUDE.md` **20건**
- **`test_adr_invariants.py` `_HOT_PATH_MODULES`** 동반 수정 — 안 고치면 설계된 대로 시끄럽게 실패한다
- **ADR supersede 명시** — 0100 · 0109 · 0116/0118 의 REST 절 · 0120. ADR-0121 은 개정(`kis_api` 단이 legacy 읽기 전용)

## 검증 게이트 (모든 PR 공통)

```bash
uv run --extra dev ruff check . && uv run --extra dev pytest -q -m 'not wallclock'
cd frontend && npm run typecheck && npx vitest run && npx vite build
```

프론트 변경이 있는 PR 은 e2e 도 확인한다. `main protection` 이 `strict_required_status_checks_policy=true` 이므로 머지 전 브랜치를 main 최신으로 올려야 한다.

## 되돌림

**표면별 revert 가 되돌림 수단이다** — 이관 PR 이 KIS 코드를 지우지 않으므로(원칙 1) 문제가 생기면 그 PR 하나만 되돌리면 KIS 경로가 그대로 살아난다. **별도 킬스위치·env 토글·이중 배선은 만들지 않는다**(#686 선례).

PR-J 이후에는 되돌림이 없다 — 그 시점에 각 표면이 이미 안정화됐다는 것이 전제다.

## prod 접점

prod 전환(#997)이 선행된 상태를 전제한다(지도 Notes). 표면별 컷오버이므로 **수집 공백은 각 PR 배포 순간의 재기동뿐**이고, 실시간 WS 는 이 지도의 범위 밖이라 영향이 없다.

## 미해결 — 착수 전 확인

- **`base_dt` 의 공식 문서화 여부.** 과거 팬 설계 전체가 이 파라미터 위에 선다. 실측으로 작동은 확인했으나 공개 카탈로그에 없었고 ADR-0120 도 "없다" 고 기록했다. **PR-G 착수 전 키움 공식 문서 확인 필수.**
- `ka10095` 배치 상한 → PR-D 에서 실측
- `유량=5` 가 모든 TR 에 동일한지 → 거버너 버킷을 **TR별 설정값**으로 열어둔다
- 앱키당 유량 독립 여부 → 증설 시 최우선 확인
