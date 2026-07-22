# 키움 순위 TR 4종 스펙 실측 — ka10027 / ka10023 / ka10030 / ka10032

**작성:** 2026-07-22 · **티켓:** #819 (지도 #818) · **성격:** research (AFK)

## 출처 및 신뢰도

이 코드베이스는 키움 순위 TR을 호출한 적이 없어(현재 키움 REST 소비 = `ka10001` 하나),
문서-실제 어긋남 위험이 있다. 아래는 **강타입 1차 출처 교차**로 확정한 값이다.

| 출처 | 유형 | 확신도 |
|---|---|---|
| [dongbin300/KiwoomRestApi.Net](https://github.com/dongbin300/KiwoomRestApi.Net) | .NET 강타입 래퍼 (`[JsonProperty]` 필드명·enum 코드·요청 body 키 모두 박제) | **높음** — 요청/응답 키의 1차 근거 |
| [younghwan91/kiwoom-rest-api](https://github.com/younghwan91/kiwoom-rest-api) | Python 얇은 래퍼 (path·api-id 확인, 파라미터는 `**kwargs`라 미노출) | 높음 (path/api-id 한정) |
| [openapi.kiwoom.com 공식 가이드](https://openapi.kiwoom.com/guide/index) | 공식 (SPA라 자동 fetch 불가, 검색 스니펫으로 교차) | 중간 |

⚠️ **실콜 미검증**: 자격증명으로 실제 응답을 받아 확인하지는 못했다. 아래 **§검증 필요 항목**의
두 가지(시장구분 문자열 포맷, 응답 숫자 부호/콤마)는 백엔드 티켓(#820)에서 실데이터로 최종 확정한다.

## 공통

- **Method / Path**: `POST /api/dostk/rkinfo` (4종 공통)
- **api-id 헤더**: 각 TR 코드 (`ka10027` 등) — 헤더 `api-id`로 전달, path는 동일
- **인증**: 헤더 `authorization: Bearer <token>` (기존 `KiwoomTokenProvider` 재사용)
- **연속조회**: 헤더 `cont-yn` / `next-key` 지원 — **1차 미사용**(1회 응답분만, 그릴링 결정 6)
- **Content-Type**: `application/json;charset=UTF-8`
- **거래소구분 `stex_tp`**: `1`=KRX · `2`=NXT · `3`=통합 → 이 프로젝트는 **`1`(KRX)** 고정 권장(기존 캡처가 KRX 기준)

## 시장구분 (4종 공통 요청 파라미터 `mrkt_tp`)

| 값 | 시장 |
|---|---|
| `000` | 전체 |
| `001` | 코스피 |
| `101` | 코스닥 |

> ⚠️ .NET 래퍼 enum 정수값은 `All=0 / Kospi=1 / Kosdaq=101`이지만, 공식 문서·통상 관례는
> **zero-pad 문자열 `"000"/"001"/"101"`**. 백엔드는 문자열로 보내고 #820에서 실콜 확정. (§검증 필요)

---

## ka10027 — 전일대비등락률상위요청 (등락률 탭)

**요청 body**

| 키 | 의미 | 이 프로젝트 값 |
|---|---|---|
| `mrkt_tp` | 시장구분 | `000/001/101` (필터) |
| `sort_tp` | 정렬구분 | **`1`=상승률 / `3`=하락률** (2=상승폭·4=하락폭·5=보합) — 방향토글 |
| `trde_qty_cnd` | 거래량조건(천주 단위) | `0000`(전체) |
| `stk_cnd` | 종목조건 | `0`(전체) — 관리종목 제외 원하면 조정 |
| `crd_cnd` | 신용조건 | `0`(전체) |
| `updown_incls` | 상하한포함 | `1`(포함) |
| `pric_cnd` | 가격조건 | `0`(전체) |
| `trde_prica_cnd` | 거래대금조건(천만원 단위) | `0`(전체) |
| `stex_tp` | 거래소구분 | `1`(KRX) |

**응답**: 배열 래퍼 키 = **`pred_pre_flu_rt_upper`**, 행 필드:

| 필드 | 의미 | 소비 |
|---|---|---|
| `stk_cd` | 종목코드 | ✅ code |
| `stk_nm` | 종목명 | ✅ name |
| `cur_prc` | 현재가 | ✅ price |
| `flu_rt` | 등락률 | ✅ change_pct |
| `pred_pre_sig` | 전일대비기호 | (부호) |
| `pred_pre` | 전일대비 | (선택) |
| `sel_req`/`buy_req` | 매도/매수잔량 | 미사용 |
| `now_trde_qty` | 현재거래량 | 미사용 |
| `cntr_str` | 체결강도 | 미사용 |
| `stk_cls` | 종목분류 | 미사용 |

---

## ka10023 — 거래량급증요청 (량급증 탭)

**요청 body**

| 키 | 의미 | 값 |
|---|---|---|
| `mrkt_tp` | 시장구분 | 필터 |
| `sort_tp` | 정렬구분 | **`2`=급증률** (1=급증량·3=급감량·4=급감률) |
| `tm_tp` | 시간구분 | `2`(분) 또는 `1` — 실콜 확인 |
| `tm` | 시간(분) | `1` 등 |
| `trde_qty_tp` | 거래량조건(천주) | `0`(전체) |
| `stk_cnd` | 종목조건 | `0` |
| `pric_tp` | 가격조건 | `0` |
| `stex_tp` | 거래소 | `1` |

**응답**: 배열 래퍼 키 = **`trde_qty_sdnin`**, 행 필드:

| 필드 | 의미 | 소비 |
|---|---|---|
| `stk_cd` / `stk_nm` / `cur_prc` | 코드/명/현재가 | ✅ |
| `flu_rt` | 등락률 | ✅ change_pct |
| `pred_pre_sig` / `pred_pre` | 전일대비 기호/값 | 부호 |
| `prev_trde_qty` | 이전거래량 | 미사용 |
| `now_trde_qty` | 현재거래량 | 미사용 |
| `sdnin_qty` | 급증량 | 미사용(기준값 열 제거됨) |
| `sdnin_rt` | 급증률 | 미사용(기준값 열 제거됨) |

---

## ka10030 — 당일거래량상위요청 (거래량 탭)

**요청 body**

| 키 | 의미 | 값 |
|---|---|---|
| `mrkt_tp` | 시장구분 | 필터 |
| `sort_tp` | 정렬구분 | **`1`=거래량** (2=거래회전율·3=거래대금) |
| `mang_stk_incls` | 관리종목포함 | `0`(미포함) 또는 `1` |
| `crd_tp` | 신용구분 | `0`(전체) |
| `trde_qty_tp` | 거래량조건(천주) | `0` |
| `pric_tp` | 가격조건 | `0` |
| `trde_prica_tp` | 거래대금조건(천만원) | `0` |
| `mrkt_open_tp` | 장운영구분 | `0`(전체) |
| `stex_tp` | 거래소 | `1` |

**응답**: 배열 래퍼 키 = **`tdy_trde_qty_upper`**, 행 필드:

| 필드 | 의미 | 소비 |
|---|---|---|
| `stk_cd` / `stk_nm` / `cur_prc` | 코드/명/현재가 | ✅ |
| `flu_rt` | 등락률 | ✅ change_pct |
| `pred_pre_sig` / `pred_pre` | 전일대비 | 부호 |
| `trde_qty` | 거래량 | 미사용(기준값 열 제거됨) |
| `pred_rt` | 전일비 | 미사용 |
| `trde_tern_rt` | 거래회전율 | 미사용 |
| `trde_amt` | 거래금액 | 미사용 |
| `opmr_*` / `af_mkrt_trde_qty` | 장중·시간외 세부 | 미사용 |

---

## ka10032 — 거래대금상위요청 (대금 탭)

**요청 body** (가장 단순 — 정렬 파라미터 없음, 거래대금 고정 정렬)

| 키 | 의미 | 값 |
|---|---|---|
| `mrkt_tp` | 시장구분 | 필터 |
| `mang_stk_incls` | 관리종목포함 | `0` 또는 `1` |
| `stex_tp` | 거래소 | `1` |

**응답**: 배열 래퍼 키 = **`trde_prica_upper`**, 행 필드:

| 필드 | 의미 | 소비 |
|---|---|---|
| `stk_cd` / `stk_nm` / `cur_prc` | 코드/명/현재가 | ✅ |
| `flu_rt` | 등락률 | ✅ change_pct |
| `now_rank` | 현재순위 | (순위 — 응답 순서로 대체 가능) |
| `pred_rank` | 전일순위 | 미사용(순위변동은 Out of scope) |
| `pred_pre_sig` / `pred_pre` | 전일대비 | 부호 |
| `sel_bid`/`buy_bid` | 매도/매수호가 | 미사용 |
| `now_trde_qty`/`pred_trde_qty` | 현재/전일거래량 | 미사용 |
| `trde_prica` | 거래대금 | 미사용(기준값 열 제거됨) |

---

## 백엔드 정규화 규약 (#820 입력)

- **숫자는 부호 접두 문자열로 온다**: `flu_rt`, `pred_pre`, `cur_prc` 등이 `"+29.97"`, `"-18.32"`,
  `"--500"`(하한 특수), 콤마 포함(`"71,200"`) 형태. .NET 래퍼 `KiwoomNormalizerConverter`가
  `--`/`+`/`-` 접두와 콤마를 벗겨 파싱한다. 백엔드 `parse_*`도 동일 처리 필요:
  선행 `+`/`-`/`--` 부호 정규화 + 콤마 제거 후 `float`/`int` 변환. (기존 `kiwoom_frames` 파싱 관례 참고)
- **행 축약**: 프론트는 `stk_cd`/`stk_nm`/`cur_prc`/`flu_rt` 4개만 쓴다(기준값 열 제거, 그릴링 결정).
  백엔드 응답 모델 `RankingRow`는 이 4개 + (선택) `rank`로 축약해 페이로드를 줄인다.
- **kind → (api-id, sort_tp, 래퍼키) 매핑**:

  | kind | api-id | 정렬 파라미터 | 응답 래퍼 키 |
  |---|---|---|---|
  | `change` | ka10027 | `sort_tp`=1(상승)/3(하락) | `pred_pre_flu_rt_upper` |
  | `surge` | ka10023 | `sort_tp`=2(급증률) | `trde_qty_sdnin` |
  | `volume` | ka10030 | `sort_tp`=1(거래량) | `tdy_trde_qty_upper` |
  | `value` | ka10032 | (없음) | `trde_prica_upper` |

## 검증 필요 항목 (#820에서 실콜로 확정)

1. **`mrkt_tp` 문자열 포맷** — `"000"/"001"/"101"`(zero-pad) vs `"0"/"1"/"101"`. 공식 문서는 zero-pad,
   .NET enum은 정수. → **zero-pad로 보내고 실응답 확인.**
2. **응답 숫자 표기** — `flu_rt`가 `"+29.97"`인지 `"29.97"`인지, `cur_prc` 콤마 유무. → 파서 방어적으로.
3. **장외 응답** — 마감/휴장일 호출 시 직전 거래일 순위를 주는지(그릴링 결정 9의 "열 때 1회 조회" 전제).
   → 거래일 캘린더 게이트(KIS chk-holiday)로 폴링은 막되, 1회 조회 응답은 이 동작에 의존.
4. **응답 행 수** — 1회 응답 종목 수(≈100 추정). 스크롤 리스트 높이 설계 입력.

## WebSocket 대안 없음 (재확인)

키움 WS 실시간 19종에 시장 전체 순위 푸시 타입은 없다. 순위 4종은 REST 폴링이 유일 경로
(그릴링 질문 "ws는 없지?" 확정). 조건검색 실시간(ka10173)은 정렬 리스트가 아니라 편입/이탈
이벤트라 성격이 다르며 이번 범위 밖.
