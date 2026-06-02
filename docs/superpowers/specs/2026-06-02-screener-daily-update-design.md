# Screener 일봉 코퍼스 업데이트 설계 (KIS 정식화 + 수정주가 정합성 복구)

- **날짜**: 2026-06-02
- **상태**: 설계 (그릴링 대기)
- **범위**: (가) 수정주가 정확도 + (나) 원주가 업데이트 흐름 — 둘 다
- **관련**: CONTEXT.md "Screener", ADR-0048(live-daily-direct-backfill), ADR-0055(today-breakout), ADR-0050(KIS rate-limit retry)

---

## 1. 배경 / 현재 상태

Screener는 전 시장 일봉 코퍼스(`<data_dir>/screener/`)를 DuckDB-over-parquet으로 스캔한다.
데이터는 2단 구조다:

- `daily_unadjusted.parquet` — **원주가 SSOT**, append-only. dev-tradingview TimescaleDB 1회 시드 + KIS 일봉 append.
- `daily_adjusted.parquet` — **수정주가**(scan 대상), `daily_unadjusted`에서 파생.

현재 파생은 로컬 휴리스틱 `adjust_splits`(`screener_store.py`)가 담당한다: 일별 종가비가
`_SPLIT_RATIOS`의 깨끗한 분할비(1/2,1/3,...,1/50,2,...)에 ±3% 안으로 맞으면 그 비율로
back-adjust, 아니면 보정 안 함.

업데이트는 `trigger_update`(`screener.py`)가 3 트리거(EOD 스케줄러 KST 17:00 /
부팅 복구 / 수동 `POST /api/screener/update`)에서 single-flight로 돌며, 갭 거래일을
KIS `fetch_past_daily_candles(adjust=False)`(원주가)로 받아 append → `derive_adjusted`로
**수정주가 전체 재파생** → `status.json` 갱신한다.

### 1.1 측정으로 확인한 사실 (이 설계의 근거)

**(A) dev-tradingview DB는 사실상 멈췄다.**
컨테이너는 Up이나 `ohlcv_daily` max_date = **2026-05-14**(약 13거래일 stale). parquet은
KIS append 덕에 **2026-06-02(오늘)**까지 최신. 즉 DB를 채우던 외부 파이프라인이 중단됐고,
그동안 코퍼스를 최신으로 지켜온 것은 KIS다. DB는 hoga 코드베이스에서 `seed_all`(1회 시드
CLI) 외엔 아무도 참조하지 않는다 — 은퇴해도 다른 기능이 깨지지 않는다.

**(B) KIS 수정주가(`FID_ORG_ADJ_PRC=0`)는 거래량까지 보정한다.**
실증(스크리너가 쓰는 동일 엔드포인트 FHKST03010100):

| 분할 | 분할 前 원주가 | 분할 前 KIS 수정주가 | close 배율 | vol 배율 |
|---|---|---|---|---|
| 삼성전자 005930 50:1 (2018-05-04) | close 2,581,000 / vol 235,220 | close 51,620 / vol 11,761,000 | 50.0× | 50.0× |
| 카카오 035720 1:5 (2021-04-15) | close 502,000 / vol 310,400 | close 100,759 / vol 1,546,455 | 4.982× | 4.982× |

KIS는 가격·거래량에 **동일 계수**를 적용해 거래대금(price×volume)을 보존한다. 분할 後
날짜는 원주가=수정주가(배율 1.0)로, 단일변수(보정 플래그) A/B + 분할 後 대조군으로 검증됨.
→ "KIS는 거래량을 보정 안 할 것"이라는 우려는 **거짓**.

**(C) 현재 `daily_adjusted.parquet`은 분할 종목의 64%가 미보정(깨짐) 상태다.**

| 종목 | 디스크 수정주가 | KIS 진실값 | 상태 |
|---|---|---|---|
| 삼성전자 005930 | close 51,620 / vol 11,761,000 | 동일 | ✅ 정확 (50 = 깨끗한 비율) |
| 카카오 035720 | close 502,000 / vol 310,400 (**원주가 그대로**) | close 100,759 / vol 1,546,455 | ❌ 보정 0 (close +398%, vol −80%) |

규모: 단일일 −30% 초과 하락(정상 등락한계 초과 ⇒ 거의 확실히 코퍼레이트 액션)이 있는
**액션 후보 887종목 중 572종목(64%)이 보정 전혀 안 됨.** 미보정 표본에 005935(삼성전자우)가
있다 — 본주(005930)는 보정됐는데 같은 50:1 분할의 우선주는 미보정(실현비율 1/51.8이 ±3% 밖).

**원인**: ±3% "깨끗한 비율 매칭"이 brittle. 실현 ex-date 비율은 (1) 직전가가 거래정지
평탄가(stale) (2) 기준일~ex-date 시세 변동 (3) 우선주 디스카운트 변동 때문에 거의 깨끗한
분수에 안 떨어진다.

**거래대금 불변은 정확성 체크가 아니다**: 카카오도 거래대금 불변(price·vol 둘 다 안 건드려서).
따라서 `trade_value`(거래대금) 조건만 이 버그에 강건하고, **절대 레벨을 쓰는
`new_high`·`new_high_vol`·`ma`·`price_range`·`change_pct`는 572종목에서 현재 틀린 결과**를 낸다.

---

## 2. 결정

1. **원주가 권위 소스 = KIS** (adjust=False). DB는 은퇴(1999~ 역사 시드용으로만 보관, 재시드 안 함).
   - **단, 기존 원주가를 KIS와 1회 교차검증(reconcile)** — 그릴링에서 사용자가 기존 raw 무결성을 우려. 스폿체크(7종목×2기간, 1585행) 결과 **값은 100% 일치**(틀린 값 아님)이나 **커버리지 구멍 존재**(예: 000660 디스크 2015~ 시작, KIS는 2010 보유). 소스마다 구멍이 달라(005930은 디스크 1999가 더 깊음) **합집합이 최선**. → reconcile = ① 값 검증 ② 디스크 결측일 KIS 보충 ③ KIS 미도달 깊은 역사는 디스크 유지.
2. **수정주가 = KIS 정확 계수 기반**으로 전환. 로컬 휴리스틱은 폐기하지 않고 **(i) 감지 트리거 (ii) 손상 시 폴백**으로 강등.
3. **검색 레이어(DuckDB-over-parquet)는 변경 없음** — 풀 코퍼스 스캔 ~0.6초(실측, 신고거래량 lookback=500/period=1000), 소스와 무관.

### 채택 안: 계수 테이블 (factor store)

수정주가 = 원주가 × 계수. 계수는 코퍼레이트 액션 때만 바뀌는 **계단 함수**라 종목당
변곡점 몇 개로 전 역사를 표현. 계수는 KIS에서 직접 산출: `계수[날짜] = adj_close / raw_close`.

대안과 트레이드오프:
- **A 매일 KIS 수정주가 전량 재수신** — 정확하나 ~22만 콜/밤(~4h). 비용으로 탈락.
- **B 계수 테이블 (채택)** — 평소 KIS 0(원주가 갭만), 액션 종목만 계수 재수신. 기존 구조의 두뇌만 교체.
- **C 증분 수정주가 + 종목별 재작성** — parquet 행 단위 수정 불가라 종목 파티션 통째 재작성, 부품 많음.
- **D 휴리스틱 유지 + KIS 교정** — 2-소스 혼란, "결국 정확"이지 "항상 정확" 아님. B가 D의 깔끔한 종착점.

---

## 3. 아키텍처 / 데이터 모델

### 파일 레이아웃 (`<data_dir>/screener/`)

| 파일 | 변경 | 역할 |
|---|---|---|
| `daily_unadjusted.parquet` | 그대로 | 원주가 SSOT, append-only |
| `factors.parquet` | 🆕 신규 | 종목별 보정 계수(계단 함수) |
| `daily_adjusted.parquet` | 재해석 | 수정주가 = 원주가 × 계수 (scan 대상), 여전히 재파생하나 계수 출처가 바뀜 |
| `stocks.parquet` | 보강 | 메타. symbol-master 기반 주기 갱신 추가 |
| `status.json` | 확장 | `last_factor_refresh`, 계수 커버리지, `degraded` 플래그 추가 |

### `factors.parquet` 스키마

```
code        VARCHAR   -- 종목
seg_start   DATE      -- 이 계수가 적용되는 구간 시작일
factor      DOUBLE    -- 그 구간 원주가에 곱할 배율 (adj_close/raw_close; 최신 구간 = 1.0)
```

- **저장 규약**: `factor = adj_close / raw_close` (≤1.0 for back-history). 기존 `adjust_splits`의
  `price × factor, volume / factor` 수학을 그대로 재사용 — 출처만 바뀐다(거래량 보정 로직 불변).
- **적용(derive)**: DuckDB `ASOF JOIN` — 각 (code, date)에 `seg_start <= date`인 최근 세그먼트 factor.
  백필이 최古 세그먼트 `seg_start`를 종목 최초일로 깔아 **모든 날짜 커버**(틈 없음).
- 카카오 예: `(035720, <최초일>, 0.2007)`, `(035720, 2021-04-15, 1.0)` — 두 줄.

### 컴포넌트 (각자 한 가지 일, 독립 테스트 가능)

```
[일일]
 ① raw 수신(KIS adj=False, 갭만)              [기존]
 ② action_detector : 원주가 점프로 액션 종목 플래그 (D1)
 ③ factor_refresh  : (플래그 ∪ 월 1/30 순환) 만 KIS adj 수신 → 계수 재계산
 ④ factor_compute  : (raw, KIS-adj) → 계수 세그먼트 (순수함수, 핵심 테스트)
 ⑤ derive_adjusted : adjusted = 원주가 × 계수 (ASOF)  [두뇌 교체]
 ⑥ stocks_refresh  : symbol-master → stocks.parquet (주기)  [(나)]
 ⑦ intraday guard  : 오늘 바는 EOD 확정 후만 ingest  [(나)]
[일회성]
 ⑧ raw_reconcile   : 1회 — 기존 원주가 vs KIS(adj=False) 값 검증 + 디스크 결측일 보충(합집합)
 ⑨ factor_backfill : 전 종목 계수 최초 구축 + 구/신 임팩트 리포트 (resumable, rate-limited)
```

---

## 4. 데이터 흐름 (일일 EOD)

```
0. 장중 가드 : ingest 대상 = '세션 확정 거래일'만 (date<today_kst OR now_kst≥16:00 KST). KIS가 미확정 오늘 행 줘도 드롭.
1. 갭 계산   : last_raw_date → 확정 거래일 갭 (KRX 캘린더)
2. raw 수신  : 종목별 갭만 KIS(adj=False)
3. append    : daily_unadjusted (원자적, (code,date) 멱등)
4. 감지(D1)  : 새 행 원주가 점프 → 액션 종목 플래그
5. 계수 갱신 : (플래그 ∪ 월 1/30 순환) 종목만 KIS(adj=True) 전 역사 수신 → factor_compute → factors.parquet upsert
6. derive    : daily_adjusted = 원주가 × 계수 (ASOF), 원자적 swap (마지막에)
7. 메타 갱신 : symbol-master → stocks.parquet (주기)
8. status    : last_raw_date, last_factor_refresh, 계수 커버리지
```

### 핵심 결정

- **D1 — 감지 규칙 = "단일일 등락 한계(±30%) 초과 ⇒ 코퍼레이트 액션".** 정상 거래는 ±30%를
  못 넘으므로(역사적으로 더 좁음), 한계 초과 단일일 점프는 액션. 깨끗한 분할비뿐 아니라 모든
  액션(액면병합 +방향 포함)을 한 규칙으로 포착. **실증으로 검증됨**: 이 규칙이면 미보정 887종목 전부 포착.
  한계 미만 희석(유상증자)은 못 잡음 → 월 1/30 순환이 안전망.
- **D2 — 갱신 시 "그 종목 전 역사 계수 통째 재계산"** (빠른-곱셈 경로 안 씀). 단순(한 경로)·자가치유
  (드리프트 누적 없음). 비용: 플래그(하루 <10) + 순환(~120) ≈ 밤당 수천 콜(~10분), EOD 예산 안.
- **D3 — 최초 1회 백필** (전 종목, KIS 도달 깊이까지, resumable·rate-limited, 구/신 임팩트 리포트 산출).
- **D4 — 계수 `adj/raw` 저장 → derive 수학 불변** (price×factor, volume/factor).
- **D5 — 월 1/30 순환 안전망** (밤당 ~120종목 KIS 전 역사 재확인 → 감지 놓친 희석을 한 달 내 자가 교정). 순환율 튜닝 가능.
- **D6 — 장중 가드 컷오프 = 16:00 KST 고정** (그릴링 Q1 해결). `date<today_kst` OR `now_kst≥16:00`일 때만 당일 ingest. 정규장 종가(15:30) 확정 + 버퍼, 반장(12:30 마감)도 안전, 17:00 스케줄러가 당일 같은 저녁 포착, 부팅 복구의 미완성 당일 바 차단. **ingest 단계에서 집행**(KIS가 미확정 오늘 행 줘도 드롭). 라이브 캐시(`past_daily_candles_cache`)의 "과거=디스크 / 오늘=확정 전 메모리" 원칙과 정합.

---

## 5. 에러 처리 / 엣지케이스

기존 계약(원자적 기록·single-flight·KIS 백오프 ADR-0050·격리) 재사용.

- **실패 격리**: 계수 갱신은 종목별 try/except. 한 종목 실패 → 직전 계수(last-known-good) 유지 + 로그 + 다음 런 재시도. derive·scan 무영향.
- **KIS 실패**: rate-limit은 클라이언트 백오프, 소진 시 해당 종목 skip. 부분/빈 응답 → upsert 거부(옛 계수 유지). 자격증명 없음/KRX 먹통 → 사이클 skip(현 규칙).
- **백필 중단**: resumable(완료 종목 skip), K종목마다 임시파일→`os.replace` flush(토막 parquet 없음).
- **원자성 & 2-파일 정합성 (불변식)**: 모든 파일 `atomic_write_*`. derive는 항상 마지막에 돌고 끝에서 `daily_adjusted` 원자 swap. **`daily_adjusted`는 항상 어떤 일관된 (unadjusted, factors) 스냅샷의 유효한 파생본** — 최악의 경우 한 사이클 뒤처질 뿐(토막 아님), 다음 EOD 자가 교정.
- **손상 → 폴백 (우아한 강등)**: `factors.parquet` 손상/결측 → `.corrupt-<stamp>` 격리 + derive를 기존 `adjust_splits` 휴리스틱으로 폴백(스크리너는 "옛 정확도"로라도 계속 동작) + status=`degraded`. 다음 백필/순환이 재구축.
- **도메인 엣지**: 거래정지(vol=0·평탄, 오탐 안 됨, 직전 ratio 유지) / 신규상장(직전가 없음 → 즉시 fetch 플래그) / 상장폐지(행 동결, universe 필터 제외) / 액면병합(+방향, D1이 포착) / 배당락(보통 <30% + KIS 현금배당 미보정 → 계수 불변) / 유상증자 소량 희석(<30%, 순환 안전망).
- **비용 폭주 가드**: 감지 플래그 > N → 상위 N만 처리, 나머지 연기 + 로그(silent 절단 금지).

---

## 6. 테스트 전략

피라미드: pure(factor_compute) → integration(derive ASOF) → mocked-KIS(refresh/backfill, httpx 캡처) → e2e/golden → live smoke(마크, CI 제외).

- **factor_compute 순수함수 (핵심)**: 골든 앵커 = 실측 진짜 숫자.
  - 삼성 50:1 → 분할前 factor=0.0200, 분할後 1.0
  - **카카오 1:5 → "현재 완전 미보정 → 정확값으로 고쳐져야 함" 회귀 케이스** (factor≈0.2007)
  - **005935 삼성전자우 → 본주-우선주 일관성** (같은 분할은 같은 시점·방향)
  - 다중 분할 적층 / 거래정지 평탄(세그먼트 안 쪼개짐) / 무분할(단일 factor=1.0) / 부분·결측(upsert 거부)
- **킬러 속성 테스트 — 거래대금 불변**: derive 후 모든 행에서 `adj_price × adj_vol == raw_price × raw_vol`(반올림 내). 단, 이것만으론 부족(미보정도 불변) → 절대 레벨 골든 단언 병행.
- **action_detector(D1)**: 분할(−50%)·병합(+400%) 트리거 O / 정상 ±29% X / 거래정지 평탄 X / 신규상장 = 즉시-fetch 경로.
- **mocked-KIS(실패 주입)**: adj=True로 계수 fetch & 플래그+순환 종목만 호출 단언 / 한 종목 예외 → 나머지 정상·옛 계수 유지 / 빈·부분 → 거부.
- **백필 resumability**: 중단 후 재시작이 완료 종목 skip·완주 / flush 도중 kill → 토막 없음.
- **손상 폴백**: 손상 factors 주입 → derive가 adjust_splits 폴백, status=degraded, scan은 여전히 행 반환.
- **장중 가드**: 가짜 시계(now 파라미터) — 컷오프 전 오늘 행 드롭, 후 반영.
- **성능 회귀 가드**: 풀 코퍼스 scan < 2s(실측 0.6s) 유지.
- **자가검증 함정 해독제**: synthetic 단위테스트는 KIS API 드리프트(필드명·보정동작)를 못 잡음 → 골든 실측 앵커 + live smoke(실제 KIS golden 종목)로 보강.

---

## 7. 마이그레이션 & 임팩트 리포트

- **0단계 — 원주가 reconcile (1회)**: 기존 `daily_unadjusted` vs KIS(adj=False) 값 검증 + 디스크 결측일 KIS 보충(합집합). 스폿체크(7종목×2기간, 1585행): 값 100% 일치, 그러나 000660 등 커버리지 구멍 확인 → 전 종목 확대 시 보충 목록 산출. KIS 미도달 깊은 역사(예: 005930 1999)는 디스크 유지.
- 백필이 구(휴리스틱) vs 신(KIS 계수) 수정주가를 전 종목 비교해 **임팩트 리포트** 산출:
  어떤 종목(≈572)이 고쳐지는지, 조건별(new_high/ma/price_range/change_pct vs trade_value) 영향 범위 명시.
- 백필 1회 실행(운영, ~2~4h, resumable) 후 일일 흐름이 인계.
- 롤백: `factors.parquet` 격리 시 기존 `adjust_splits` 폴백이 자동 작동(전면 장애 없음).

---

## 8. 범위 밖 (YAGNI)

- 스캔 성능 최적화(<100ms, persistent DuckDB 등) — 0.6초로 충분.
- DB 피드 복원 — 외부 파이프라인(repo 밖), KIS 대비 이점 없음(DB엔 수정주가도 없음).
- 종목코드 변경/병합 추적.
- 현금배당 수정주가(KIS 관례상 미보정, 코퍼스도 불필요).

---

## 9. 열린 질문 (그릴링 대상)

- ~~EOD 확정 컷오프 시각~~ → **해결(D6): 16:00 KST 고정.**
- ~~순환 주기~~ → **확정: 월 1회 전 종목(1/30씩/밤)**(D5). 유상증자가 시장 전체 월 수 건이라 풀 스윕 월 1회로 충분. 순환율은 설정값으로 튜닝 가능.
- ~~백필 깊이 / 깊은 역사 폴백~~ → **해결(그릴링 Q2=A)**: KIS가 빈 응답 줄 때까지(60페이지 캡 풀어) 정확 계수, KIS 미도달 깊은 역사는 휴리스틱 폴백. 원주가는 디스크∪KIS 합집합(reconcile)으로 최대 커버리지.
- ~~기존 원주가 무결성 우려~~ → **해결(reconcile)**: 스폿체크 값 100% 일치, 커버리지 구멍만 KIS 보충.
- ~~factors.parquet 갱신 방식~~ → **확정: 전체 원자적 재작성.** 종목당 몇 줄(~1만 행)이라 사소하고 원자성·단순성 우위. 파티션 불요.
- ~~임팩트 리포트 형식·위치~~ → **확정: `screener/impact-report.json` 별도 artifact + 요약 로그.** status.json은 신선도 전용 유지(혼합 안 함).

> 그릴링 종료(2026-06-03): 위 5개 + 핵심 결정 전부 확정. ADR-0057 참조. 구현 플랜으로 이행.
