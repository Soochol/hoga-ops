# KOFIA 증시 주변 자금 오픈API 실측 — 예탁금 · 신용융자 · CMA

- 티켓: [#1098](https://github.com/Soochol/hoga-ops/issues/1098) (지도 [#1094](https://github.com/Soochol/hoga-ops/issues/1094))
- 조사일: 2026-08-05 · 실키 프로브(`scripts/probe_kofia_api.py`)
- 성격: 실측. 설계 판단은 하지 않는다 — 필드·단위·축·범위 조회 비용만 확정한다.
- 벤더: 공공데이터포털 `금융위원회_금융투자협회종합통계정보` (키움 아님 — 이 지도의 유일한 제3 벤더)

## 요약

| 카드 계열 | 오퍼레이션 | 필드 | 축 |
|---|---|---|---|
| 고객예탁금 | `/getSecuritiesMarketTotalCapitalInfo` | `invrDpsgAmt` | **날짜당 1행** |
| 신용융자 | `/getGrantingOfCreditBalanceInfo` | `crdTrFingWhl` | **날짜당 1행** |
| CMA | `/getCMAStatus` | `actBal` (`mngInvTgt='합계'`) | ⚠ **날짜당 다행** |

- **인증은 Decoding 키다.** 포털이 주는 Encoding 형(`%2B`·`%3D`)을 HTTP 클라이언트의
  `params=` 에 넘기면 **이중 인코딩**되어 인증이 깨진다. 프로브가 두 형태를 순서대로
  시도하게 만들어 뒀고, **첫 형태(decoded)가 통과**했다.
- **단위는 원(raw)이다.** 조·억이 아니다 — `invrDpsgAmt: "102825552619394"` = 102.8조원.
- **최신 우선 정렬**, `basDt` 로 특정일 조회 가능, `numOfRows=200` 도 한 콜에 온다.
- **T+2 확인**: 2026-08-05(수) 조회에 최신 행이 `20260803`(월). 08/01·02는 주말이라 없다.
- 봉투는 공공데이터포털 표준 — `response.header.resultCode/resultMsg` + `response.body.items.item[]`.
  `resultType=json` 을 주면 JSON 으로 온다.

---

## 1. 증시자금추이 — `/getSecuritiesMarketTotalCapitalInfo`

```
totalCount 1,169 (≈4.6년치 일별)
{"basDt":"20260803",
 "invrDpsgAmt":"102825552619394",          ← 투자자예탁금 = 카드의 '고객예탁금'
 "onbdDrvPrdTrRcAdvAmt":"48855892959199",  ← 장내파생상품 거래예수금
 "toCstRpchCndBndSlgBal":"108101861787453",← 대고객 RP 매도잔고
 "brkTrdUcolMny":"1566321843028",          ← 위탁매매 미수금
 "brkTrdUcolMnyVsOppsTrdAmt":"22370737743",← 미수금 대비 반대매매금액
 "ucolMnyVsOppsTrdRlImpt":"1.3"}           ← 반대매매 비중(%)
```

카드가 쓰는 것은 `invrDpsgAmt` 하나다. **반대매매 비중(`ucolMnyVsOppsTrdRlImpt`)은
공짜로 딸려 오는 과열 지표**라 나중에 쓸 여지가 있다(이번 범위 밖).

## 2. 신용공여잔고추이 — `/getGrantingOfCreditBalanceInfo`

```
totalCount 1,156
{"basDt":"20260803",
 "crdTrFingWhl":"27443853960691",     ← 신용거래융자 **전체** = 카드의 '신용융자'
 "crdTrFingScrs":"21614091173422",    ←   유가증권(코스피)
 "crdTrFingKosdaq":"5829762787269",   ←   코스닥
 "crdTrLndrWhl":"17040486631",        ← 신용거래대주 전체
 "crdTrLndrScrs":"14936076626", "crdTrLndrKosdaq":"2104410005",
 "sbscCapLn":"0",                     ← 청약자금대출
 "dpsgScrtMogFing":"24871212858268"}  ← 예탁증권담보융자
```

**시장별로 갈려 있다** — 카드는 전체(`crdTrFingWhl`)를 쓰지만, 코스피·코스닥 분리가
필요해지면 추가 콜 없이 같은 응답에서 얻는다.

## 3. 일자별 CMA현황 — `/getCMAStatus` ⚠ 축이 다르다

```
totalCount 14,028  (≈ 날짜당 8~10행)
{"basDt":"20260803","mngInvTgt":"MMF형","invrCtg":"개인","scrtCmpyCnt":"12",
 "actCnt":"2898589","actBal":"4237976374553"}
```

**다른 둘과 달리 날짜당 1행이 아니다.** 행이 `mngInvTgt`(MMF형·RP형·발행어음형·
종금형·**합계**) × `invrCtg`(개인·기관)으로 갈린다.

**합산할 필요는 없다 — `mngInvTgt="합계"` 행이 이미 있다.** 다만 `invrCtg` 가 개인·기관
둘로 갈리므로 **전체 CMA 잔액은 그 두 합계 행의 `actBal` 을 더한 값**이다. 유형별
소계를 전부 더하면 합계 행과 이중 계상된다.

관측된 첫 3행이 `(합계, 기관)`·`(합계, 개인)` 을 포함하므로, 한 날짜의 행 묶음에서
`mngInvTgt == "합계"` 만 골라 `actBal` 을 더하면 된다.

## 4. 범위 조회 비용

| 방식 | 콜 수 |
|---|---|
| 최신 1일 (일 1회 갱신) | 3 (오퍼레이션당 1) |
| 최근 120일 백필 — 예탁금·신용 | 각 1 (`numOfRows=120`, 최신 우선이라 그대로 최근 120일) |
| 최근 120일 백필 — CMA | 1 (`numOfRows≈1200`) 또는 페이지 분할 |

`numOfRows=200` 이 한 콜에 왔다. 일일 트래픽은 오퍼레이션당 10,000 이라 **백필까지
포함해도 한도의 1% 미만**이다.

## 갭 / 유의

- **`numOfRows` 실제 상한을 끝까지 밀어보지 않았다** — 200 까지만 확인했다. CMA 백필에서
  1,200 을 한 번에 요청할 수 있는지는 배선(#1101) 때 확인할 것.
- **휴장일 행이 없다** — 주말·공휴일은 아예 빠진다. 날짜 축을 그릴 때 빈 날을 만들지
  말고 **거래일만 이어 붙여야** 한다(달력 SSOT 와 교차할 필요는 없다 — 응답에 있는
  날짜가 곧 그 지표의 관측일이다).
- **T+2 는 관측이지 계약이 아니다.** 공시 지연이 바뀔 수 있으므로 화면은 항상 응답의
  `basDt` 를 기준일로 표기해야 한다(고정 "T+2" 문구를 박지 말 것).
