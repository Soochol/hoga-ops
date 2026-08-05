# 시장 종합 수급·프로그램 TR 실측 — ka10064 / ka10051 / ka90005 / ka90010

- 티켓: [#1095](https://github.com/Soochol/hoga-ops/issues/1095) (지도 [#1094](https://github.com/Soochol/hoga-ops/issues/1094))
- 조사일: 2026-08-05 **장중 10:33~10:45 KST** · 실계좌 프로브(`scripts/probe_kiwoom_rest_tr.py`)
- 성격: 실측. 설계 판단은 하지 않는다 — 대응 여부·필드·스코프·축만 확정하고 갭을 목록화한다.
- 토큰: 기존 캐시(`.local/kiwoom-token.json`, 만료 18:11) **재사용** — 신규 발급 없음(#1088 함정 회피).

## 요약

| TR | 경로 | 래퍼 키 | 스코프 | 판정 |
|---|---|---|---|---|
| ka10064 | `/api/dostk/chart` | `opmr_invsr_trde_chart` | **종목 전용** | ❌ 시장 종합엔 **못 쓴다** |
| ka10051 | `/api/dostk/sect` | `inds_netprps` | **시장 + 업종 28행** | ✅ 장중 잠정까지 — **1콜로 3가지** |
| ka90005 | `/api/dostk/mrkcond` | `prm_trde_trnsn` | 시장(P00101) | ✅ 1분 누적 시계열 |
| ka90010 | `/api/dostk/mrkcond` | `prm_trde_trnsn` | 시장(P00101) | ✅ 일자별 ~100거래일 |

**가장 중요한 결과 둘.**

1. **`ka10064` 는 시장 스코프가 없다.** 프로토타입 A 의 "투자자 수급 [당일]" 모드가
   이 TR 을 원천으로 상정했는데 성립하지 않는다 — 대체 설계가 필요하다(아래 §1).
2. **`ka10051` 한 콜이 세 가지를 준다** — 시장 전체 3주체 순매수 · 업종별 3주체 순매수 ·
   **업종 지수 현재가/등락률**. 마지막 항목 때문에 `ka20003`(전업종지수)이 불필요해질 수
   있다(#1096 에서 확인할 것).

---

## 1. ka10064 — 장중투자자별매매차트 (종목 전용, 시장 불가)

```
/api/dostk/chart  api-id: ka10064
body {"stk_cd":"005930","amt_qty_tp":"1","trde_tp":"0","mrkt_tp":"0"}
→ return_code 0, 래퍼 opmr_invsr_trde_chart, 3행, 9필드, 49ms, cont-yn=N
필드: tm, frgnr_invsr, orgn, invtrt, insrnc, bank, penfnd_etc, etc_corp, natn
```

**스코프 실측 (3안 전부 시도):**

| 시도 | 결과 |
|---|---|
| `stk_cd:"005930"` | 정상, 3행 |
| `stk_cd:"001"` (코스피 지수 코드) | `return_code 0` 이지만 **`opmr_invsr_trde_chart` 가 빈 값** — 지수 코드를 안 받는다 |
| `stk_cd:""` + `mrkt_tp:"001"` | `return_code 2` — `1511:필수 입력 값에 값이 존재하지 않습니다. 필수입력 파라미터=stk_cd` |

`stk_cd` 는 우회 불가한 필수값이고 지수 코드도 받지 않는다. **시장 전체 장중 투자자
시계열을 이 TR 로 만들 수 없다.**

**두 번째 결손: 개인이 없다.** 필드에 개인(`ind_*`)이 아예 없다 — 외국인·기관계와
기관 세부(투신·보험·은행·연기금)·기타법인·국가뿐이다. 프로토타입의 3주체(개인·외국인·
기관) 구성은 이 TR 로는 2주체가 된다.

**세 번째: 슬롯이 불규칙하다.** 10:33 시점 실측 3행 —

```
tm 090000  frgnr_invsr 0       orgn 0
tm 092000  frgnr_invsr 73709   orgn 0
tm 095700  frgnr_invsr 96974   orgn -52807  invtrt -35815  penfnd_etc -16645
```

30분 고정 격자가 아니라 **벤더 갱신 시점마다** 행이 붙는다(09:00 → 09:20 → 09:57).
값은 **누적**이다(외국인 73709 → 96974). 차트의 x축을 고정 격자로 가정하면 안 된다.

## 2. ka10051 — 업종별투자자순매수 (시장 스코프 O · 장중 잠정 O · 업종지수 동봉)

```
/api/dostk/sect  api-id: ka10051
body {"mrkt_tp":"0","amt_qty_tp":"0","base_dt":"20260805","stex_tp":"3"}
→ return_code 0, 래퍼 inds_netprps, 28행, 20필드, 58ms, cont-yn=N
```

**장중 호출에서 당일 잠정치가 나온다** (10:35 실측, 0 이 아님):

```
inds_cd 001_AL  inds_nm 종합(KOSPI)  ind_netprps -8787  frgnr_netprps +6473  orgn_netprps +1893  cur_prc +658091  flu_rt 349
inds_cd 002_AL  대형주               -8891              +6861               +1636               +719873        359
inds_cd 003_AL  중형주               +342               -663                +308                +389456        254
inds_cd 004_AL  소형주               -45                +32                 -0                  +230454        168
```

- **`001_AL` = 종합(KOSPI)** → 시장 전체 행이 목록 안에 있다. 별도 TR 이 필요 없다.
- **개인이 있다** (`ind_netprps`) — ka10064 의 결손이 여기서는 없다.
- 주체 20필드: `ind_`(개인) · `frgnr_`/`native_trmt_frgnr_`(외국인/대차외국인) ·
  `orgn_`(기관계) · `invtrt_`·`insrnc_`·`bank_`·`endw_`·`samo_fund_`·`jnsinkm_`·`sc_`·
  `natn_`·`etc_corp_`(세부) + `cur_prc`·`flu_rt`·`pred_pre`·`pre_smbol`·`trde_qty`.
- **업종 지수가 같이 온다** — `cur_prc`/`flu_rt` 가 업종 지수의 현재가·등락률이다.
  28행이 KOSPI 종합 + 규모별(대/중/소형주) + KRX 업종 전체를 덮는다.
- 코드 체계는 `NNN_AL` (`001_AL`~`030_AL`, 022·023 결번).

**미확정 2건 (백엔드 배선 티켓으로 넘긴다):**
- **단위** — `amt_qty_tp:"0"` 으로 받은 값의 단위(백만원/억원/주)를 확정하지 못했다.
  `amt_qty_tp` 를 뒤집어 대조하는 것이 판별법.
- **`cur_prc`/`flu_rt` 스케일** — `658091`·`349` 의 소수점 위치. 기존 `ka20001` 경로가
  같은 지수를 이미 가져오므로 **교차 대조가 가능**하다.

## 3. ka90005 — 프로그램매매추이 시간대별 (경로가 `mrkcond` 다)

경로 탐색 실측 — 벤더가 `1504` 로 알려 준다(`해당 URI에서는 지원하는 API ID가 아닙니다`):
`rkinfo` ✗ · `stkinfo` ✗ · `sect` ✗ · `chart` ✗ · **`mrkcond` ✓**.

```
/api/dostk/mrkcond  api-id: ka90005
body {"date":"20260805","amt_qty_tp":"1","mrkt_tp":"P00101","min_tic_tp":"0","stex_tp":"3"}
→ return_code 0, 래퍼 prm_trde_trnsn, 100행/페이지, 18필드, 165ms, cont-yn=Y (커서 있음)
```

18필드 = `cntr_tm` + 3계열 × (`buy`/`sel`/`netprps` × 금액·수량) + `kospi200` + `basis`:
`dfrt_trde_*`(**차익**) · `ndiffpro_trde_*`(**비차익**) · `all_*`(전체).

```
cntr_tm 103905  dfrt +20885  ndiffpro +324718  all +345603  kospi200 +103645  basis 2.80
cntr_tm 103859  dfrt +20885  ndiffpro +321741  all +342625  kospi200 +103644  basis 2.56
cntr_tm 103759  dfrt +24153  ndiffpro +314259  all +338412  kospi200 +103538  basis 2.02
… 100행째 cntr_tm 090055
```

- **최신 우선 역순**, 간격 ~1분, 값은 **당일 누적**(프로토타입의 누적 라인에 그대로 맞는다).
- 100행이면 09:00~10:39 를 덮는다 — 하루 전체(약 380분)는 **커서 4페이지**가 필요하다.
- 덤으로 `kospi200` 과 `basis`(베이시스)가 온다 — 차익거래 해석의 맥락.

## 4. ka90010 — 프로그램매매추이 일자별 (같은 경로·같은 래퍼, 축만 다름)

```
/api/dostk/mrkcond  api-id: ka90010   (body 동일, min_tic_tp:"1")
→ 래퍼 prm_trde_trnsn, 100행, 18필드, 59ms, cont-yn=Y
cntr_tm 20260805000000  dfrt +20885    ndiffpro +328785    all  349669   kospi200 +1037.95
cntr_tm 20260804000000  dfrt -321620   ndiffpro -636224    all -957844   kospi200 +1000.03
cntr_tm 20260803000000  dfrt -505745   ndiffpro -3211478   all -3717224  kospi200 +986.72
… 100행째 20260312000000
```

- `cntr_tm` 이 **날짜**(`YYYYMMDD000000`) — 응답 스키마가 ka90005 와 동일하고 **축만 바뀐다**.
- 100행 = 약 5개월(3/12~8/5). 프로토타입의 20일 뷰는 **1페이지로 충분**하다.
- 오늘(08/05) 행이 **장중에도 들어온다** — 마지막 값이 당일 잠정.

**⚠ 함정: 같은 이름의 필드인데 스케일이 다르다.** `kospi200` 이 ka90005 에서는
`+103645`(정수, ×100), ka90010 에서는 `+1037.95`(소수점). 한 파서로 두 TR 을 처리하면
조용히 100배 틀린다.

## 갭 / 후속

- **시장 장중 투자자 시계열의 원천이 없다** — ka10064 로는 불가. ka10051 을 폴링해
  시계열을 우리가 적재하는 방안이 유일해 보이나, 이는 설계 결정이므로 지도의 새 티켓
  ([당일 수급 모드 원천 재설계](https://github.com/Soochol/hoga-ops/issues/1104))에서 다룬다.
- **ka20003 무용화 가능성** — ka10051 이 업종 지수를 동봉하므로 #1096 에서 두 TR 의
  업종 커버리지를 비교해 판단할 것.
- **단위·스케일 확정** — ka10051 금액 단위, ka90005/90010 금액 단위, `kospi200` 스케일
  차이. 백엔드 배선(#1101)에서 기존 `ka20001` 경로와 교차 대조.
