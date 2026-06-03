# 0057 — Screener 일봉: KIS 정식 소스 + 수정주가 계수 테이블(factor store)

**Status:** accepted (2026-06-03)

**Related:**
- `docs/superpowers/specs/2026-06-02-screener-daily-update-design.md` — 이 ADR이 근거를 기록하는 스펙(실측 데이터 포함).
- ADR-0048 (live-daily-direct-backfill) — KIS 일봉 endpoint(FHKST03010100)·수정주가 플래그(`FID_ORG_ADJ_PRC`) 출처.
- ADR-0050 (kis-rate-limit-retry-in-client) — 15콜/초 leaky-bucket 제약의 근거.
- `CONTEXT.md` **Screener** 항목 — 원주가/수정주가 2단 코퍼스 정의.
- `hoga/api/screener_store.py` `adjust_splits` — 강등될 로컬 휴리스틱.

## Decision

스크리너 일봉 코퍼스를 다음으로 전환한다:

1. **원주가 권위 소스 = KIS**(`adjust=False`). dev-tradingview DB는 은퇴(1회 시드 잔재로만 보관, 재시드 안 함). 단 기존 원주가를 **KIS와 1회 교차검증(reconcile)** 하여 값 검증 + 디스크 결측일 보충 + KIS 미도달 깊은 역사 유지(= 디스크∪KIS **합집합**).
2. **수정주가 = 원주가 × KIS 계수**(factor store). `factors.parquet`(`code, seg_start, factor=adj/raw`)을 KIS 수정주가(`FID_ORG_ADJ_PRC=0`)에서 산출해 저장하고, derive는 ASOF 조인으로 적용. 기존 로컬 휴리스틱 `adjust_splits`는 폐기하지 않고 **(i) 코퍼레이트 액션 감지 트리거 (ii) 손상/깊은역사 폴백**으로 강등.
3. **검색 레이어(DuckDB-over-parquet)는 불변** — 소스 전환과 무관.

## Context

- **DB는 사실상 멈췄다**: `ohlcv_daily` max_date 2026-05-14(~13거래일 stale). parquet은 KIS append로 오늘까지 최신 — KIS가 이미 실질 소스. DB는 hoga에서 `seed_all`(1회 CLI) 외 미참조.
- **KIS 수정주가는 거래량도 보정한다**(실측): 삼성 50:1·카카오 1:5 모두 가격·거래량에 동일 계수 → 거래대금 보존. "거래량 미보정" 우려는 거짓.
- **현 수정주가는 분할 종목 64%(572/887)가 미보정**(실측): 로컬 ±3% 깨끗한-비율 매칭이 실현 ex-date 비율(거래정지 평탄가·시세변동·우선주 디스카운트로 drift)을 놓침. 카카오는 +398% 틀림. 005935(우선주)는 본주와 비일관. 이는 정확도 폴리시가 아니라 **정합성 버그**.
- **거래대금 불변은 정확성 보증이 아니다**: 미보정 종목도 불변이라, 절대 레벨을 쓰는 `new_high`/`new_high_vol`/`ma`/`price_range`/`change_pct`가 현재 틀린 결과를 낸다.
- **기존 원주가 값은 신뢰 가능**(실측 reconcile 스폿체크 1585행 100% 일치)이나 **커버리지 구멍**이 있다(000660 디스크 2015~, KIS는 2010 보유). 소스마다 구멍이 달라 합집합이 최선.

## Alternatives considered

### A. 매일 KIS 수정주가 전량 재수신 (기각)
정확하나 ~22만 콜/밤(~4h). 비용으로 불가. 1999 미도달로 깊은 역사 손실.

### B. 계수 테이블 (채택)
평소 KIS 0(원주가 갭만), 액션 종목만 계수 재수신. 기존 "원주가 SSOT + 싼 로컬 재파생" 구조의 두뇌만 교체. compact·update-friendly·today-basis 자동 처리(종목별 계수 재계산). 깊은 역사 유지.

### C. KIS 수정주가 값을 직접 저장 (기각)
개념은 단순하나 (i) today-basis라 분할마다 그 종목 전체 재다운로드(업데이트 문제 재발) (ii) 1999 손실 (iii) 8.5M행 추가 저장. 운영에서 더 복잡.

### D. KIS-only 온디맨드(파quet 없음) (기각)
실측: 전 종목 1회 스캔 ~63분(15콜/초 하한)~290분(직렬). parquet 0.6초 대비 ~6000~30000배. 캐시로 빠르게 하면 그 캐시가 곧 parquet. 사실상 사용 불가.

### E. 휴리스틱 유지 + KIS 교정 (기각)
진실원천 2개(추정+교정) 혼란. "결국 정확"이지 "항상 정확" 아님. B가 깔끔한 종착점.

## Consequences

**Positive:** 64% 정합성 버그 해소. 계수가 KIS 정확값이라 휴리스틱의 ±3% 스냅/누락 제거(카카오 4.982 등). 거래대금 보존 그대로. 검색 0.6초 유지. 깊은 역사(디스크 1999) + 커버리지(KIS) 합집합으로 최대 커버리지.

**Negative / watch:**
- 코퍼레이트 액션 **감지(D1: 단일일 ±30% 한계 초과)**가 유상증자 소량 희석(<30%)을 놓칠 수 있음 → 월 1회 전 종목 순환 안전망으로 한 달 내 자가 교정.
- KIS 미도달 깊은 역사(예: 1999~2002)는 휴리스틱 폴백 → 그 구간 정확도는 현 수준(스캔이 거의 안 닿음).
- 최초 1회 백필(~2~4h, resumable) + 원주가 reconcile(~4.5h) 운영 비용.
- 강등된 휴리스틱(`adjust_splits`)을 감지 트리거+폴백으로 유지 → 완전 삭제 아님.

## Scope boundary

검색 레이어·조건 카탈로그·SavedScreener·`/scan` API는 **불변**. 현금배당 수정주가는 안 함(KIS 관례·코퍼스 불필요). 종목코드 변경/병합 추적은 범위 밖.
