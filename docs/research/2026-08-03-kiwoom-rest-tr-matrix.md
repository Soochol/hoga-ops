# 키움 REST 대응 매트릭스 — KIS 11개 표면 × 키움 TR

- 티켓: [#1007](https://github.com/Soochol/hoga-ops/issues/1007) (지도 [#1005](https://github.com/Soochol/hoga-ops/issues/1005))
- 조사일: 2026-08-03 · 실계좌 프로브(`scripts/probe_kiwoom_rest_tr.py`, [#1006](https://github.com/Soochol/hoga-ops/issues/1006))
- 성격: 실측. **설계 판단은 하지 않는다** — 대응 여부·필드·접근 패턴만 확정하고 갭을 목록화한다.

## 요약

| | |
|---|---|
| 대응 확인 | **9 / 11** |
| 갭 | **2** — 투자자 매매동향 추정 · **휴장일** |
| 신규 확정 TR | ka10080 · ka10081 · ka20006 · ka20001 · ka10051 · ka10095 · ka10059 · ka10099 |
| 요청 지연 실측 | **32 ~ 117 ms** (페이지당) |

**가장 중요한 결과**: 접근 패턴이 **TR 마다 다르다.** ADR-0120 이 확립한 "키움은 랜덤 액세스가 안 된다" 는 **분봉(`ka10080`)에만 해당**하고, **일봉(`ka10081`)은 `base_dt` 로 날짜 랜덤 액세스가 된다** — KIS 와 동등하다. 이관 난이도가 차원마다 갈린다.

---

## 매트릭스

| # | 표면 | KIS TR | 키움 TR | 경로 | 페이지 | 필드 | 접근 패턴 | 판정 |
|---|---|---|---|---|---|---|---|---|
| 1 | 과거 분봉 | `FHKST03010230` | **`ka10080`** | `/api/dostk/chart` | 900행 | 9 | **커서 전용** — 날짜 파라미터 없음, `cont-yn`/`next-key` 순차 | ✅ 대응 (접근 패턴 열위 → [#1008](https://github.com/Soochol/hoga-ops/issues/1008)) |
| 2 | 과거 일봉 | `FHKST03010100` | **`ka10081`** | `/api/dostk/chart` | 600행 | 10 | **`base_dt` 랜덤 액세스 O** | ✅ 대응 |
| 3 | 지수 일봉 | `FHKUP03500100` | **`ka20006`** | `/api/dostk/chart` | 600행 | 7 | `base_dt` | ✅ 대응 |
| 4 | 지수 현재가 | `FHPUP02100000` | **`ka20001`** | `/api/dostk/sect` | 20행 | 7 | 시각별 스냅샷 | ✅ 대응 |
| 5 | 지수 분봉 | `FHKUP03500200` | **`ka20005`** | `/api/dostk/chart` | 900행 | 9 | 커서 | ✅ **이미 이관됨**(ADR-0129) |
| 6 | 시장 투자자 일별 | `FHPTJ04040000` | **`ka10051`** | `/api/dostk/sect` | 28행 | 20 | **`base_dt` 1일치 스냅샷** | ⚠️ 대응하되 **모양이 다름** |
| 7 | 관심종목 복수시세 | `FHKST11300006` | **`ka10095`** | `/api/dostk/stkinfo` | 배치 | **63** | `stk_cd` 를 `\|` 로 복수 지정 | ✅ 대응 (KIS 보다 풍부) |
| 8 | 종목별 투자자 일별 | `FHPTJ04160001` | **`ka10059`** | `/api/dostk/stkinfo` | 100행 | 20 | `dt` + 커서, 일별 시계열 | ✅ 대응 (KIS 보다 세분) |
| 9 | 투자자 매매동향 **추정** | `HHPTJ04160200` | **미발견** | — | — | — | — | ❌ **갭** |
| 10 | **휴장일** | `CTCA0903R` | **미발견** | — | — | — | — | ❌ **갭 (포기 불가)** |
| 11 | 종목 마스터 | `.mst` 정적 | **`ka10099`** | `/api/dostk/stkinfo` | 2,474행 | 15 | `mrkt_tp` | ⚠️ 대응하되 **ETF 판별 불명확** → [#1009](https://github.com/Soochol/hoga-ops/issues/1009) |

---

## 표면별 상세

### 1. 과거 분봉 — `ka10080`

```
/api/dostk/chart  body {"stk_cd":"005930","tic_scope":"1","upd_stkpc_tp":"1"}
→ 900행/페이지, cont-yn=Y, 래퍼 키 stk_min_pole_chart_qry, 101ms
필드: cntr_tm, open_pric, high_pric, low_pric, cur_prc, trde_qty, acc_trde_qty, pred_pre, pred_pre_sig
```

**날짜 파라미터가 없다** — ADR-0120 이 기록한 그대로다. 커서 의미론·페이지 깊이·보유 기간은 [#1008](https://github.com/Soochol/hoga-ops/issues/1008) 소관.

`cntr_tm`(체결시각)이 봉 라벨이다. KIS 는 `stck_cntg_hour`. 라벨 규약(시작 vs 종료)은 이미 확립돼 있다(메모리 `kiwoom-ws-limits-measured`: cntr_tm=시작 라벨).

### 2. 과거 일봉 — `ka10081` **(랜덤 액세스 O)**

```
/api/dostk/chart  body {"stk_cd":"005930","base_dt":"YYYYMMDD","upd_stkpc_tp":"1"}
→ 600행/페이지, cont-yn=Y, 래퍼 키 stk_dt_pole_chart_qry, 110ms
필드: dt, open_pric, high_pric, low_pric, cur_prc, trde_qty, trde_prica, pred_pre, pred_pre_sig, trde_tern_rt
```

**랜덤 액세스 실증**:

```
base_dt=20260803 → 600행, 20260803 ~ 20240214   (약 2.4년/콜)
base_dt=20240102 → 600행, 20240102 ~ 20210726
```

`base_dt` 가 지정 날짜부터 과거 600행을 준다. **KIS 일봉과 동등한 접근 패턴**이므로 ADR-0100 계정 병렬의 대체 설계가 일봉에서는 훨씬 쉬워진다([#1015](https://github.com/Soochol/hoga-ops/issues/1015)).

`upd_stkpc_tp`(수정주가구분)가 요청 파라미터에 있다 — `screener_backfill.py:257,272` 가 요구하는 **수정주가/원주가 2벌**의 대응물이다. 값 의미(1=수정주가?)는 미검증.

### 3–5. 지수 계열 — `ka20006` / `ka20001` / `ka20005`

```
ka20006 /api/dostk/chart {"inds_cd":"001","base_dt":"20260803"}
→ 600행, 7필드(dt, open_pric, high_pric, low_pric, cur_prc, trde_qty, trde_prica), 69ms

ka20001 /api/dostk/sect  {"inds_cd":"001","mrkt_tp":"0"}
→ 20행(시각별), 7필드(tm_n, cur_prc_n, pred_pre_n, pred_pre_sig_n, flu_rt_n, trde_qty_n, acc_trde_qty_n), 37ms
```

`ka20005`(지수 분봉)는 [ADR-0129](../adr/0129-kiwoom-index-minute-candles.md) 로 **이미 이관 완료** — 이 표면은 마이그레이션 대상이 아니라 **선례**다.

`ka20001` 은 KIS `FHPUP02100000`(현재가 스냅샷)과 달리 **시각별 20행**을 준다. 최신 1행을 쓰면 되지만 소비자(`live/api.py:1568`)가 기대하는 모양과 다르므로 어댑터가 필요하다.

### 6. 시장 투자자 일별 — `ka10051` ⚠️ 모양이 다름

```
/api/dostk/sect  {"mrkt_tp":"0","amt_qty_tp":"0","base_dt":"20260731","stex_tp":"3"}
→ 28행(업종별), 20필드, 래퍼 키 inds_netprps, 60ms
필드: inds_cd, inds_nm, frgnr_netprps, orgn_netprps, ind_netprps, insrnc_netprps,
      invtrt_netprps, bank_netprps, samo_fund_netprps, endw_netprps, natn_netprps,
      etc_corp_netprps, jnsinkm_netprps, sc_netprps, native_trmt_frgnr_netprps, …
```

**차이**: KIS `FHPTJ04040000` 은 **일별 시계열**을 한 번에 주는데, `ka10051` 은 `base_dt` **하루치**를 업종별로 준다. 즉 N 거래일이 필요하면 **N 콜**이다. `live_index_investor_net.py:55` 의 소비 형태를 보면 범위 조회이므로 **콜 수가 늘어난다** → [#1015](https://github.com/Soochol/hoga-ops/issues/1015) 유량 예산의 입력.

투자자 분류는 KIS(외국인/기관계 2종)보다 **훨씬 세분**되어 있어 상위 집계가 필요하다.

**대안 후보**: `ka10131`(기관외국인연속매매현황) — 미검증. 시계열 모양이면 이쪽이 더 맞을 수 있다.

### 7. 관심종목 복수시세 — `ka10095` ✅ KIS 보다 풍부

```
/api/dostk/stkinfo  {"stk_cd":"005930|000660|035420"}
→ 3행(요청 종목 수만큼), 63필드, 래퍼 키 atn_stk_infr, 32ms
```

**`|` 구분으로 배치 조회가 된다** — KIS `FHKST11300006` 의 30종목/콜 청킹(`kis_endpoints.py:1150`)에 대응한다. **배치 상한은 미측정**(3종목만 확인).

63필드에 **호가 1~5단**(`buy_1th_bid`~`buy_5th_bid`, `sel_*`)과 체결강도(`cntr_str`)까지 포함돼 KIS 복수시세보다 넓다.

### 8. 종목별 투자자 일별 — `ka10059` ✅

```
/api/dostk/stkinfo  {"stk_cd":"005930","dt":"20260803","amt_qty_tp":"1","trde_tp":"0","unit_tp":"1000"}
→ 100행(일별 시계열), 20필드, cont-yn=Y, 래퍼 키 stk_invsr_orgn, 94ms
필드: dt, cur_prc, flu_rt, acc_trde_qty, acc_trde_prica, ind_invsr, frgnr_invsr,
      orgn, fnnc_invt, insrnc, invtrt, bank, etc_corp, etc_fnnc, natfor, …
```

**일별 시계열을 한 번에 준다** — KIS `FHPTJ04160001`(walk-back)보다 유리하다. 투자자 분류도 더 세분.

참고: `ka10061`(종목별투자자기관별**합계**)도 존재하며 기간 합계 13필드를 준다. 시계열이 필요한 소비자에는 `ka10059` 가 맞다.

### 9. 투자자 매매동향 추정 — ❌ 갭

KIS `HHPTJ04160200` 은 **장중 추정치**다(`live/api.py:1197`). 207 엔드포인트 래퍼 카탈로그와 공개 검색 어디에서도 대응을 찾지 못했다.

`ka10131`(기관외국인연속매매현황)은 **연속 순매수 일수**로 성격이 다르다 — 대체가 아니다.

**판정은 [#1013](https://github.com/Soochol/hoga-ops/issues/1013)** 소관. 지도의 갭 정책은 "기능을 포기하고라도 제거" 다.

### 10. 휴장일 — ❌ 갭 (**포기 불가**)

KIS `CTCA0903R` 은 달력·범위 캡처 enqueue 의 **거래일 진실 소스**다(`hoga/api/kis_holidays.py`, #976). 키움 REST 카탈로그에 **장운영일정/휴장일/영업일 TR 이 없다** — 207 엔드포인트 래퍼에도, 공개 검색에도 없다.

이 표면은 기능이 아니라 **기반**이라 "포기" 가 성립하지 않는다. **비-KIS 대체소스 탐색이 필수 후속**이며 [#1013](https://github.com/Soochol/hoga-ops/issues/1013) 이 처분한다. 후보: KRX 공개 데이터 · 정적 달력 커밋 · pykrx 류. 각각 갱신 책임·장애 모드·dev 무자격 동작이 다르다.

### 11. 종목 마스터 — `ka10099` ⚠️ ETF 판별 불명확

```
/api/dostk/stkinfo  {"mrkt_tp":"0"}
→ 2,474행, 15필드, 래퍼 키 list, 117ms
필드: code, name, marketCode, marketName, upName, upSizeName, companyClassName,
      kind, listCount, auditInfo, regDay, state, lastPrice, orderWarning, nxtEnable
```

두 가지가 눈에 띈다:

1. **필드가 camelCase 다** — 다른 모든 TR 은 snake_case 다. 별개 하위 시스템으로 보이며, 명명 규약을 공유하지 않는다.
2. **ETF/ETN 판별 필드가 명시적이지 않다.** `.mst` 는 증권그룹구분코드 `EF`/`EN` 으로 사실상 100% 정확하다(`symbols.py:592`). 여기서는 `companyClassName`·`kind`·`upName` 중 무엇이 그 역할을 하는지 불명이다.

**전수 대조는 [#1009](https://github.com/Soochol/hoga-ops/issues/1009) 소관.** 불일치 건수가 곧 스크리너 유니버스 오염량이다(메모리 `etf-exclude-two-truth-sources`: 진실 소스 2벌로 127건 누수 전력).

---

## 조사 방법론 — 키움 에러가 스펙을 알려준다

경로를 몰라도 **응답이 답을 준다**. 두 에러 코드가 탐색 루프를 만든다:

| 코드 | 의미 | 읽는 법 |
|---|---|---|
| `1504` | `해당 URI에서는 지원하는 API ID가 아닙니다. API ID=…, URI=…` | **경로가 틀렸다** — 다른 경로를 시도 |
| `1511` | `필수 입력 값에 값이 존재하지 않습니다. 필수입력 파라미터=mrkt_tp` | **경로는 맞고** 바디가 부족 — 알려준 이름을 채워 재시도 |

`ka20001` 은 이 루프로 2회 만에 확정됐다(`/api/dostk/sect` + `mrkt_tp`). 카탈로그 문서 없이도 스펙을 좁힐 수 있다.

**확인된 경로 4종**: `/api/dostk/chart`(차트) · `/api/dostk/stkinfo`(종목정보·투자자·관심종목·마스터) · `/api/dostk/sect`(업종·지수) · `/api/dostk/rkinfo`(순위, 기존 사용).

`/api/dostk/mrkcond` · `/api/dostk/frgnistt` 는 시도했으나 해당 TR 을 지원하지 않았다(존재하지 않는다는 뜻은 아니다 — 다른 TR 의 경로일 수 있다).

### 서드파티 카탈로그는 후보 목록으로만 썼다

TR 후보는 공개 래퍼 문서에서 얻고 **진실은 프로브로 확정**했다. 이 저장소는 서드파티 매핑이 틀린 전력이 있다(메모리 `kiwoom-ka10026-pertp-shifted-mapping`: .NET 래퍼의 `pertp` 매핑이 어긋나 있었다). 위 표의 페이지 크기·필드·접근 패턴은 **전부 실측값**이다.

---

## 후속 티켓에 넘기는 것

| 발견 | 넘길 곳 |
|---|---|
| `ka10080` 커서 의미론·페이지 깊이·보유 기간 | [#1008](https://github.com/Soochol/hoga-ops/issues/1008) |
| **`ka10081` 랜덤 액세스 가능** → 일봉 이관 난이도가 분봉과 다르다 | [#1008](https://github.com/Soochol/hoga-ops/issues/1008) · [#1012](https://github.com/Soochol/hoga-ops/issues/1012) |
| `upd_stkpc_tp` 값 의미(수정주가/원주가) 검증 | [#1008](https://github.com/Soochol/hoga-ops/issues/1008) |
| `ka10099` ETF/ETN 판별 필드 전수 대조 | [#1009](https://github.com/Soochol/hoga-ops/issues/1009) |
| 갭 2건(투자자 추정 · **휴장일**) 처분 | [#1013](https://github.com/Soochol/hoga-ops/issues/1013) |
| `ka10051` 일별 N콜 · `ka10095` 배치 상한 · 실제 유량 상한 | [#1015](https://github.com/Soochol/hoga-ops/issues/1015) |
| `ka20001` 시각별 20행 → 스냅샷 어댑터 필요 | [#1011](https://github.com/Soochol/hoga-ops/issues/1011) |

## 미측정 — 정직하게 남긴다

- **보유 기간**: 일봉만 확인(1콜 ≈ 2.4년, 20210726 까지 도달). 분봉·지수는 [#1008](https://github.com/Soochol/hoga-ops/issues/1008).
- **유량 상한**: 지연은 32~117ms 로 실측했지만 **허용 req/s 는 다른 축**이다. 프로브는 1 req/s 로 페이싱했으므로 상한을 건드리지 않았다 → [#1015](https://github.com/Soochol/hoga-ops/issues/1015).
- **`ka10095` 배치 상한**: 3종목만 확인.
- **venue(KRX/NXT/UN) 지원**: `ka10099` 에 `nxtEnable` 필드가 보이나 차트·시세 TR 의 venue 파라미터는 미조사. `kis_venue.py` 가 하던 라우팅의 대응물은 아직 공백이다.
- **주/월봉**: 카탈로그에 `ka10082`/`ka10083`/`ka20007`/`ka20008` 이 있으나 미검증. 현재 앱은 W/M 을 일봉에서 파생하므로(`DataSourceDetail.tsx:62`) 필요 없을 수 있다.
