# Live KIS WebSocket 실시간 파이프라인 설계

- **Date**: 2026-06-05
- **Status**: Draft (brainstorming 완료 · 1차 리뷰 반영 2026-06-05 — 코드/ADR 대조 검증, **§5.4 = 옵션 A 확정**)
- **Scope**: `both` (backend + frontend)
- **Topic slug**: `live-kis-websocket-realtime`
- **ADR**: 신규 ADR 필요 (이 설계 승인 후 작성) — KIS 수집 전송을 REST 폴링에서 WebSocket push로 전환
- **관련 ADR**: [ADR-0038](../../adr/0038-live-jsonl-then-promote.md) (JSONL→Promote), [ADR-0040](../../adr/0040-live-candle-backfill-separate-cache.md) (캔들=별도 REST 캐시, kis_live promoted parquet에 미기록), [ADR-0043](../../adr/0043-incremental-promote-today.md) (장중 promotion 재시작 복원; **Invariant 2: candles.parquet 절대 미생성**), [ADR-0048](../../adr/0048-live-daily-direct-backfill.md) (일봉=별도 REST 엔드포인트), [ADR-0053](../../adr/0053-live-push-channel-single-websocket.md) (백엔드→브라우저 WS), [ADR-0056](../../adr/0056-live-quote-overlay.md) (라이브 quote 오버레이=표시 전용, 권위 corpus 불변), [ADR-0064](../../adr/0064-live-poller-silent-death-and-calendar-gate.md) (poller watchdog)

---

## 1. 문제 / 배경 (진단 완료)

### 현재 딜레이의 정체

`/live`의 실시간 데이터가 화면마다 수 초~수십 초 지연된다. 조사로 확정한 출처:

| 화면/데이터 | 출처 | 전송·주기 |
|---|---|---|
| 호가창(10호가) | poller `fetch_orderbook` (FHKST01010200) | REST **20초** |
| 패널 현재가(관심종목·스크리너) | `intstock-multprice` (FHKST11300006) | REST **10초** |
| /live 차트 현재가(`candles.close`) | `past-candles` (dailychartprice) | REST **60초** |

딜레이의 100%가 **REST 폴링 주기**에서 온다(호가 `t_ms`가 클라 수신 시각이므로 화면 호가의 "나이" = 마지막 폴링 이후 경과). 표시 구간(백엔드→브라우저 WS, ADR-0053)은 이미 즉시라 손댈 게 없다.

### sub-second는 REST로 물리적으로 불가능

KIS 공유 토큰버킷이 **15콜/초**(`_RATE_LIMIT_CALLS_PER_SEC=15.0`)다. 15~41종목에서 호가만(1콜/종목) 받아도:

- 15종목 × 1콜 / 1초 = 15콜/초 = 천장(여유 0)
- 41종목 sub-second = 80+콜/초 ≫ 15

→ **어떤 폴링 주기로도 sub-second 불가**. rate limit이 천장이라 주기를 낮춰도 못 넘는다. **KIS WebSocket push가 유일한 길.**

## 2. 목표 / 비목표

### 목표
- **호가창·캔들·보조지표 3개를 모두 sub-second(1초 미만)로** 화면에 표시한다.
- 디스크 용량을 현 수준 이하로 유지한다(raw 고빈도 미저장).
- 알고리즘이 반응할 수 있는 실시간 데이터 층을 제공한다.

### 비목표
- 알고리즘/자동매매 로직 자체(별도 프로젝트 — 본 설계는 데이터 파이프라인까지).
- 인증/멀티유저/호스팅(단일 사용자 로컬 툴, CONTEXT.md/ADR-0036).
- 과거 per-tick 정밀 데이터 영속(hogaplay Full Capture가 책임).
- 41종목 초과 지원(→ §11 Future work: 다중 계좌).
- 패널 quote 경로(`intstock-multprice` 10초) 변경 — 관심종목/스크리너 현재가·헤더 등락률은 **무변경**(이 설계는 capture 경로만 다룬다).

## 3. 현재 시스템 (조사 결과)

### 데이터 경로가 여러 갈래
- **캔들(OHLCV)**: 100% REST `past-candles` 단일소스. WS 기여 0. 과거↔실시간 "봉합"이 캔들엔 없다(날짜로 파티션). (검증: 2개 워크플로우가 독립 확인)
- **호가/체결/거래원**: poller(REST 20초) → JSONL → Promotion → `snapshots/trades/brokers.parquet`. LiveBuffer(메모리 ring, maxlen=2520) → 백엔드→브라우저 WS.
- **보조지표(QR/FS)**: promoted parquet(과거) + WS buffer(실시간 꼬리), `pastMaxQrT` 시간경계로 봉합.

### 보조지표 3개 (`paneSpecsForTimeframe.ts:12`)
| 지표 | 정체 | 출처 | 성격 |
|---|---|---|---|
| **총잔량** (QuoteTotals) | `total_ask_qty`/`total_bid_qty` | 호가 | 상태(state) |
| **호가비** (Ratio) | ask/bid 비율 | 호가 | 상태(state) |
| **체결강도** (FillStrength) | 매수/매도 체결량 합 | 체결 | 흐름(flow) |

### 핵심 사실
- **15콜/초 토큰버킷을 셋이 공유**(backfill·poller·quote 경합).
- **kis_live = 저해상도 스냅샷, hogaplay = per-tick**. Source Preference로 공존, 과거는 hogaplay가 책임.
- **현재 저장 = raw 저장 후 읽을 때 지표 계산**(지표 자체는 미저장). bucket_ms는 표시 타임프레임 기반 가변.
- **캔들은 캡처로 저장 안 함**(ADR-0040: `candles.parquet` 미생성). past-candles JSON은 KIS 응답 캐시일 뿐.

## 4. 핵심 제약 (조사로 확정)

| 제약 | 내용 |
|---|---|
| **sub-second = REST 불가** | 15콜/초 ÷ 종목 → 41종목은 어떤 주기로도 sub-second 불가 → KIS WS 필수 |
| **KIS WS 41건 상한** | **appkey당 41건**, 등록 단위 = **(tr_id, 종목코드) 쌍** — 같은 종목이라도 TR(데이터 종류)마다 1건씩 소비. "종목 1회 등록으로 여러 데이터" 모드는 없음. 검증: 공식 repo "1개 appkey당 최대 41건 등록 제한" + python-kis `KisWebsocketTR(id, key)` set 카운트(보수적으로 40 캡). 초과는 다중 계좌 우회(§11) |
| **TR이 등록 건수를 1씩 소비** | 호가(H0STASP0) + 체결(H0STCNT0) + 회원사(**H0STMBC0** — 공식 repo 검증 완료 2026-06-05) = 종목당 **3등록** → **41÷3 ≈ 13종목** |
| **캔들·체결강도 = 체결 파생** | 캔들 라이브 엣지와 체결강도(FillStrength)는 체결(H0STCNT0)이 있어야 만든다 |
| **총잔량·호가비 = 호가 파생** | 호가(H0STASP0)에서. 둘은 10호가 스냅샷에 이미 포함 |

## 5. 설계 결정

### 5.1 B1+ 채택: 호가 + 체결 + 회원사(거래원) 셋 다 수신 (~13종목)

3개 지표 + 캔들을 모두 sub-second로 얻으려면 호가·체결 둘 다 필요하고, **거래원까지 WS로 받아 capture 경로를 WS로 일원화한다**(그릴링 Q1 결정 2026-06-05 — 거래원만 REST poller에 남기는 하이브리드 대신 선택). 그 결과 **종목당 3등록 → 41÷3 ≈ 13종목**. 사용자가 이 제한을 수용했다(초과는 §11 다중 계좌 future work).

- **B2(체결만, ~41종목)는 기각**: 호가지표(총잔량·호가비)를 만들 수 없다.
- **하이브리드(호가+체결 WS / 거래원 REST 유지, ~20종목)는 기각**: 거래원도 sub-second + poller 의존 제거를 우선. (H0STMBC0 실재가 공식 repo로 **검증 완료**(§12)되어 폴백 조항은 소멸.)

### 5.2 "체결 불필요"의 의미 = 저장 불필요 / 수신 OK

사용자의 "체결 불필요"는 **체결 내역을 디스크에 영속할 필요 없음**이라는 뜻(일관된 동기 = 용량). 체결 스트림은 **캔들·체결강도 집계용으로 수신하되 원본은 버린다.**

### 5.3 표시(메모리) ≠ 저장(디스크) — 빈도 분리

- **계산·표시 = 매 WS 틱(sub-second)**: 화면 즉시 갱신.
- **저장 = 10초마다 1점**: 용량 절감.

지표 성격에 따라 "실시간"의 형태가 다르다(`bucketHogaSeries.ts:45-46`):
- **상태형(총잔량·호가비)**: 매 틱 현재값(온도계). 저장은 10초 경계의 **마지막값**.
- **흐름형(체결강도)**: 진행 중 10초 버킷이 매 틱 자라남(강수량계, running sum). 저장은 10초 **구간 합**. (캔들 진행봉과 동일 패턴)

### 5.4 핵심 결정: 오늘 캔들의 권위 소스 = 옵션 A ⚠️

**이 설계에서 가장 어려운 하위 문제이며, plan 단계 진입 전에 반드시 확정해야 한다.** 현재 캔들은 100% REST `past-candles`(WS 기여 0)인데, WS 도입 시 오늘 캔들이 **두 소스(WS 집계 라이브 봉 + REST 확정 봉)**를 갖게 되어 같은 분(minute)에서 충돌한다. 캔들엔 지금 봉합 메커니즘이 **없으므로**(지표의 `pastMaxQrT` 패턴은 캔들에 미적용) 신설해야 한다. 두 갈래:

- **옵션 A — WS 집계 단독**: 오늘 캔들을 체결가 틱으로 클라이언트에서 집계. REST는 로드 시 **오늘 이미 지나간 봉(load 시각까지의 elapsed 구간 — 09:01에 열면 거의 없고 15:00에 열면 거의 하루치인 가변값)만 1회 시드**하고 장중 폴링 중단. (WS엔 과거가 없어 이 1회 시드는 **A·B 공통 필수** — 두 옵션의 진짜 차이는 *장중에 누가 라이브 엣지를 소유하나*뿐이다.) 라이브 엣지가 진짜 sub-second. 단 두 가지 부담: ① WS 집계 봉의 정확성(분봉 라벨 규약·누락 틱)이 REST 확정봉과 일치해야 하고, ② "장중 폴링 중단"이라 재연결·새로고침·서버 재시작 시 라이브 꼬리 복원에 **on-demand REST 재시드 로직을 신설**해야 한다(§7·§9의 "REST 확정봉이 메움"은 폴링이 살아있음을 전제하므로, A에선 이 둘이 충돌 — 재시드를 명시해야 정합).
- **옵션 B — REST 권위 + WS 엣지 스무딩**: REST `past-candles`가 오늘도 60초 폴링으로 **권위(확정봉)**를 유지하고, WS는 마지막 진행 봉만 매끄럽게 갱신. 경계 dedup은 지표가 쓰는 **`pastMaxT`/strict-greater/REST-우선** 패턴을 캔들에 도입. 안전하지만 라이브 엣지의 "확정"이 여전히 60초 단위. **복원은 공짜**: 새로고침·재시작 후 REST가 그대로 권위를 재시드하므로 추가 로직 0(옵션 A의 부담 ②가 없다).

**결정: 옵션 A 확정 (2026-06-05).** "진짜 sub-second 라이브 엣지"를 위해 오늘 캔들 라이브 꼬리를 WS 체결 틱으로 집계한다. 옵션 B(REST 권위 + WS 스무딩)는 검토된 대안으로 보존 — 더 안전·단순하나 라이브 엣지 "확정"이 60초 단위라 본 설계의 목표(캔들 sub-second)를 못 채운다.

**기존 ADR와의 관계 (코드/문서 대조로 확정)**:
- A는 캔들을 **메모리에서만 집계해 표시**하고 디스크에 영속하지 않으므로(§8 `캔들 미저장`), ADR-0040/0043/0048(영속 candle은 REST 캐시 단독)을 **문자 그대로 위반하지 않는다**. 특히 **ADR-0043 Invariant 2**(`promote_today`가 `candles.parquet`을 만들지 말 것 = 디스크 영속 규칙)는 A가 `candles.parquet`을 만들지 않으므로 **트리거되지 않는다**.
- 단 A는 오늘 캔들의 **표시 엣지를 WS-authored로** 만든다 — 위 ADR들이 세운 "candle 값은 REST에서 온다"는 결을 **라이브 표시 엣지에 한해 확장/계승**하는 것(위반 아님). 신규 ADR이 이 관계를 명시 기록한다.
- Invariant 2가 디스크에서 막던 **read-path 모호성(같은 분에 두 값)**이 A에선 **표시 계층의 seam에서 재등장**한다: 장중 REST 폴링은 꺼져 정상 구간은 단일 소스지만, load 시드 봉과 WS 집계 봉이 만나는 **경계 분에서만** 충돌 → 신규 ADR/plan이 **precedence 규칙**을 정의해야 한다.

⚠️ **A 고유의 핵심 리스크 — 경계 분(boundary minute)** *(수용한 리스크, plan에서 처리 — §12)*: 14:00:30에 WS 연결 시 14:00 봉은 **앞 30초 체결이 누락**된다. WS가 14:00을 소유하면 거래량·OHLC 오차; REST 시드가 14:00을 쥐고 WS는 14:01부터(`pastMaxT` strict-greater)면 14:00은 REST 값으로 고정되는데 **A는 장중 폴링이 꺼져 있어 영영 final로 self-correct 안 됨(frozen-partial)**. B라면 다음 60초 폴링이 고치지만 A는 reload/재시드 전까진 못 고친다. → plan 선결: KIS `past-candles`가 **진행 중 현재 분의 부분봉을 주는가, 마지막 완성 분에서 멈추는가**(이게 handoff를 결정), 그리고 connect-분이 끝날 때 **1회 reconcile fetch**가 필요한가(이 fetch는 사실상 B에 가까워짐).

이 결정이 §7 갭복구·§8 저장·§10 테스트의 캔들 관련 부분을 좌우한다.

### 5.5 구독 집합(Live Set) · poller 완전 은퇴 (그릴링 Q2·Q3 결정 2026-06-05)

- **구독 집합 = Watchlist Panel "UI 표시 순서" 상위 13** = **Live Set** (정식 용어, CONTEXT.md 등재 — 그릴링 Q5). 드래그 reorder가 곧 우선순위 UI — 패널에 13번째 아래 **WS 경계선**을 표시하고, 드래그로 경계를 넘기면 구독 스왑. 장중 스왑 시 밀려난 종목의 디스크 10초에 갭 발생 — 사용자 의도적 행위라 수용. **(2026-06-06 결정, watchlist v2 폴더화 #26/#34 반영)**: "순서"는 평탄 저장 배열이 아니라 **패널 표시 순서**(`folders[].order` 순 → 폴더 내 `entry.order` 순 평탄화) — 사용자가 보는 그대로가 우선순위라는 Q3의 정신 유지. 평탄화 헬퍼는 프론트 WatchlistDrawer의 실제 렌더 순서와 일치 검증(plan Task 11).
- **WS 밖 watchlist 종목(14+)**: 장중 kis_live 캡처 **없음**. Daily Scheduler의 hogaplay 17:00 일배치는 전 종목 유지되므로 과거 데이터는 무손실.
- **poller 완전 은퇴**: REST 호가/체결/거래원 폴링(`FHKST01010200`/`FHPST01060000`/`FHKST01010600`) 소멸. **ADR-0064의 watchdog 교훈(silent-death 감지·honest health·calendar gate)은 KIS WS 클라이언트 감독으로 이식**(§7).
- **activeCode 동적 스왑은 기각**: 차트 탐색이 저장 셋을 바꾸면 캡처 일관성이 깨짐. watchlist 밖 activeCode는 현행과 동일하게 라이브 데이터 없음(REST 캔들 시드만) — poller도 watchlist만 폴링했으므로(`lifecycle.py:79-93`) 후퇴 아님.
- **poller 은퇴 ≠ KisClient 은퇴**: `KisClient`는 lifespan 소유 프로세스 싱글턴(ADR-0050 단일 ingress)으로 quote 오버레이·past-candles 시드·일봉·투자자 순매수·Screener가 계속 사용한다. 은퇴하는 것은 poller *task*뿐 — WS 클라이언트의 approval_key 발급(`/oauth2/Approval` REST)도 KisClient 경유.

## 6. 아키텍처 / 데이터 흐름

```
KIS WebSocket (호가 H0STASP0 + 체결 H0STCNT0 + 회원사/거래원, ~13종목)
  │
  └─→ [신설] KIS WS 클라이언트 (백엔드)
        │  approval_key 발급 · 종목별 subscribe · heartbeat(PINGPONG)
        │  · 백오프 재연결 · 갭 복구
        │
        ├─→ LiveBuffer (메모리 ring) ─→ 기존 백엔드→브라우저 WS (ADR-0053) [재사용]
        │     └─ 표시: sub-second 호가창 · 캔들 라이브 엣지 · 3지표 실시간
        │
        └─→ 10초 다운샘플러
              └─→ 디스크 저장:
                    ├ 10호가 스냅샷 (10초)   ← 총잔량·호가비 여기서 파생
                    ├ 거래원 스냅샷 (10초)
                    └ 체결강도      (10초 구간합)
                    ✗ 체결 내역(raw) · per-tick · 캔들 = 미저장

과거 정밀: hogaplay Full Capture (per-tick)
캔들: 과거 = past-candles/hogaplay, 오늘 = WS 메모리 집계 (옵션 A 확정, §5.4) — load 시 REST 1회 시드, 장중 폴링 OFF
```

**부수효과**: poller 완전 은퇴(§5.5)로 REST 호가/체결/거래원 콜이 전부 사라져, 15콜/초 토큰버킷의 잔여 사용자는 backfill·quote(`intstock-multprice` 10초)·past-candles 시드뿐 — 경합 대폭 완화.

### 시간축 3구간 (당일 봉합)

화면의 데이터는 시간에 따라 출처가 갈린다. 경계는 **어제/오늘 시계가 아니라 "디스크에 저장된 마지막 시점"**이다.

캔들과 지표·호가는 "오늘 지난 부분"의 출처가 다르다(혼동 주의):

| 구간 | 출처 — 지표·호가 | 출처 — 캔들 | 해상도 |
|---|---|---|---|
| 어제 이전 | 디스크 10초 (+ hogaplay) | past-candles / hogaplay | 10초 (hogaplay 있으면 per-tick) |
| 오늘 — 지난 부분 | **디스크 10초** (promoted parquet) | **REST past-candles** (별도 JSON 캐시, ADR-0040) | 10초 / 분봉 |
| 오늘 — 최근 꼬리 | **WS 틱 (메모리)** | WS 체결 틱 (메모리) → 분봉 집계 | sub-second |

근거: `LiveBuffer maxlen=2520`은 현 poller(10초)엔 하루치지만 WS per-tick에선 몇 분치다. 메모리가 오늘 전체를 못 들으므로 오늘 지난 부분은 디스크/REST에서 읽는다(지표·호가=디스크 10초, 캔들=REST past-candles).

**경계 전진은 지표·호가에만 해당 — 캔들과 비대칭(리뷰 지적)**:
- **지표·호가**: Today Promotion(5분)이 promoted parquet을 갱신해 `pastMaxT`가 전진 → [디스크 10초] + [WS 꼬리(raw Live Tick ring, 최근 ~수 분)]의 경계가 우측으로 굳어간다(기존 `pastMaxQrT` 봉합 재사용). **프론트의 `pastMaxQrT` 전진은 오늘-포함 `/api/range` 쿼리의 5분 refetch(Today Promotion 주기 `HOGA_LIVE_TODAY_PROMOTE_INTERVAL_S` 동기)로 구현** — 로드 시점 `staleTime: Infinity` 동결이면 프론트 버퍼(15분)가 `[동결 pastMaxQrT … now]`에 자라는 구멍을 남긴다(Task 12 리뷰 C1, `frontend/src/api/range.ts:rangeFreshnessOptions`).
- **캔들(옵션 A)**: 캔들은 promotion되지 않고(ADR-0043 Inv 2) 장중 REST도 OFF → **경계가 load 시점의 REST 시드에 고정, 전진 없음**(§5.4와 일치). WS 집계가 만든 마감 분봉을 세션 내내 메모리에 누적 보관 — raw 틱 ring과 *다른* 메모리 모델(가벼운 append 배열, 하루 ~390개). 캔들 봉합 메커니즘은 신설 — §5.4·§12.

## 7. 신설 컴포넌트: KIS WS 클라이언트 (백엔드)

현재 코드베이스에 KIS WebSocket 클라이언트는 **전무**하다(poller는 REST). 신설 책임:

| 책임 | 내용 |
|---|---|
| **연결 핸드셰이크** | `approval_key` 발급(`/oauth2/Approval`), WS 연결 |
| **구독 관리** | 종목별 호가+체결+회원사 subscribe/unsubscribe. ~13종목 × 3 = 39등록(41 한도 내) |
| **프레임 파싱** | KIS WS 파이프 구분 텍스트 포맷, 암호화 옵션 처리 |
| **heartbeat** | PINGPONG 응답, dead-connection 탐지 |
| **재연결** | 백오프 재연결 + 종목 재구독 |
| **감독(watchdog)** | ADR-0064 이식: stale-tick 감지(~30s), honest health(`task is not None and not task.done()`), calendar gate(거래일만 연결), 크래시 재시작 |
| **갭 복구** | 끊긴 사이 데이터 — 상태형(호가)은 다음 스냅샷이 최신이라 자연 복구; 캔들(옵션 A, 장중 폴링 OFF)은 재연결 시 **on-demand REST past-candles 재시드**로 끊긴 구간 봉을 메우고 그 뒤부터 WS 집계 재개(연속 폴링 아님 — §5.4 경계 분 리스크 참조) |

기존 `LiveBuffer.publish` 인터페이스를 재사용해 다운스트림(브라우저 WS, ADR-0053)은 무변경. 연결 게이팅은 기존 **Live Session**(09:00–16:00 KST, Half-Day는 12:30) 재사용 — 장외엔 WS 미연결. 수신 단위는 **Live Tick**, 저장 단위는 10초 **Live Snapshot**(CONTEXT.md 용어, 그릴링 Q5).

## 8. 저장 정책 상세

| 데이터 | 저장 | 형태 | 기존 대비 |
|---|---|---|---|
| 10호가 스냅샷 | ✅ 10초 1장 | 10단계 가격·잔량 | 동일(현 poller도 주기 저장) |
| 거래원 스냅샷 | ✅ 10초 1장 | top5 매수/매도 | 동일 |
| 체결강도 | ✅ 10초 집계값 | 새 JSONL kind=`fill`(ts_ms, buy_qty, sell_qty 10초 구간합) → **`fills.parquet`** | **체결 내역 raw → 집계값으로 축소** (그릴링 Q4) |
| 총잔량·호가비 | (별도 저장 X) | 10호가 스냅샷에서 파생 | — |
| 체결 내역(개별) | ❌ 폐기 | — | 현 `trades.parquet` 저장 → 중단 |
| 캔들 분봉 | ❌ 저장 안 함 | 과거=past-candles/hogaplay | 동일(기존에도 미저장) |
| WS per-tick | ❌ 폐기 | 메모리(표시)에만 | 신규 |

**fill_strength 읽기 경로(그릴링 Q4 결정)**: `build_fill_strength_slice`(`hoga/api/bundle.py:279`)가 kis_live source에서 `trades.parquet` 대신 `fills.parquet`을 읽는 분기 추가. 10초 합 → bucket_ms 재집계는 합의 합이라 정확. hogaplay 경로 무변경. 부수 포기: kis_live 날짜의 Volume Profile(가격 분포는 집계에 없음 — 프론트 미소비 wire 필드라 무손실) + `series.cum_vol_monotonic` invariant(fills 비적용). `/api/trades` spot은 프론트 소비자 0(체결 카드 2026-05-28 제거)이라 kis_live 날짜의 빈 응답 허용.

**재시작 복원(ADR-0043 보존)**: 10초 지표를 디스크에 두므로 장중 서버 재시작에도 당일 지표가 안 날아간다. raw를 모두 버리는 게 아니라 10초 다운샘플을 남기는 것이 이 복원력의 근거.

**복원 3계층 (새로고침 ≠ 서버 재시작 ≠ WS 끊김)**:
- **브라우저 새로고침**: 프론트 메모리만 소멸. 마운트 시 `GET /api/live/series`가 백엔드 LiveBuffer(ring, **생존**)를 재하이드레이트하고(`frontend/src/api/liveSeries.ts`: 초기 REST fetch → buffer hydrate → WS 구독), 과거 봉은 REST past-candles가 재시드 → 사용자 체감 손실 0.
- **서버 재시작**: 백엔드 ring**도** 소멸 → 디스크 10초(ADR-0043) + REST로 복원. ring에만 있던 직전 per-tick은 손실(표시 전용이라 무해).
- **WS 끊김/재연결**: KIS WS 클라이언트가 재구독; 끊긴 사이 갭은 상태형(호가)은 다음 스냅샷이 자연 복구, 캔들은 재연결 시 **on-demand REST 재시드**로 보정(옵션 A: 장중 폴링 OFF이라 자동 폴링이 아니라 끊김마다 1회 재fetch — §5.4 부담 ②·경계 분).

⚠️ **용량 함의**: 현 ring(maxlen=2520)은 10초 폴링 기준 ~7시간(거의 하루)이라 새로고침이 ring 하나로 오늘 전체를 복원하지만, **WS per-tick에선 같은 2520칸이 "몇 분치"**라 새로고침 복원이 ring 단독으론 불가 → 오늘 지난 부분은 disk 10초(지표)·REST(캔들)가 받쳐야 한다. 이것이 §6 "시간축 3구간" 분리의 근거다.

⚠️ **봉합 사이징 불변식 (그릴링 중 발견)**: [디스크 10초] + [WS 꼬리] 봉합에 구멍이 없으려면 **ring이 항상 마지막 Today Promotion 시점(`pastMaxT`)까지 거슬러 닿아야** 한다 → **ring 보존 기간 > Today Promotion 주기(기본 `HOGA_LIVE_TODAY_PROMOTE_INTERVAL_S=300`) × 2**. 활발한 종목은 수십 tick/초라 개수 기반 maxlen=2520은 ~1-2분치로 **불변식 위반 가능** → **시간 기반 eviction(예: 최근 10–15분 보존)으로 전환** 필요. 13종목 × 3 kind × 10분 × ~50tick/s × ~200B ≈ 수백 MB 아닌 ~수십 MB 수준 — 메모리 허용. 정밀 사이징은 plan(§12).

## 9. 에러 처리

- **WS 끊김**: 백오프 재연결 + 종목 재구독. 끊긴 사이 호가는 다음 스냅샷이 최신이라 손실 무해; 캔들 라이브 엣지(옵션 A)는 재연결 시 **on-demand REST past-candles 재시드**로 보정(장중 연속 폴링은 OFF이므로 끊김·reload마다 1회 재fetch — 연속 폴링이 아님).
- **KIS 장애/빈 응답**: 표시는 마지막 메모리값 유지, 디스크는 빈 구간으로(상태형은 직전값 carry, 흐름형은 0).
- **갭 복구의 한계**: 체결은 고유 seq가 없어 per-tick 갭 복구가 원리적으로 어렵다 — 그래서 체결 per-tick은 영속하지 않고(과거 정밀은 hogaplay), 캔들/체결강도 **집계값**만 유지한다.

## 10. 테스트 전략

- **WS 클라이언트**: 프레임 파싱(녹화된 KIS 프레임 fixture), 재연결/재구독, heartbeat 타임아웃을 단위 테스트. 실 연결은 통합 테스트 1개로 스모크.
- **10초 다운샘플러**: 상태형(last-in-bucket) vs 흐름형(sum-in-bucket) 경계 케이스(버킷 straddle, 빈 버킷, 장 마감 경계)를 `bucketHogaSeries` 패턴과 동일하게 검증.
- **시간축 봉합**: [디스크 10초] + [WS 꼬리] 경계에서 중복/누락 없음, 경계 전진 시 일관성.
- **캔들 WS 집계 (옵션 A)**: WS 집계 분봉이 REST 확정봉과 OHLCV 일치(분봉 라벨·누락 틱), **경계 분 frozen-partial** 케이스(connect 중간 분), `pastMaxT` 경계 dedup(REST 시드 ↔ WS 봉), on-reconnect REST 재시드 후 봉 연속성.
- **fills 다운샘플 분류 동등성**: 10초 구간합이 `side==±1`만 합산하고 **`side==0`(Auction Cross·단일가) 제외** — `build_fill_strength_slice`/`bucketHogaSeries`의 기존 분류(ADR-0029)와 동일해야 한다. 집계 시점에 분류가 **비가역적으로 구워지므로** write-time 검증 필수.
- **저장 정합**: raw 미저장 후에도 과거 조회가 hogaplay로 정상 폴백.

## 11. Trade-off / Future work

### 수용한 trade-off
- **~13종목 상한**: 호가+체결+회원사(거래원) 셋 다 받는 대가. 호가창·캔들·3지표·거래원 전부 WS가 되고 capture 경로의 REST poller 의존이 사라진다.
- **디스크 해상도 10초 고정**: 그보다 잘게는 메모리(WS 꼬리)에만. 장중 회고/재시작 복원엔 10초로 충분.
- **kis_live-only 날짜의 과거 호가 gap**: hogaplay 미실행일은 과거 호가 조회 불가. hogaplay가 주 과거 소스라 수용.
- **watchlist 14+ 종목의 장중 kis_live 캡처 중단**(§5.5): WS 13슬롯 밖은 hogaplay 일배치만. poller 은퇴의 대가로 수용.
- **장후 시간외(15:30–16:00) 라이브 캡처 중단**(plan-review 결정 2026-06-05): WS는 정규 TR만 구독하고 수집 게이트를 15:30에 닫는다(틱 없는 창에 게이트를 열어두면 다운샘플러 carry가 유령 스냅샷을 씀). 가격이 종가에 고정되고 거래량만 누적되는 창이라 정보가치가 낮고, **hogaplay 일배치가 per-tick으로 post-hoc 보완**. poller의 overtime TR 경로는 은퇴와 함께 제거.

### Future work
- **다중 계좌로 41종목 초과**: 추가 계좌의 appkey로 WS 세션을 N개 운용해 `41×N` 등록(= `13×N` 종목 for 3-TR)으로 확장. 실증 사례: 2계좌 82건 운용 블로그(hky035).
- **모의투자 appkey 활용 검증**: 모의 WS(:31000)의 호가/체결 시세가 실전과 동일·무지연이라면 같은 사람 명의로 **+41건 무료 확장** 가능. 단 모의 세션 시세의 신뢰성(지연·누락·장운영 차이)을 실측 검증한 뒤에만 채택.
- **시간외 TR 페이즈-스왑**: 15:30에 정규 TR을 해제하고 시간외 체결/호가 TR로 교체 구독하면 장후 라이브를 복원할 수 있다(등록 예산 동일, 시간 다중화). 필요해지면 진행. 세션 라우팅·계좌별 토큰버킷 관리가 추가됨. **본 설계 범위 밖, 나중에 진행.**
- 알고리즘/반응 층(모니터·알림·자동매매)은 이 데이터 파이프라인 위의 별도 프로젝트.

## 12. 미해결 / plan 단계에서 확정할 것
- KIS WS 프레임 정확한 필드 매핑(H0STASP0/H0STCNT0/회원사) — 공식 스펙 대조(koreainvestment/open-trading-api `chk_*` 참조).
- ~~(Q1 선결 검증) 회원사 TR 실재 확인~~ → **검증 완료(2026-06-05)**: **H0STMBC0 실재** — 공식 repo `legacy/websocket/python/ws_domestic_overseas_all.py:1080`(등록 예시) · `:1196`(처리 분기) · `:189`(필드 목록 — 매도/매수 회원사명·수량 각 5개로 brokers 스키마 충족). **13종목 확정**, 하이브리드 폴백 조항 소멸. 단 H0STMBC0엔 시간 필드가 없어 broker tick의 t_ms는 수신 시각 사용.
- fills 다운샘플러의 **side 분류 동등성**(§10): H0STCNT0 체결 구분 → `side ∈ {+1,-1,0}` 매핑이 REST/hogaplay 경로와 일치해야 함(단일가·Auction Cross 제외 규칙 포함).
- ~~10초 다운샘플 저장 포맷~~ → **해소(그릴링 Q4)**: 기존 JSONL→Promotion 파이프라인 재사용(ADR-0038 hot-path invariant 유지 — WS 핫패스도 JSONL만 씀). ob/broker는 기존 kind 그대로 10초 1장, 체결강도는 새 kind=`fill` → Promotion이 `fills.parquet` 생성 + `build_fill_strength_slice` 분기.
- LiveBuffer **시간 기반 eviction** 정밀 사이징(§8 봉합 사이징 불변식: 보존 기간 > 2× promote 주기) + 브라우저 측 `LiveSnapshotBuffer` 동일 처리 + per-tick 렌더 비용(매 프레임 전량 `bucketHogaSeries` 재계산 vs 증분 버킷) 측정.
- **(§5.4 = 옵션 A 확정)** 오늘 캔들 WS 집계 구현:
  - 집계 빌더(체결가 H0STCNT0 → 분봉 OHLCV, **KIS 분봉 라벨 규약과 일치** 필수).
  - `series.update`(마지막 진행 바만 갱신; 현재 전량 `setData`뿐 — `frontend/src/chart/RangeSeriesPane.tsx`).
  - 경계 dedup(`pastMaxT`/strict-greater): load 시드 봉(REST) ↔ WS 집계 봉 precedence 규칙.
  - **경계 분(boundary minute) 규칙 [A 핵심 난점]**: connect 중간에 시작된 분의 부분봉을 (a) WS가 소유(부분 데이터 수용) vs (b) REST 시드가 소유하고 WS는 다음 분부터 — 어느 쪽이든 **frozen-partial 방지책** 명시. 선결 검증: KIS `past-candles`가 진행 중 현재 분의 부분봉을 주는가, 마지막 완성 분에서 멈추는가.
  - on-connect/on-reconnect/on-reload **REST 재시드** 경로(장중 연속 폴링 없음); connect-분 완료 시 1회 reconcile fetch 필요 여부 판단.
  - **신규 ADR**: "오늘 캔들 표시 엣지 = WS-authored(메모리, 미영속); REST는 시드/재시드 단독; seam precedence = …" 기록 — ADR-0040/0043/0048 결의의 **계승·확장**(위반 아님)임을 명시.
- ~~WS 수집과 기존 poller/watchdog(ADR-0064)의 공존/대체 관계~~ → **해소(그릴링 Q2)**: 완전 대체. poller 은퇴, watchdog 교훈은 WS 클라이언트 감독으로 이식(§5.5·§7).
- Watchlist Panel의 WS 경계선 UI(13번째 아래 구분선 + 행별 실시간/비실시간 상태 표기) 구체 설계.
