# Live KIS WebSocket 실시간 파이프라인 설계

- **Date**: 2026-06-05
- **Status**: Draft (brainstorming 완료 — 사용자 리뷰 대기)
- **Scope**: `both` (backend + frontend)
- **Topic slug**: `live-kis-websocket-realtime`
- **ADR**: 신규 ADR 필요 (이 설계 승인 후 작성) — KIS 수집 전송을 REST 폴링에서 WebSocket push로 전환
- **관련 ADR**: [ADR-0038](../../adr/0038-live-jsonl-then-promote.md) (JSONL→Promote), [ADR-0040](../../adr/0040-live-calendar-timeframe-panes.md) (kis_live는 candles.parquet 미생성), [ADR-0043](../../adr/0043-incremental-promote-today.md) (장중 promotion 재시작 복원), [ADR-0053](../../adr/0053-live-push-channel-single-websocket.md) (백엔드→브라우저 WS), [ADR-0064](../../adr/0064-live-poller-silent-death-and-calendar-gate.md) (poller watchdog)

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
| **KIS WS 41건 상한** | 세션(=계좌, approval_key)당 41 등록. 초과는 다중 계좌 우회 |
| **TR이 등록 건수를 1씩 소비** | 호가(H0STASP0) + 체결(H0STCNT0) = 종목당 **2등록** → **41÷2 ≈ 20종목** |
| **캔들·체결강도 = 체결 파생** | 캔들 라이브 엣지와 체결강도(FillStrength)는 체결(H0STCNT0)이 있어야 만든다 |
| **총잔량·호가비 = 호가 파생** | 호가(H0STASP0)에서. 둘은 10호가 스냅샷에 이미 포함 |

## 5. 설계 결정

### 5.1 B1 채택: 호가 + 체결 둘 다 수신 (~20종목)

3개 지표 + 캔들을 모두 sub-second로 얻으려면 호가·체결 둘 다 필요하다. 그 결과 **종목당 2등록 → ~20종목**. 사용자가 이 제한을 수용했다(41 초과는 §11 다중 계좌 future work).

- **B2(체결만, ~41종목)는 기각**: 호가지표(총잔량·호가비)를 만들 수 없다.

### 5.2 "체결 불필요"의 의미 = 저장 불필요 / 수신 OK

사용자의 "체결 불필요"는 **체결 내역을 디스크에 영속할 필요 없음**이라는 뜻(일관된 동기 = 용량). 체결 스트림은 **캔들·체결강도 집계용으로 수신하되 원본은 버린다.**

### 5.3 표시(메모리) ≠ 저장(디스크) — 빈도 분리

- **계산·표시 = 매 WS 틱(sub-second)**: 화면 즉시 갱신.
- **저장 = 10초마다 1점**: 용량 절감.

지표 성격에 따라 "실시간"의 형태가 다르다(`bucketHogaSeries.ts:45-46`):
- **상태형(총잔량·호가비)**: 매 틱 현재값(온도계). 저장은 10초 경계의 **마지막값**.
- **흐름형(체결강도)**: 진행 중 10초 버킷이 매 틱 자라남(강수량계, running sum). 저장은 10초 **구간 합**. (캔들 진행봉과 동일 패턴)

### 5.4 핵심 미해결 결정: 오늘 캔들의 권위 소스 ⚠️

**이 설계에서 가장 어려운 하위 문제이며, plan 단계 진입 전에 반드시 확정해야 한다.** 현재 캔들은 100% REST `past-candles`(WS 기여 0)인데, WS 도입 시 오늘 캔들이 **두 소스(WS 집계 라이브 봉 + REST 확정 봉)**를 갖게 되어 같은 분(minute)에서 충돌한다. 캔들엔 지금 봉합 메커니즘이 **없으므로**(지표의 `pastMaxQrT` 패턴은 캔들에 미적용) 신설해야 한다. 두 갈래:

- **옵션 A — WS 집계 단독**: 오늘 캔들을 체결가 틱으로 클라이언트에서 집계. REST는 로드 시 **아침 봉(오늘 지난 부분)만 시드**하고 장중 폴링 중단. 라이브 엣지가 진짜 sub-second. 단 WS 집계 봉의 정확성(분봉 라벨 규약·누락 틱)이 REST 확정봉과 일치해야 한다.
- **옵션 B — REST 권위 + WS 엣지 스무딩**: REST `past-candles`가 오늘도 60초 폴링으로 **권위(확정봉)**를 유지하고, WS는 마지막 진행 봉만 매끄럽게 갱신. 경계 dedup은 지표가 쓰는 **`pastMaxT`/strict-greater/REST-우선** 패턴을 캔들에 도입. 안전하지만 라이브 엣지의 "확정"이 여전히 60초 단위.

**권고는 옵션 B**(기존 봉합 패턴 재사용, REST를 진실원으로 유지해 WS 집계 오차 위험 회피). 단 사용자/plan에서 최종 결정. 이 결정이 §7 갭복구·§8 저장·§10 테스트의 캔들 관련 부분을 좌우한다.

## 6. 아키텍처 / 데이터 흐름

```
KIS WebSocket (호가 H0STASP0 + 체결 H0STCNT0, ~20종목)
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
캔들: 과거 = past-candles/hogaplay, 오늘 = 메모리 실시간 집계
```

**부수효과**: WS가 poller의 호가 수집을 대체하면(§5.4·§12 미해결), poller의 REST 호가 호출이 사라져 토큰버킷 경합(backfill·quote)이 완화된다.

### 시간축 3구간 (당일 봉합)

화면의 데이터는 시간에 따라 출처가 갈린다. 경계는 **어제/오늘 시계가 아니라 "디스크에 저장된 마지막 시점"**이다.

| 구간 | 출처 | 해상도 |
|---|---|---|
| 어제 이전 | 디스크 10초 (+ hogaplay) | 10초 (hogaplay 있으면 per-tick) |
| 오늘 — 지난 부분 | **디스크 10초** | 10초 |
| 오늘 — 최근 꼬리 | **WS 틱 (메모리)** | sub-second |

근거: `LiveBuffer maxlen=2520`은 현 poller(10초)엔 하루치지만 WS per-tick에선 몇 분치다. 메모리가 오늘 전체를 못 들으므로 오늘 지난 부분은 디스크에서 읽는다. 차트는 [디스크 10초] + [WS 꼬리]를 이어 붙이고, 시간이 흐르면 WS 꼬리가 디스크 10초로 굳어 경계가 우측 전진한다(= 기존 `pastMaxQrT` 봉합 패턴 재사용).

## 7. 신설 컴포넌트: KIS WS 클라이언트 (백엔드)

현재 코드베이스에 KIS WebSocket 클라이언트는 **전무**하다(poller는 REST). 신설 책임:

| 책임 | 내용 |
|---|---|
| **연결 핸드셰이크** | `approval_key` 발급(`/oauth2/Approval`), WS 연결 |
| **구독 관리** | 종목별 H0STASP0 + H0STCNT0 subscribe/unsubscribe. ~20종목 × 2 = ~40등록(41 한도 내) |
| **프레임 파싱** | KIS WS 파이프 구분 텍스트 포맷, 암호화 옵션 처리 |
| **heartbeat** | PINGPONG 응답, dead-connection 탐지 |
| **재연결** | 백오프 재연결 + 종목 재구독 |
| **갭 복구** | 끊긴 사이 데이터 — 상태형(호가)은 다음 스냅샷이 최신이라 자연 복구; 캔들은 REST past-candles 확정봉이 메움 |

기존 `LiveBuffer.publish` 인터페이스를 재사용해 다운스트림(브라우저 WS, ADR-0053)은 무변경.

## 8. 저장 정책 상세

| 데이터 | 저장 | 형태 | 기존 대비 |
|---|---|---|---|
| 10호가 스냅샷 | ✅ 10초 1장 | 10단계 가격·잔량 | 동일(현 poller도 주기 저장) |
| 거래원 스냅샷 | ✅ 10초 1장 | top5 매수/매도 | 동일 |
| 체결강도 | ✅ 10초 집계값 | 매수/매도 체결량 합 | **체결 내역 raw → 집계값으로 축소** |
| 총잔량·호가비 | (별도 저장 X) | 10호가 스냅샷에서 파생 | — |
| 체결 내역(개별) | ❌ 폐기 | — | 현 `trades.parquet` 저장 → 중단 |
| 캔들 분봉 | ❌ 저장 안 함 | 과거=past-candles/hogaplay | 동일(기존에도 미저장) |
| WS per-tick | ❌ 폐기 | 메모리(표시)에만 | 신규 |

**재시작 복원(ADR-0043 보존)**: 10초 지표를 디스크에 두므로 장중 서버 재시작에도 당일 지표가 안 날아간다. raw를 모두 버리는 게 아니라 10초 다운샘플을 남기는 것이 이 복원력의 근거.

## 9. 에러 처리

- **WS 끊김**: 백오프 재연결 + 종목 재구독. 끊긴 사이 호가는 다음 스냅샷이 최신이라 손실 무해; 캔들 라이브 엣지는 재연결 후 REST past-candles 확정봉이 보정.
- **KIS 장애/빈 응답**: 표시는 마지막 메모리값 유지, 디스크는 빈 구간으로(상태형은 직전값 carry, 흐름형은 0).
- **갭 복구의 한계**: 체결은 고유 seq가 없어 per-tick 갭 복구가 원리적으로 어렵다 — 그래서 체결 per-tick은 영속하지 않고(과거 정밀은 hogaplay), 캔들/체결강도 **집계값**만 유지한다.

## 10. 테스트 전략

- **WS 클라이언트**: 프레임 파싱(녹화된 KIS 프레임 fixture), 재연결/재구독, heartbeat 타임아웃을 단위 테스트. 실 연결은 통합 테스트 1개로 스모크.
- **10초 다운샘플러**: 상태형(last-in-bucket) vs 흐름형(sum-in-bucket) 경계 케이스(버킷 straddle, 빈 버킷, 장 마감 경계)를 `bucketHogaSeries` 패턴과 동일하게 검증.
- **시간축 봉합**: [디스크 10초] + [WS 꼬리] 경계에서 중복/누락 없음, 경계 전진 시 일관성.
- **저장 정합**: raw 미저장 후에도 과거 조회가 hogaplay로 정상 폴백.

## 11. Trade-off / Future work

### 수용한 trade-off
- **~20종목 상한**: 호가+체결 둘 다 받는 대가. 호가창·캔들·3지표 전부 sub-second를 얻는다.
- **디스크 해상도 10초 고정**: 그보다 잘게는 메모리(WS 꼬리)에만. 장중 회고/재시작 복원엔 10초로 충분.
- **kis_live-only 날짜의 과거 호가 gap**: hogaplay 미실행일은 과거 호가 조회 불가. hogaplay가 주 과거 소스라 수용.

### Future work
- **다중 계좌로 41종목 초과**: 추가 계좌의 approval_key로 WS 세션을 N개 운용해 `41×N`(또는 `20×N` for 2-TR) 종목으로 확장. 세션 라우팅·계좌별 토큰버킷 관리가 추가됨. **본 설계 범위 밖, 나중에 진행.**
- 알고리즘/반응 층(모니터·알림·자동매매)은 이 데이터 파이프라인 위의 별도 프로젝트.

## 12. 미해결 / plan 단계에서 확정할 것
- KIS WS 프레임 정확한 필드 매핑(H0STASP0/H0STCNT0) — 공식 스펙 대조(koreainvestment/open-trading-api `chk_*` 참조).
- 10초 다운샘플 저장 포맷(기존 JSONL/parquet 재사용 vs 신규).
- **(§5.4 선결)** 오늘 캔들 권위 소스(옵션 A/B) 확정 후: 집계 빌더(체결가 → 분봉) + `series.update`(마지막 바만, 현재 전량 setData뿐) + 경계 dedup(`pastMaxT`/strict-greater/REST-우선).
- WS 수집과 기존 poller/watchdog(ADR-0064)의 공존/대체 관계.
