# 0056 — 관심종목·스크리너 드로어의 라이브 등락률/현재가는 KIS 직접·표시전용·세션게이트

**Status:** accepted (2026-06-02)

**Revision (2026-07-09):** 스크리너 결과 행의 표시 필드(현재가·등락률·전일대비)를 **순수 라이브 전용**으로 전환 — 라이브 미도착/stale·closed 등으로 quote 가 없으면 EOD 코퍼스로 폴백하지 않고 `—`로 둔다(관심종목과 완전히 동일한 표시 기준). 스캔 **필터**·정렬 초기값·`localStorage` 영속(드로어 `lastScan`)은 EOD 코퍼스를 그대로 유지한다(표시만 라이브). 아래 "표시 전용 (스크리너 스캔 필터 불변)"의 "결과 행은 EOD 위에 라이브를 덮는다" 서술과 Consequences의 "그 외 코퍼스 EOD 값 유지"는 이 개정으로 대체됨. 근거: `useScreenerRowsLive.ts`. (상위 30행 cap 은 2026-06-03 개정에서 이미 제거되어 결과 전 종목이 라이브 대상.)

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

## Amendment (2026-06-02)

표시 모델이 아래처럼 진화함 (결정 자체는 불변 — KIS 직접·표시전용·세션게이트 유지):

1. **전일대비 등락액 추가.** `LiveQuote`에 `change_won`(KIS `inter2_prdy_vrss`, 절대값에
   `prdy_vrss_sign` 적용 — `prdy_ctrt`와 동일 부호 규칙, 실측 확인) 추가. 패널 행은 현재가 +
   **등락액(원) + 등락률** 을 함께 표시. 필드명은 공식 `koreainvestment/open-trading-api`
   `chk_intstock_multprice.py` 컬럼 매핑으로 검증(= '관심2 전일 대비').
2. **QuoteRow 레이아웃 변경.** 종목코드 컬럼 제거, **이름(좌) / 현재가·전일대비(우) 2줄 스택**.
   등락 셀은 `ChangeCell` → 신규 `QuoteChange`(등락액+등락률, ▲▼ 글리프 없음 — 부호 있는
   등락액이 색맹 보조를 겸함). 종목코드는 `aria-label`/`testid`에만 잔존.
3. **세 번째 소비처: Live Status Bar.** `/live` 상태바가 활성 종목의 **등락률(%)만** 같은
   `useQuoteByCode`로 현재가 옆에 표시. 현재가는 기존대로 **RangeBundle(WS)** 에서 오므로
   *가격 출처 ≠ 등락 출처*(의도적, 좁은 상태바라 등락액은 생략·줄바꿈 방지). 위 "Negative /
   watch"의 "같은 종목이 surface별 다른 %" 목록에 이 변종이 하나 더해짐.

## Amendment (2026-06-03) — 상위 30 cap 제거(전 종목 라이브)

결정의 세 성질(KIS 직접·표시전용·세션게이트)은 불변. 표시 *범위*만 넓힌다.

1. **스크리너 라이브 cap 제거.** 드로어/풀페이지 모두 결과 *전 종목*의 현재가+등락률을
   라이브로 덮는다(기존: 드로어 상위 30행만, 풀페이지는 라이브 0). 관심종목과 동일 기준
   (장중=현재가, 장후=종가, 장전=`—`)으로 통일 — 사용자 요청.
2. **백엔드 무변경.** `KisClient.fetch_multi_price`가 이미 코드를 30개씩 청크로 쪼개
   동시 호출하고 합친다(`_MULTI_PRICE_CHUNK=30`은 `intstock-multprice` 호출당 한도).
   `/api/live/quotes`는 코드 수 제한이 없었고, cap은 프론트 `.slice(0,30)` 한 줄뿐이었다.
   그 한 줄 제거 + 풀페이지 `ResultTable`에 `useQuoteByCode` 오버레이 배선이 변경의 전부.
3. **풀페이지가 네 번째 소비처.** `/screener` 결과 테이블이 현재가+등락률을 라이브로
   표시(거래대금은 `intstock-multprice`에 없어 EOD 유지, 정렬도 EOD 거래대금 불변).
4. **"폴링 폭주" 가드 철회.** 원 ADR은 폭주 방지로 30 cap을 뒀으나 무제한으로 전환한다.
   worst-case는 scan limit 기본 1000행 → 1000/30 = **34콜/10초**. KIS 15콜/초 토큰버킷이
   10초 주기로 흡수(청크 동시호출 버스트도 버킷이 직렬화). 같은 코드 집합은 React Query
   queryKey(정렬된 코드 join)로 dedup. 실측 부담이 드러나면 후속으로 cap 재도입.
5. **필터≠표시 괴리 확대.** 위 "Negative / watch"의 "필터=EOD vs 표시=라이브" 불일치가
   이제 상위 30행이 아니라 **전 행**에 적용된다(의도적 수용 — 저녁 EOD 갱신 후 수렴).

## Amendment (2026-06-25) — `/screener` 명시적 장중 scan basis

기존 결정의 **Live Quote 표시용** 성질은 Watchlist Panel, Screener Panel, 기존 EOD scan 경로에
대해 유지한다. 단, 풀페이지 `/screener` 는 사용자가 직접 고르는 실행 옵션
`basis="intraday"` 를 추가해 스크리너 필터 자체가 KIS quote-derived 당일 OHLCV overlay 를
사용할 수 있게 한다.

1. **명시적 basis.** `/api/screener/scan` 기본값은 `basis="eod"` 로 보존한다. 풀페이지
   `/screener` 는 기본 선택을 `오늘 장중`으로 두고, 사용자가 `전일 확정`으로 되돌릴 수 있다.
   저장된 조건검색의 `{conditions, universe}` schema 에는 basis 를 저장하지 않는다.
2. **DuckDB overlay.** 조건별로 KIS 를 호출하지 않는다. KIS `intstock-multprice` 의 당일
   OHLCV 행을 짧은 TTL cache 로 만들고, scan 시 `daily_adjusted.parquet` 앞단의 `adj` relation 에
   query-time overlay 로 union 한다. 따라서 `new_high_today`, `change_pct`, `price_range`,
   `trade_value`, `new_high_vol_today` 등 기존 OHLCV 조건 컴파일러가 같은 경로로 동작한다.
3. **거래대금 의미 유지.** KIS raw 거래대금 필드가 아니라 기존 Screener 정의
   `(open+high+low+close)/4*volume` 을 계속 사용한다. full intraday support 는 batched quote 의
   누적 거래량(`volume`) 파싱 가능성에 의존한다.
4. **Fallback.** KIS 인증/호출 실패, 누적 거래량 결측, empty overlay 는 500 이 아니라 EOD scan +
   `intraday_fallback_eod` warning 으로 수렴한다. UI 는 이 fallback 을 사용자가 볼 수 있게 표시한다.
5. **Panel boundary.** Right-rail Screener Panel 은 이번 변경 범위 밖이다. 저장된 조건검색을 실행하는
   패널 scan 은 EOD corpus 기준이며, 행 표시만 Live Quote overlay 를 계속 쓴다.
