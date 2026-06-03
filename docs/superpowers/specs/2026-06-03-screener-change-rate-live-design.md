# 스크리너 등락률 — 전 종목 라이브 통일

**Date:** 2026-06-03
**Status:** approved (대화에서 합의)
**Related:** ADR-0056 (라이브 등락률 오버레이), ADR-0052 (Right Rail state)

## 배경 / 문제

스크리너에 표시되는 등락률의 "기준"이 화면마다 달라 관심종목(Watchlist)과 어긋난다.

| 화면 | 현재 등락률 기준 |
|---|---|
| 관심종목 드로어 | **전 행 라이브** (현재가 vs 전일종가, 10초 폴링) |
| 스크리너 드로어 | **상위 30행만 라이브**, 31행~는 EOD (`ScreenerDrawer.tsx:69` `.slice(0,30)`) |
| 스크리너 풀페이지 테이블 | **전부 EOD** (라이브 오버레이 0개, `ResultTable.tsx:39`) |

EOD = 마지막으로 빌드된 장마감 데이터(현재 20260602). 장중엔 보통 어제 종가 기준이라,
관심종목(라이브)과 나란히 보면 값이 다르게 보인다 — 사용자 혼동의 원인.

## 결정

스크리너의 **현재가 + 등락률**을 두 화면 모두 **전 종목 라이브**로 통일한다.
관심종목과 동일한 표시 기준(장중=현재가, 장후=당일종가, 장전=`—`)을 갖는다.

핵심 사실: 백엔드 `KisClient.fetch_multi_price`가 이미 코드를 30개씩 청크로 쪼개
동시 호출하고 합친다(`_MULTI_PRICE_CHUNK=30`은 KIS `intstock-multprice` 호출당 한도).
`/api/live/quotes`는 코드 개수 제한이 없다 → **백엔드 무변경**. 30 cap은 프론트 한 줄뿐.

## 변경 사항

### 1. 우측 패널 드로어 — `frontend/src/screener/ScreenerDrawer.tsx`
`liveCodes`에서 `.slice(0, 30)` 제거 → 결과 전 종목 코드를 `useQuoteByCode`에 전달.
나머지(`pct={q?.change_pct ?? r.change_pct}`, `price={q?.price ?? r.price}`)는 불변.

### 2. 풀페이지 테이블 — `frontend/src/pages/Screener.tsx` + `frontend/src/screener/ResultTable.tsx`
- `Screener.tsx`에서 결과 행 코드로 `useQuoteByCode(rows.map(r => r.code))` 호출.
- `ResultTable`에 `quoteByCode: Map<string, LiveQuote>` prop 추가.
- 셀 오버레이: **현재가** `q?.price ?? r.price`, **등락률** `q?.change_pct ?? r.change_pct`.
- **거래대금은 EOD 유지** — `intstock-multprice`에 거래대금 필드 없음(`KisQuote`는
  price/change_pct/change_won만). 정렬도 EOD 거래대금 그대로.
- 장전(`pre_open`)·무데이터 → 기존대로 `—` (`ChangeCell` null 분기 불변).

### 3. ADR-0056 개정 (Amendment 2026-06-03)
"상위 30 cap, 폴링 폭주 방지" → "전 종목 라이브"로 전환 기록. 필터=EOD vs 표시=라이브
괴리가 상위 30행 → **전 행**으로 확대됨(의도적 수용). 풀페이지 테이블이 라이브 소비처로
추가됨(현재가+등락률; 거래대금만 EOD).

## 가드 방침 — 무제한 (사용자 요청)

worst-case: scan limit 기본 1000행 → 1000/30 = **34콜/10초**. KIS 15콜/초 버킷이 10초
주기로 흡수 가능(버스트는 청크 동시호출이나 토큰버킷이 직렬화). 같은 코드 집합은
React Query queryKey(정렬된 코드 join)로 자동 dedup. **별도 cap 없음.** 실측 부담이
드러나면 후속으로 cap 도입(이 spec 범위 밖).

## 검증

- `npx vitest run src/pages/Screener.test.tsx src/screener/ScreenerDrawer.test.tsx` (+ 영향 테스트)
- `npx tsc -b`
- 기존 메모리: lint(eslint .)는 레포 부채로 게이트 아님 — 변경 파일만 0 errors 확인.
