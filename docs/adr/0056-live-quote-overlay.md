# 0056 — 관심종목·스크리너 드로어의 라이브 등락률/현재가는 KIS 직접·표시전용·세션게이트

**Status:** accepted (2026-06-02)

**Related:**
- ADR-0052 (Global Right Rail state store) — 등락률을 얹는 두 패널(Watchlist/Screener Drawer)이 사는 곳.
- ADR-0038 (Live Capture는 WebSocket 아닌 REST 폴링) / ADR-0050 (KIS rate-limit retry는 KisClient 내부) — 10초 폴링·단일 ingress 재사용의 근거.
- `docs/superpowers/plans/2026-06-01-live-quote-watchlist-screener.md` — 이 ADR이 근거를 기록하는 구현 계획.
- `CONTEXT.md` **Live Quote / Watchlist Panel / Screener** 항목.

## Decision

Watchlist Panel(P1)과 Screener Drawer(P2) 행에 표시하는 **현재가 + 등락률**은 KIS **`intstock-multprice`**(TR `FHKST11300006`, 30종목/콜)를 신규 `GET /api/live/quotes`로 받아 **10초 폴링**한다. 세 가지 성질을 못박는다:

1. **KIS 직접 (스크리너 코퍼스 아님).** 등락률은 글로서리상 Screener realm 개념이지만, 표시값은 스크리너 일봉 코퍼스(`daily_adjusted.parquet`)를 재사용하지 **않는다**. Watchlist Panel이 Screener 서브시스템 시드 여부에 의존하지 않도록(realm 분리 유지) KIS 라이브를 직접 쓴다.
2. **세션 게이트.** `_market_phase`가 KST 09:00 이전(장전)이면 `change_pct=null`(프론트 `—`). 장중/장마감 후에는 KIS `prdy_ctrt`가 각각 현재가 기준/종가 기준 등락률을 그대로 준다(실측 확인 — 장외에도 0이 아닌 종가 기준값 반환). 오픈 09:00은 반장에도 동일해 경계 하나로 충분.
3. **표시 전용 (스크리너 스캔 필터 불변).** 스크리너 스캔/필터는 EOD 코퍼스 그대로다. 라이브는 결과 행의 *표시 컬럼*만 덮는다(P2는 상위 30행 cap).

행은 각 KIS 응답 행의 **`inter_shrn_iscd`(종목코드)로 매핑**한다(요청 위치 zip 아님). 공유 `QuoteRow` + `useQuotes` 훅을 두 드로어가 재사용한다.

## Context

원 요청은 "관심종목 리스트를 스크리너 리스트처럼"이었으나, 그릴링으로 "두 패널 모두 장중 실시간/장전 숨김/장마감 종가 등락률"로 확장됐다. 핵심 갈림길에서 KIS 직접 경로가 선택됐고(아래 대안), 그 과정에서 두 가지 의미 충돌이 드러나 해소됐다: ① "라이브"라 했지만 스크리너 등락률은 본디 EOD다 → KIS `intstock-multprice`가 장중엔 현재가 기준 실시간을 주므로 KIS 직접이 오히려 원의도("라이브")에 더 부합. ② 스크리너에서 "찾기(필터)"와 "표시"가 어긋날 수 있다(장중 어제 EOD로 걸러 오늘 라이브 표시) — 의도적 수용.

## Alternatives considered

### A. 스크리너 코퍼스 재사용 (기각)
같은 종목이 두 패널에서 100% 동일 % → 일관성·배치 1콜. 그러나 Watchlist Panel이 Screener 코퍼스 시드에 의존(미시드면 전부 `—`)하고 realm을 결합. 사용자가 명시적으로 거부.

### B. 필터도 라이브 (전 시장 실시간 스캔) (기각)
"오늘 장중 ≥조건"을 시장 전체에서 찾으려면 매 조회마다 전 종목(수천) 라이브 시세(≈수십~백 콜)가 필요하고, 신고가·이동평균 조건은 과거 일봉이 필수라 라이브 불가. 무겁고 일부 조건과 충돌.

### C. KIS 직접 + 표시 전용 (채택)
realm 분리 유지, 시드 의존 0, `prdy_ctrt` 한 필드로 세션단계 대부분 해결, 결과/관심종목 코드(≤30)만 1콜. 필터≠표시 괴리는 장중에만 발생하고 저녁 EOD 갱신 후 수렴.

## Consequences

**Positive:** Watchlist Panel이 Screener와 독립. 30종목/콜이라 관심종목·스크리너 상위 30은 보통 1콜/10초 — KisClient 15콜/초 버킷에 여유. `inter_shrn_iscd` 매핑이라 KIS가 무효 코드를 빈 placeholder 행으로 채우거나 순서를 바꿔도 값이 엉뚱한 종목에 안 붙음(실측: 무효 코드는 빈 행으로 슬롯 유지). 어떤 fetch 오류도 빈 결과로 graceful(폴링이 절대 500 안 냄).

**Negative / watch:** 같은 종목이 관심종목(라이브)과 스크리너 결과(상위30 라이브/그 외 코퍼스 EOD), 그리고 스크리너 *필터 기준*(EOD)에서 장중 서로 다른 %로 보일 수 있다 — 의도적이나 사용자 혼동 여지. 스크리너 라이브는 **상위 30행만**(scan limit 기본 1000) — 그 이상은 코퍼스 EOD 값 유지(폴링 폭주 방지). 장전(거래일 09:00 이전) 숨김 규칙은 주말 이른 아침에도 잠깐 `—`(무해; 거래일 정밀 판정이 필요해지면 calendar로 보강).

## Scope boundary

P1(관심종목 Drawer)은 출하됨. P2(스크리너 Drawer)는 동일 `QuoteRow`/`useQuotes`를 재사용해 표시값만 라이브로 전환(필터 불변, 상위 30 cap). 전체 페이지 `/watchlist`·`/screener` 편집 UI는 범위 밖.
