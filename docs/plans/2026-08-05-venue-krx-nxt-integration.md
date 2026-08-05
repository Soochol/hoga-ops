# venue 3옵션 + NXT·통합 저장 — PR 분할 플랜

**근거:** [ADR-0140](../adr/0140-venue-krx-nxt-integration.md) · 웨이파인더 맵
[#1104](https://github.com/Soochol/hoga-ops/issues/1104)

**순서 원칙 — 저장이 표시보다 먼저다.** hogaplay 업스트림이 정규장 KRX만 보유하므로 NXT·통합의
유일한 사본은 우리 WS 캡처다. 표시는 나중에 붙여도 과거 데이터가 기다리지만, 저장은 하루 늦으면
하루만큼 영구 결손이다.

---

## PR 목록

| PR | 제목 | 선행 | 캡처 인접 | 장중 검증 |
|---|---|---|---|---|
| **A** | 호가창 21행 + `중` 행 | 없음 | — | — |
| **B** | `VENUE_SUFFIX` 통합 + `_AL` 인식 | 없음 | — | — |
| **C** | 자료구조 `(code, venue)` 키잉 | B | ⚠ | — |
| **D** | 저장 레이아웃 venue 세그먼트 + 마이그레이션 | C | ⚠ | — |
| **E** | `nxtEnable` 마스터 확장 + source 레벨 meta | D | — | — |
| **F** | 동시 구독 + 시분할 폐지 | C·E | ⚠⚠ | ✅ |
| **G** | 저장 창 확대 + venue별 완결 판정 | D·E·F | ⚠⚠ | ✅ |
| **J** | API 표면 venue 전파(`/api/range`·거래원·투자자) | D | — | — |
| **H** | 프론트 3옵션 + `liveVenueAcceptsFrame` 재정의 | F·**J** | — | — |
| **I** | 보관함·`/study` venue 축 | D·E·H | — | — |

---

## PR-A — 호가창 21행 + `중` 행

**venue 와 무관하게 단독 랜딩 가능하다.** 지금 `BookPanel`은 `asksDesc`(10)와 `bids`(10)가
중앙 가격축에서 맞붙어 있어 스프레드를 보여줄 자리가 없다. 키움 앱은 KRX 단독 화면에도 `중`
행을 갖는다.

- `BookPanel.tsx` 중앙 가격축에 중간 행 삽입: `(매도1 + 매수1) ÷ 2`
- `중` 뱃지로 주문 가능한 호가와 구분
- 전 venue 공통 — 이 PR 시점에는 KRX 하나뿐이지만 구조가 먼저 선다

**검증:** vitest + 시각 확인. 캡처 경로 무관.

## PR-B — `VENUE_SUFFIX` 통합 + `_AL` 인식

⚠ **지뢰 제거.** 같은 이름의 상수가 둘인데 서로 다르다:

| 위치 | 값 |
|---|---|
| `kiwoom_fields.py:114` (WS `split_venue`) | `{"_NX": "NXT"}` ← `_AL` 없음 |
| `kiwoom_multi_quote.py:46` (REST) | `{"KRX":"", "NXT":"_NX", "UN":"_AL"}` |

`split_venue("005930_AL")` → `("005930_AL", "KRX")` — 접미가 안 벗겨지고 venue가 오분류된다.

- **정본 = 새 모듈 `hoga/live/kiwoom_venue.py`** (키움 wire venue 인코딩 전용). 후보 소거:
  `venue.py` 는 docstring 이 wire 인코딩을 **명시적으로 배제**하고, `kiwoom_fields` 는 *WS FID* 전용인데
  접미는 REST(`stk_cd`)에도 실리며, `kiwoom_multi_quote` 는 **기능 모듈에 상수가 얹힌 꼴**이다
  (캔들 모듈 둘이 멀티쿼트가 필요해서가 아니라 상수만 빌리려고 import 한다)
- `kiwoom_fields`·`kiwoom_multi_quote`·`kiwoom_daily_candles`·`kiwoom_minute_candles` 가 전부 여기서 import
- `split_venue` 가 `_AL` → `UN` 을 인식. ⚠ 접미 매칭 순서 — `""`(KRX)는 모든 문자열에 매치되므로 **마지막**
- `WsTick.venue` 가 `"UN"` 을 가질 수 있게 되므로 타입·소비자 점검

**검증:** 단위 테스트에서 `split_venue ∘ apply_venue = 항등`을 세 venue 전부에 대해.

## PR-C — 자료구조 `(code, venue)` 키잉

⚠ **캡처 인접.** `stream.py:388` 가드가 가려 주고 있을 뿐, 네 구조가 전부 bare code로 키잉돼
있다.

- `TickDownsampler._codes: dict[tuple[str,str], _CodeState]`
- `MinuteCandleAggregator._codes: dict[tuple[str,str], dict[int,_Bar]]`
- `_ask_peak_state(code, venue)` / `_bid_peak_state(code, venue)`
- `SignalAlertMonitor.ingest_orderbook(..., venue)`
- **조회 표면까지 전파**: `lifecycle.get_today_ask_peak(code)` → `(code, venue)`
- `set_active_codes` · `reset` 의 수명 규칙도 `(code, venue)` 단위

**이 PR 시점에는 KRX 틱만 흐른다**(가드는 PR-F에서 삭제) — 즉 **동작 변화 0**이어야 한다.

**검증 (필수):** KRX 단독 입력에 대해 개정 전후 출력이 동일함을 회귀 테스트로. 그리고 실제
거래일 하나를 골라 **개정 전후 KRX parquet 행 단위 대조**(행 수·`ts_ms`·값 전부 일치).

## PR-D — 저장 레이아웃 venue 세그먼트 + 마이그레이션

```
parquet/{date}/{code}/kiwoom_live/{venue}/{file}.parquet
live_kiwoom/{date}/{venue}/{code}.jsonl
```

- `SOURCE_HAS_VENUE: dict[SourceName, bool]` 신설 — `kiwoom_live` 만 `True`
- 경로 조립부 **11곳 / 6파일**에 venue 인자 추가(필수 인자 — 빠뜨리면 즉시 터지게):
  `promote.py:500` · `queries.py:56` · `sources.py:194·202·252` · `screener_depth.py:118` ·
  `past_indicators_cache.py:244` · `meta_backfill.py:109·125`
- ⚠ `past_indicators_cache.py:292·367`은 `kis-past-indicators` 트리라 **parquet 트리가 아니다**
  — venue 축을 가질지 별도 판단
- `sources.py` 사다리가 venue를 **경쟁자로 보지 않게** 개정
- `cli.py:499-521` `iter_meta_paths` 가 2단 meta 를 구분
- **마이그레이션 스크립트**: `kiwoom_live/*` → `kiwoom_live/KRX/*` (2,694 디렉터리 rename)
  + **역방향 스크립트**
- JSONL 은 날짜 경계 컷오버(마이그레이션 불요, 보유 2일)

**검증:** 마이그레이션 dry-run → 실행 → `analyze_gaps` 가 이전과 동일한 결과. 역방향 스크립트도
왕복 테스트.

## PR-E — `nxtEnable` 마스터 확장 + source 레벨 meta

- `MasterRow` 에 `nxt_enabled: bool`, `parse_row` 가 `nxtEnable == "Y"` 로 채움
- **시드 `schema_version` 3 → 4 필수** — 행이 4-tuple → 5-tuple 이므로 `load_seed` 언패킹도
  함께. bump 없이 배포하면 ETN `Q` 접두 때 캐시가 이원화됐던 자리를 반복한다
- `kiwoom_live/meta.json` 신설: `nxt_enabled`(캡처 시점 as-of) · `expected_venues`
- 판별 실패 기본값은 **"모름"이지 "미상장"이 아니다**

**검증:** 시드 왕복 + 미상장 판정 규칙 단위 테스트(4경우 전부).

## PR-F — 동시 구독 + 시분할 폐지

⚠⚠ **최대 리스크. 장중 검증 필수.**

- `stream.py` 의 `venue != "KRX"` 가드 **2곳 삭제**(`:359` PROGRAM · `:388` 성역)
- 구독 파생식을 `{(c,KRX)} ∪ {(c,NXT)|nxt_enabled} ∪ {(c,UN)|nxt_enabled}` 로
- `target_ws_venue`(프로덕션 12·테스트 11) · `AUTO_VENUE` 제거
- `_covered_by_storage` 시각 무관화
- `in_krx_warmup_window` · `_check_warmup_locked` 는 **삭제가 아니라 일반화** — 스왑 특례는
  죽지만 등록 완결 리스크는 남고 창이 연결 창 전체로 넓어진다. `_resubscribe_missing_locked`
  (30s)가 상시 수행. ⚠ **ACK는 유효성을 보증하지 못하므로**(미상장 코드도 `rc=0`) 실효 판정은
  **틱 유입**이어야 한다
- 620 종목 초기 등록: 계정당 ~155, 배치 50 · `_REG_PACING_S=0.35` → 계정당 4 REG ≈ 1.4초
  (실측 800종목 17초 대비 여유)

**검증 (장중):** ① KRX 정규장 캡처가 이전과 동일(행 단위 대조) ② 세 venue 틱이 전부 유입
③ `nxtEnable=false` 98종에 `_NX`/`_AL` 구독이 없음 ④ 09:00 전 등록 완결.

## PR-G — 저장 창 확대 + venue별 완결 판정

⚠⚠ **장중 검증 필수.**

- 저장 게이트를 venue별로: KRX 정규장 09:00–15:30 / NXT·UN 연결 창 08:00–20:00
- 게이트 전환·drain 이 venue 별로 갈린다(`stream.py:519`)
- carry 행 표식
- `_collection_finished` → `expected_venues` 전부 닫힘 기준
- NXT 예상체결(23/24) 저장 허용, 표시 게이트는 유지

**검증 (장중):** ① 08:00~09:00 NXT 행이 쌓임 ② 15:30 이후 KRX 행이 안 쌓임 ③ 20:00에 NXT
종료 ④ 15:35에 COMPLETE 가 **뜨지 않고** NXT 마감 후에 뜸 ⑤ 디스크 증가가 추정치(639~727MB)
범위.

## PR-J — API 표면 venue 전파 (`/api/range`·거래원·투자자)

**저장에 venue 축이 생기면 읽기 API 가 "어느 venue 를 읽을지"를 받아야 한다.** 지금은 그
파라미터가 아예 없다 — `/api/range` 에 `source_pref` 는 있는데 venue 는 없다([routes.py:334]).

### 왜 별도 PR 인가 — 하나가 지표 6~7개를 실어 나른다

`/api/range` 가 매물대(`trade_volume_poc`·`volume_distribution`) · 최대벽(`ask_peaks`·`bid_peaks`) ·
프로그램매매 · depth 히트맵 · 잔량 증감 · 거래원 늦은 진입을 **한 번에** 실어 온다. PR-D 에
얹으면 저장 마이그레이션 PR 이 지표 7개 표면까지 건드리게 된다.

### ⚠ 안 하면 생기는 일 — "지원 안 됨"이 아니라 **조용히 틀린 차트**

실시간 꼬리는 `useLiveBundle` → `liveVenueAcceptsFrame` 으로 venue 필터가 걸리고, 과거 본체는
`/api/range` 를 타서 KRX 로 고정된다. → **한 차트 안에서 앞부분 KRX + 꼬리 NXT.**

### 대상

| 모듈 | 현재 venue |
|---|---|
| `api/range.ts` ↔ `/api/range` | **0** — 지표 6~7개 |
| `api/brokerSeries.ts` | **0** — ⚠ #1112 가 *"거래원은 venue 선택기를 따른다"* 고 결정했는데 API 가 안 받는다 |
| `livePastInvestorNet.ts` · `liveInvestorTrendEstimate.ts` | **0** |
| `liveRankings.ts` | 0 — venue 축 필요 여부 판단 |

### venue 가 **필요 없는** 것 (구조적 — 손대지 않는다)

`liveStockLimits`(상한가·하한가는 종목 단위, 실물 앱에서 KRX·NXT 동일값 확인) ·
`liveViStatus`(**NXT 엔 VI 가 없다**) · `marketIndexQuotes`·`indexSectorRankings`·`optionSentiment`
(종목 venue 무관) · `screenerDailyCandles`(KIS 일봉, venue 축 없음).

### 규율

- venue 는 **필수 파라미터**로 둔다. 기본값 `"KRX"` 는 호출자가 빠뜨렸을 때 조용히 KRX 를 주는
  silent 실패이고, 이 플랜이 일관되게 기각해 온 형태다(PR-D 의 경로 헬퍼 필수 인자와 같은 규율).
  호출자는 전부 우리가 통제한다
- ⚠ **기존 엔드포인트 기본값 재검토** — `live/api.py:2061·2145·2339·2412` 가 `Query("KRX")` 로
  조용한 기본값을 갖는다. 새 것만 필수로 하면 규율이 갈린다
- **프론트 쿼리 키에 venue 포함** — `livePastCandles` 가 이미 그렇게 한다(`[code, from, to, venue]`).
  안 넣으면 venue 를 바꿔도 캐시가 안 갈려 **이전 venue 데이터가 그대로 보인다**
- `_resolved_parquet_dir` 가 venue 를 받아 `sources.py` 사다리에 넘김

**검증:** venue 를 바꿔 가며 같은 종목·날짜를 조회해 **세 응답이 서로 다름**을 확인(같으면 전파가
안 된 것). 미상장 종목에 NXT 를 요청하면 빈 응답 + 사유(#1109 판정 규칙).

## PR-H — 프론트 3옵션 + `liveVenueAcceptsFrame` 재정의

- `LIVE_VENUE_OPTIONS = ['KRX','NXT','UN']`, 라벨 `{KRX,NXT,통합}` — **'시간대 자동' 삭제**
- ⚠ `migrateStoredVenue` 의 `'NXT'→'UN'` **제거**
- `liveVenueAcceptsFrame` 태그 직결(**`tMs` 인자 제거**) — 소비자 **7곳/4파일** 동시 파급:
  `liveSidebarAdapters.ts:26·40` · `useLiveBundle.ts:122·214` · `liveTickOverlay.ts:122·153` ·
  `deriveCurrentPriceLine.ts:41`
- **`tagVenue` 를 명명 타입으로 승격** — 지금은 같은 유니온이 인라인 리터럴로 **4곳**에 흩어져 있다
  (`liveVenuePolicy.ts:102` · `liveTickOverlay.ts:118·152` · `livePastCandles.ts:253`). `'UN'` 추가 시 하나를
  빠뜨리면 **타입 에러가 안 나고** `as` 캐스팅이라 런타임에 UN 프레임이 조용히 걸러진다
  → `export type LiveFrameVenue = 'KRX' | 'NXT' | 'UN'` 신설 + **`as` 캐스팅 제거**(스냅샷 타입에 실제 선언)
- `liveSubscriptionVenueForMs` · `liveHogaVenueNow` · 상태바 호가 배지 제거
- `DataSourceDetail` 설명문 반전
- 통합 호가는 `_AL` 직결, 교차 시 **경고 없음**

⚠ **시그니처 변경이 7곳에 동시에 퍼지므로 단일 PR 로 묶는다.** 쪼개면 중간 상태가 컴파일되지
않는다.

**검증:** typecheck 3프로젝트 + vitest + e2e. UI 문구 변경은 e2e 셀렉터를 깨뜨리므로 문구 대신
`data-*` 원값 셀렉터를 쓴다.

## 선행 결정 하나가 남아 있다 — [#1132](https://github.com/Soochol/hoga-ops/issues/1132)

**히트맵·스크리너는 전역 `useLiveVenueStore` 를 이미 공유한다**(`Heatmap.tsx:39` · `useScreenerRowsLive.ts:35` ·
`useScreenerMonitor.ts:54`). 즉 PR-H 가 3옵션을 켜는 순간 **아무도 결정하지 않았는데 두 화면의 동작이 바뀐다.**
히트맵 272종 중 **98종(36%)은 NXT 데이터가 없어** 셀이 비는데, 히트맵은 "잔량이 없다"와 "시장에 없다"를
구분할 수단이 없다. **PR-H 착수 전에 #1132 를 해소한다.** (PR-H 는 PR-J 도 선행으로 갖는다 — 위 참조.)

## PR-I — 보관함·`/study` venue 축

- 날짜 행에 venue별 `DiskStateBadge` — 미상장은 자리 없음
- 재캡처를 venue 단위로
- `/study` 거래소 선택기 부활 + venue별 가용성 표시(hogaplay 는 KRX 전용)

**검증:** vitest + e2e. 보관함 어휘는 #1083~#1086·#1090 이 정리한 체계 안에서 확장.

---

## 공통 게이트

모든 PR 은 CI 와 같은 명령을 로컬에서 통과시킨다:

```
cd frontend && npm run typecheck && npx vitest run && npx vite build
uv run --extra dev ruff check . && uv run --extra dev pytest -q -m 'not wallclock'
```

vitest 는 **반드시 `frontend/` 에서** 실행한다(루트는 전량 위양성).

**캡처 인접 PR(C·D·F·G)은 미검증 랜딩 금지**(#524 규율). 장중 검증이 필요한 PR(F·G)은 검증 전
머지하지 않는다.

## 되돌림

**킬스위치·토글·env 노브를 만들지 않는다**(ADR-0140 §8). 저장은 끄는 것이 더 위험하다 — 끈
동안이 영구 결손이다. 예외는 **PR-D 의 마이그레이션 역방향 스크립트** 하나뿐이다.
