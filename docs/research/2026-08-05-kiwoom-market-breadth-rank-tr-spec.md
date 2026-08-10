# 시장 종합 순매수·시장폭·업종 TR 실측 — ka10131 / ka10034 / ka90009 / ka10016 / ka10019 / ka20003

- 티켓: [#1096](https://github.com/Soochol/hoga-ops/issues/1096) (지도 [#1094](https://github.com/Soochol/hoga-ops/issues/1094))
- 조사일: 2026-08-05 **장중 10:47~11:05 KST** · 실계좌 프로브(`scripts/probe_kiwoom_rest_tr.py`)
- 앞선 실측: [`2026-08-05-kiwoom-market-overview-flow-tr-spec.md`](2026-08-05-kiwoom-market-overview-flow-tr-spec.md) (#1095)
- 토큰: 기존 캐시 재사용 — 신규 발급 없음(#1088 함정 회피).

## 요약

| TR | 경로 | 래퍼 키 | 행 | 판정 |
|---|---|---|---|---|
| **ka20003** | `/api/dostk/sect` | `all_inds_idex` | 31(KP)/34(KQ) | ✅ **업종지수 + 등락종목수 + 상·하한을 한 번에** |
| ka10131 | `/api/dostk/frgnistt` | `orgn_frgnr_cont_trde_prst` | 100 | ✅ 연속일수·금액·수량·기간등락률 전부 |
| ka10034 | `/api/dostk/rkinfo` | `for_dt_trde_upper` | 100 | ⚠ **수량만** — 금액 없음, ETF 혼입 |
| ka90009 | `/api/dostk/rkinfo` | `frgnr_orgn_trde_upper` | 15 | ⚠ **좌우 분할 스키마** — 순매수/순매도 종목이 한 행에 |
| ka10016 | `/api/dostk/stkinfo` | `ntl_pric` | 45 | ⚠ **목록만** — 카운트 없음(세야 한다) |
| ka10019 | `/api/dostk/stkinfo` | `pric_jmpflu` | 200+ | ⚠ 목록만, **커서 필요**(200행에서 안 끝남) |

**가장 중요한 결과: 지도가 "키움엔 등락종목수 TR 이 없다"고 적어 둔 전제가 틀렸다.**
`ka20003` 이 업종별·시장별 `rising`/`fall`/`stdns`/`upl`/`lst` 를 직접 준다(§1).
프로토타입의 지수 카드 ▲/▼ 표기와 시장 폭 타일의 상·하한이 **대용 지표 없이** 채워진다.

---

## 1. ka20003 — 전업종지수 (이 티켓 최대 수확)

```
/api/dostk/sect  api-id: ka20003
body {"mrkt_tp":"0","inds_cd":"001"}     ← inds_cd 필수(없으면 1511)
→ return_code 0, 래퍼 all_inds_idex, 31행, 15필드, 46ms, cont-yn=N
```

10:50 실측 (코스피):

```
stk_cd 001  종합(KOSPI)  cur_prc +6613.59  flu_rt +4.00  rising 739  fall 140  stdns 34  upl 0  lst 0
stk_cd 002  대형주        +7236.50         +4.13         89          8         2         0      0
stk_cd 003  중형주        +3902.20         +2.74         160         31        5         0      0
stk_cd 004  소형주        +2306.43         +1.76         405         84        17        0      0
stk_cd 005  음식료/담배   +4759.72         +0.12         38          8         1         0      0
```

코스닥은 `{"mrkt_tp":"1","inds_cd":"101"}` → 34행, `101 종합(KOSDAQ) +795.84 +1.94 rising 1332 upl 7`.

- **시장 전체 등락종목수가 `001`/`101` 행에 그대로 있다.** 상승/하락/보합/상한/하한 5종.
- 업종 지수 `cur_prc`·`flu_rt` 도 함께 온다 — `trde_qty`·`trde_prica`·`flo_stk_num`(상장주식수)까지.
- **코스피·코스닥 각 1콜, 총 2콜**이면 지수 카드 ▲/▼ + 시장 폭 상·하한 + KRX 업종 온도가 전부 채워진다.
- 코드 체계: 코스피 `001`~`030`+`603`~`605`, 코스닥 `101`~. `_AL` 접미가 없다(ka10051 은 `001_AL` — **두 TR 의 코드 표기가 다르다**).

**스케일 함정이 여기서 풀린다.** `ka20003` 은 `cur_prc +6613.59` / `flu_rt +4.00` 처럼
**소수점 포함 문자열**인데, `ka10051` 은 같은 지수를 `658091` / `349` 로 준다(×100 정수).
같은 값의 두 표기를 한 파서로 다루면 100배 틀린다 — TR 별 스케일 표를 배선에 둘 것.

### ka20003 vs ka10051 — 무엇을 쓸 것인가

| | ka20003 | ka10051 |
|---|---|---|
| 업종 지수 값 | ✅ 소수점 | ✅ ×100 |
| **등락종목수** | ✅ | ❌ |
| **투자자 순매수** | ❌ | ✅ (개인 포함 12주체) |
| 행 수 | 31 / 34 | 28 |

둘은 **대체재가 아니라 상보재**다. #1096 착수 시 "ka10051 이 업종지수를 주니 ka20003 은
불필요할 수 있다"고 적었으나, 등락종목수 때문에 **ka20003 을 배선하는 쪽이 맞다**.
업종 지수 값은 둘 중 하나만 신뢰하면 되고(스케일 단순한 ka20003 권장), ka10051 은
**수급 전용**으로 쓰면 역할이 깨끗하게 갈린다.

## 2. ka10131 — 기관·외국인 연속매매현황 (순매수 카드에 정확히 대응)

```
/api/dostk/frgnistt  api-id: ka10131
body {"dt":"1","mrkt_tp":"001","netslmt_tp":"2","stk_inds_tp":"0","amt_qty_tp":"0","stex_tp":"3"}
→ 래퍼 orgn_frgnr_cont_trde_prst, 100행, 19필드
```

필수 파라미터는 벤더가 `1511` 로 한 번에 하나씩 알려 준다(`mrkt_tp` → `netslmt_tp` 순으로 요구).

```
rank 1  035420_AL NAVER  prid_stkpc_flu_rt +10.84
        orgn_nettrde_amt +97544  orgn_nettrde_qty +428739  orgn_cont_netprps_dys +1 …
```

19필드가 프로토타입 순매수 카드의 요구를 그대로 덮는다:
- **연속일수** `frgnr_cont_netprps_dys` / `orgn_cont_netprps_dys` / `tot_cont_netprps_dys`
- **연속 누적** `*_cont_netprps_amt`(금액) · `*_cont_netprps_qty`(수량) — **양축 다 준다**
- **기간 등락률** `prid_stkpc_flu_rt` — 카드의 등락률 열
- 주체 분리가 필드 레벨이라 **외국인·기관 2카드 분할과 1:1 대응**(한 콜로 두 카드 채움)

### `netslmt_tp` 코드표 — **확정** (2026-08-10 실측, 캐시 토큰 2콜)

`2` = 순매수 · `1` = 순매도. 추정이 아니라 **정렬 축이 아닌 진짜 필터**임까지 갈렸다 —
두 응답의 종목 코드 집합 **교집합이 0**이다(각 100행).

```
netslmt_tp=1  외국인 연속일수 음수 65 / 양수 35   기관 음수 70 / 양수 30
netslmt_tp=2  외국인 연속일수 음수 40 / 양수 60   기관 음수 12 / 양수 88
```

세 가지가 배선을 좌우한다:

1. **방향으로 골라도 부호 필터가 필요하다.** 두 주체 값이 한 행에 같이 오므로 순매도
   응답에도 그 종목을 사들인 주체가 섞인다(위 양수 열). 방향만 믿으면 "순매도 상위"에
   +7일 행이 올라온다.
2. **음수 금액·수량은 마이너스 두 개**다(`amt='--940483'` · `qty='--4105152'`).
   연속일수는 `'-2'` 로 **하나뿐**이라 같은 행 안에서 표기가 갈린다.
   `signed_int` 의 폴딩(#1247)이 이걸 접는다.
3. **`rank` 는 연속 금액 순이 아니다.** 당일 순매매 대금(`nettrde_amt`) 내림차순이다
   (193432 · 185256 · 135670 … 단조감소). 그래서 주체별 카드에서는 금액 열과 순서가
   어긋나 보이는데, 이는 순매수 카드가 원래 갖고 있던 성질이다.

미확인으로 남은 것: `dt` 의 의미(연속 최소일수 필터인지 조회 기간인지)와 허용값.

## 3. ka10034 — 외인 기간별 매매 상위 (수량만 · ETF 혼입)

```
/api/dostk/rkinfo  api-id: ka10034
body {"mrkt_tp":"000","trde_tp":"2","dt":"5","stex_tp":"3"}
→ 래퍼 for_dt_trde_upper, 100행, 11필드
rank 1  252670_AL KODEX 200선물인버스2X  netprps_qty +4198427…
rank 2  005930_AL 삼성전자              netprps_qty +742916…
```

- **`netprps_qty` 만 있고 금액 필드가 없다.** 프로토타입 카드는 억원 표기이므로
  이 TR 로는 축이 안 맞는다 — **ka10131 의 `*_cont_netprps_amt` 를 쓰는 것이 옳다.**
- ETF 가 상위를 채운다(KODEX 인버스·레버리지). 순위 드로어처럼 ETF 제외 처리가 필요하다.
- `dt` 가 기간(일)으로 보이나 허용값 미확인.

## 4. ka90009 — 외국인·기관 매매 상위 (좌우 분할 스키마)

```
/api/dostk/rkinfo  api-id: ka90009
body {"mrkt_tp":"001","amt_qty_tp":"1","qry_dt_tp":"1","date":"20260805","stex_tp":"3"}
→ 래퍼 frgnr_orgn_trde_upper, 15행, 19필드
{"for_netslmt_stk_cd":"017670","for_netslmt_stk_nm":"SK텔레콤","for_netslmt_amt":"-2373",
 "pipe1":"", "for_netprps_stk_cd":"003490","for_netprps_stk_nm":"대한항공","for_netprps_amt":"1614", …}
```

**한 행에 서로 다른 종목 4개**가 들어간다(외국인 순매도/순매수 · 기관 순매도/순매수), 
`pipe1` 같은 구분자 필드까지 있는 화면 좌우 배치용 스키마다. 15행 = 각 축 15종목.
파싱이 특이하므로 쓰려면 **행을 4갈래로 분해**해야 한다. 순매수 카드 용도로는
ka10131 이 훨씬 깨끗해 **ka90009 는 배선 후보에서 내리는 것을 권한다**.

## 5. ka10016 / ka10019 — 시장 폭 (목록만, 카운트 없음)

```
ka10016 신고저가  /api/dostk/stkinfo  래퍼 ntl_pric     45행, cont-yn=N
  body {"mrkt_tp":"001","ntl_tp":"1","high_low_close_tp":"1","dt":"250", …}
  필드: stk_cd, stk_nm, cur_prc, flu_rt, high_pric, low_pric, trde_qty, pred_trde_qty_pre_rt …

ka10019 가격급등락  /api/dostk/stkinfo  래퍼 pric_jmpflu  200행, cont-yn=Y ← 안 끝난다
  필드: stk_cd, stk_nm, stk_cls, base_pric, cur_prc, base_pre, flu_rt, jmp_rt, trde_qty …
```

- 둘 다 **카운트를 주지 않는다** — 종목 목록이다. 시장 폭 타일의 숫자는 **행을 세서** 만든다.
- `ka10016`(신고가, `dt=250`≈52주)은 45행에서 커서가 끝나 1콜로 셀 수 있다.
- `ka10019`(급등)는 **200행에서 `cont-yn=Y`** — 전량 페이징해야 정확한 카운트가 나온다.
  타일 하나에 몇 콜을 쓸지는 유량 결정(#1099) 사안이다. `jmp_rt`(급등률) 임계로 좁히거나,
  "200+" 로 절사 표기하는 선택지가 있다.
- **상·하한 타일은 `ka20003` 이 이미 `upl`/`lst` 로 주므로 `ka10017` 은 불필요**하다
  (이 티켓에서 ka10017 은 호출하지 않았다 — ka20003 이 대체).

## 경로 탐색 기록 (1504 가 알려 준다)

벤더의 `1504:해당 URI에서는 지원하는 API ID가 아닙니다` 가 경로 탐색을 싸게 만든다.

| TR | 시도한 경로 | 정답 |
|---|---|---|
| ka10131 | rkinfo ✗ · stkinfo ✗ · mrkcond ✗ · instt ✗ · slb ✗ | **frgnistt** |
| ka90009 | frgnistt ✗ | **rkinfo** |
| ka10016 | rkinfo ✗ · mrkcond ✗ · sect ✗ | **stkinfo** |
| ka10019 | rkinfo ✗ · mrkcond ✗ | **stkinfo** |

즉 "기관·외국인 계열"이라고 경로가 같지 않다 — ka10131 은 `frgnistt`, ka90009 는 `rkinfo`다.

## 갭 / 후속

- **[결정: 지수 카드 등락종목수 표기](https://github.com/Soochol/hoga-ops/issues/1100) 의 전제가 바뀐다** — 대용 지표를 고를 필요 없이 `ka20003` 의 실측값을 쓰면 된다.
- **파라미터 코드표 미확정** — ka10131 `dt`, ka10034 `dt`, ka10016 `ntl_tp`/`high_low_close_tp`. 배선(#1101) 전에 값을 흔들어 확정할 것.
  (ka10131 `netslmt_tp` 는 2026-08-10 확정 — 위 2절.)
- **ka10019 페이징 비용** — 급등/급락 카운트의 정확도 vs 콜 수는 유량 결정(#1099)에서 다룬다.
- **배선 후보에서 내릴 것**: `ka10034`(금액 없음·ETF 혼입) · `ka90009`(좌우 분할 스키마) ·
  `ka10017`(ka20003 이 대체). 셋 다 ka10131/ka20003 으로 더 깨끗하게 얻는다.
