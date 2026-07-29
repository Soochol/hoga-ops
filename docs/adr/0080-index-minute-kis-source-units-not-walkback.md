# 0080 — KIS 대표지수 분봉은 날짜 walk-back이 아니라 source-unit 선택으로 확장한다

**Status:** accepted (2026-06-23) — **mapping 표 개정 (2026-07-29, #939)**

**Related:**
- ADR-0040 — Live Candle Backfill은 별도 cache namespace + 별도 wire
- ADR-0048 — /live D-direct daily backfill
- ADR-0060 — KIS 일별 walk-back 두 메서드는 통합 driver로 합치지 않는다
- `docs/superpowers/plans/2026-06-22-live-index-instruments.md`
- `docs/superpowers/plans/2026-06-23-index-minute-candle-cache.md`
- `docs/superpowers/plans/2026-06-23-index-minute-source-units.md`
- `docs/research/2026-07-29-kiwoom-index-minute-tr-spec.md` — 2026-07-29 재실측

## Decision

`/live` 대표지수 분봉은 종목 분봉(`inquire-time-dailychartprice`)의 날짜+시간
walk-back 모델로 일반화하지 않는다.

대표지수 분봉(`inquire-time-indexchartprice`, TR `FHKUP03500200`)은 KIS 요청에서
`FID_INPUT_HOUR_1`을 **조회 커서(HHMMSS)** 가 아니라 **source unit**으로 취급한다.
따라서 backend는 표시 timeframe별로 KIS가 주는 가장 넓은 exact source unit을 선택하고,
필요할 때만 app 쪽에서 상위 bucket으로 aggregate한다.

현재 mapping (**2026-07-29 개정** — 개정 근거는 아래 §mapping 개정):

| 표시 timeframe | KIS `FID_INPUT_HOUR_1` | 처리 |
|---|---:|---|
| 1m | `60` | 그대로 사용 |
| 3m | `180` | 그대로 사용 |
| 5m | `300` | 그대로 사용 |
| 10m | `600` | 그대로 사용 |
| 15m | `900` | 그대로 사용 |
| 30m | `1800` | 그대로 사용 |

즉 **표시 timeframe 6종은 모두 exact source가 존재하며 aggregate가 필요 없다.**
`_aggregate_index_minute_candles`는 위 목록에 없는 표시 버킷이 생겼을 때의 약수 폴백
경로 전용으로 남는다(예: 20m → `600` source 2개를 접음).

Index minute cache는 exact request repeat을 빠르게 하는 cache일 뿐, KIS가 반환하지 않은
과거 분봉을 만들어내는 paging layer가 아니다.

### mapping 개정 (2026-07-29, #939)

원안(2026-06-23)은 3m→`60`, 15m→`300`, 30m→`600`으로 잔 source를 골라 aggregate했다.
**원칙("가장 넓은 exact source unit 선택")은 옳았으나 후보 집합이 불완전했다** — 당시
실측한 unit은 `30`·`60`·`120`·`300`·`600`·`3600`이었고 **`180`·`900`·`1800`은 시험되지
않았다.**

응답이 주기와 무관하게 102 rows 고정이므로, 표시 버킷보다 잔 source를 고르면 커버
구간이 정확히 그 배수만큼 짧아진다. 2026-07-29 재실측에서 세 unit이 모두 유효함이
확인돼 표시 버킷 그대로 요청하도록 고쳤다:

| 표시 timeframe | 개정 전 | 개정 후 |
|---|---|---|
| 3m | 34봉 (당일 13:51~) | **100봉 (당일 10:33~)** |
| 15m | 34봉 (1거래일) | **94봉 (4거래일)** |
| 30m | 34봉 (2거래일) | **88봉 (6거래일)** |

1m은 변화 없다 — 102 rows가 곧 ~102분이고, 이것이 본 ADR이 말하는 depth 한계다.

부수 수정: `_aggregate_index_minute_candles`의 조기반환 조건이 `bucket_seconds <= 60`
이었다. 이는 "source는 항상 60 이하"라는 **원안 mapping의 가정이 상수로 박제된** 것이라,
source가 표시 버킷과 같아진 뒤에는 이미 3분봉인 데이터를 다시 3분 그리드로 접는 헛일이
된다. `<= source_seconds`로 일반화했다.

## Why

2026-06-23 live probe와 KIS official sample repo 확인 결과, 종목 분봉과 대표지수
분봉은 같은 이름의 `FID_INPUT_HOUR_1`을 서로 다르게 해석한다.

KIS official GitHub sample repo
(`koreainvestment/open-trading-api`)에는 대표지수/업종 intraday 후보가 몇 개 있다.

- `examples_llm/domestic_stock/inquire_time_indexchartprice/inquire_time_indexchartprice.py`
  - `/uapi/domestic-stock/v1/quotations/inquire-time-indexchartprice`
  - TR `FHKUP03500200`
  - `FID_PW_DATA_INCU_YN`를 `Y`(과거) / `N`(당일)로 설명한다.
  - `res.getHeader().tr_cont`가 `M` 또는 `F`이면 다음 호출을 하려는 구조가 있다.
- `examples_llm/domestic_stock/inquire_index_timeprice/inquire_index_timeprice.py`
  - `/uapi/domestic-stock/v1/quotations/inquire-index-timeprice`
  - TR `FHPUP02110200`
  - 시간별지수(분) endpoint지만, 현재 대표지수 코드(`0001`, `1001`, `2001`, `3003`)
    실측에서는 빈 `output`을 반환했다.
- `examples_llm/domestic_stock/inquire_index_tickprice/inquire_index_tickprice.py`
  - `/uapi/domestic-stock/v1/quotations/inquire-index-tickprice`
  - TR `FHPUP02110100`
  - 시간별지수(초) endpoint지만, 현재 대표지수 코드 실측에서는 빈 `output`을 반환했다.
- `examples_llm/domestic_stock/inquire_time_itemchartprice/inquire_time_itemchartprice.py`
  and legacy/Postman samples
  - `/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice`
  - TR `FHKST03010200`
  - legacy/Postman은 `FID_COND_MRKT_DIV_CODE=U`일 때 업종 조회간격 `60` 또는 `120`을
    넣을 수 있다고 설명한다.
  - 실측에서는 대표지수 rows가 나오지만 30 rows뿐이라 `FHKUP03500200`의 102 rows보다
    얕고, forced `tr_cont=N`도 같은 page를 반복했다.

따라서 "공식 샘플에 continuation 코드가 있다"는 사실만으로 지수 분봉 walk-back이
가능하다고 결론내리면 안 된다. 실제 production 응답 헤더가 다음 page 신호를 주는지,
그리고 다음 호출이 다른 rows를 반환하는지가 계약의 기준이다.

| 축 | 종목 분봉 | 대표지수 분봉 |
|---|---|---|
| endpoint | `/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice` | `/uapi/domestic-stock/v1/quotations/inquire-time-indexchartprice` |
| TR | `FHKST03010230` | `FHKUP03500200` |
| 날짜 param | `FID_INPUT_DATE_1` 필수 | 없음 |
| 시간 param 의미 | `153000` 같은 조회 anchor | `30`, `60`, `300`, `600`, `3600` 같은 source unit |
| paging | 날짜+HHMMSS anchor로 1년 보관분 walk-back 가능 | `tr_cont` 강제 지정해도 같은 page 반복 |

검증한 서버 동작:

- `FID_INPUT_DATE_1=20260619`를 지수 분봉에 추가해도 KIS는 이를 무시하고 최신 page를 반환한다.
- `FID_INPUT_HOUR_1=153000`은 15:30 anchor가 아니라 큰 source unit처럼 해석되어 하루 3개 수준의 coarse rows를 반환한다.
- `FID_PW_DATA_INCU_YN=Y`는 캔들 배열(`output2`)을 받기 위해 필요하다. `N`은 정상 응답이지만
  대표지수 분봉 rows는 0개다.
- 초기 호출 응답 header `tr_cont`는 빈 문자열이다. 즉 공식 샘플의 조건(`M` 또는 `F`)상
  다음 page를 호출할 신호가 없다.
- request header `tr_cont=N` 또는 `tr_cont=M`을 강제로 넣어도 older page가 아니라 같은 rows를 반환한다.
- `60` source는 1m/3m에 필요한 최신 100여 rows만 제공한다.
- `300` source는 5m/15m에서 더 넓은 날짜 분포를 제공한다.
- `600` source는 10m/30m에서 더 넓은 날짜 분포를 제공한다.
  > ⚠️ 위 세 줄은 **원안 mapping 기준**이다. 2026-07-29 개정 후 3m/15m/30m은 각각
  > `180`/`900`/`1800` source를 쓴다(§mapping 개정).

2026-06-23 재측정 결과:

| endpoint | index codes | units | initial `tr_cont` | forced `tr_cont=N` |
|---|---|---|---|---|
| `FHKUP03500200` | `0001`, `1001`, `2001`, `3003` | `30`, `60`, `120`, `300`, `600`, `3600` | empty | 같은 102 rows 반복 |
| `FHPUP02110200` | `0001`, `1001`, `2001`, `3003` | `60`, `120`, `300`, `600` | empty | `output=[]` |
| `FHPUP02110100` | `0001`, `1001`, `2001`, `3003` | n/a | empty | `output=[]` |
| `FHKST03010200` with `FID_COND_MRKT_DIV_CODE=U` | `0001`, `1001`, `2001`, `3003` | `60`, `120` | empty | 같은 30 rows 반복 |
| Postman `inquire-daily-indexchartprice` path + `FHKST03010200` time params | `2001` spot check | `60` | empty | same as `FHKST03010200` 30 rows |

따라서 "종목 분봉과 같은 page-walk를 지수 분봉에도 추가"하는 구현은 KIS 계약을
오해한 것이다. 올바른 backend lever는 source-unit 선택이다.

### 2026-07-29 재측정 — 지원 unit 집합 보강

`FHKUP03500200`, `FID_INPUT_ISCD=0001`, 모두 102 rows 반환:

| `FID_INPUT_HOUR_1` | 1페이지 커버 시작 |
|---:|---|
| `60` | 당일 13:53 |
| **`180`** | **당일 10:33** |
| `300` | 1거래일 전 |
| **`900`** | **4거래일 전** |
| **`1800`** | **6거래일 전** |
| `3600` | 약 3주 전 |
| `1000` · `100000` (HHMMSS anchor 가설 재확인) | **0 rows** |

굵은 세 값이 원안에서 누락됐던 unit이다. `1000`/`100000`이 0 rows인 것은 본 ADR의 핵심
결론(이 필드는 anchor가 아니라 unit selector)을 한 번 더 확증한다 — 목록 밖 값은 조용히
빈 응답이 되므로, 새 표시 버킷을 추가할 때는 반드시 실측으로 지원 여부를 확인해야 한다.

## Consequences

- `KisClient.fetch_index_minute_candles`는 날짜 cursor loop를 갖지 않는다.
- `/api/live/index-candles` minute branch는 `from/to`를 KIS param으로 밀어 넣지 않고,
  KIS가 반환한 rows를 local filter (+ 폴백 경로에서만 aggregate) 한다.
- **1m 지수 분봉의 과거 scrollback은 최신 `60` source page(~102분)에 제한된다.** 이것이
  본 ADR로는 풀 수 없는 잔여 한계다.
- 3m~30m는 각자의 exact source unit으로 102봉을 받는다 — 3m 5시간, 15m 4거래일,
  30m 6거래일 (2026-07-29 개정 후).
- 지수 분봉 cache hit는 UX latency를 줄이지만, cold load 자체의 KIS row depth 한계는 해결하지 않는다.
- 진짜 장기 지수 분봉 이력이 필요하면 별도 source가 필요하다: KIS 실시간 index stream을 자체 축적하거나, KRX/벤더/DB feed를 도입해야 한다.

## Trigger Conditions

다음 중 하나라도 확인되면 본 ADR을 재검토한다:

- KIS가 `inquire-time-indexchartprice`에 공식 날짜 cursor parameter를 추가한다.
- KIS가 지수 분봉에서 `tr_cont` 기반 older-page contract를 문서화하고 실제로 다른 page를 반환한다.
- KIS가 `FID_INPUT_HOUR_1`의 의미를 source unit에서 HHMMSS anchor로 변경한다.
- 제품 요구가 "KIS REST 최신 page" 수준을 넘어 장기 지수 intraday history를 필수로 요구한다.
  → **2026-07-29 발동.** 1m depth 한계(~102분)가 `/live` 지수 차트를 사실상 비워
  보이게 한다는 사용자 리포트. 별도 source 후보로 키움 `ka20005`(900행/페이지 +
  `cont-yn` 연속조회)를 실콜 검증했고, 채택 여부는 ADR-0129에서 다룬다. 본 ADR의
  결론(**KIS 안에서는 source-unit 선택이 옳다**)은 그와 무관하게 유효하다.
