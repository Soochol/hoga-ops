# 0137 — 에러 처리 전략: 원인을 접되 버리지 않는다

**Status:** accepted (2026-08-04) — **랜딩 확인 2026-08-29**

> status 가 `proposed` 로 남아 있었으나 코드는 이 결정대로 구현돼 있다. 증거:
> `hoga/live/error_policy.py:1` 이 모듈 첫 줄에서 "예외 → 처방 정책 테이블
> (ADR-0137)" 로 자신을 정의하고, `:7` 이 본 ADR 의 R4(`permanent` 축)를 테이블의
> 핵심으로 인용한다. 문서만 뒤처져 있었다.

**Related:**
- ADR-0136 — KIS 축소 제거, 키움 전면 대체. 이 전략의 **직접적 계기**: 데이터 소스는 키움으로 갔는데 에러 정책(`error_policy.py`)은 KIS 시대에 멈춰 있다.
- ADR-0134 — dev 무자격 프로필. "자격증명 없음"이 **정상 경로**라는 계약 → 영구/일시 구분의 선례.
- [#976](https://github.com/Soochol/hoga-ops/issues/976) — 범위 캡처의 거래일 의존. **영구 조건은 폴백, 일시 장애는 fail-fast** 원칙을 처음 세운 곳. 이 ADR 이 그걸 전역 규칙으로 승격한다.
- ADR-0115 — 소스별 완결성 게이트. 부분 성공을 등급으로 표현하는 선례.

## Context

### 발단 — 유량 초과 하나가 "장중 조회 불가"로 뭉개졌다

스크리너 우측 패널에 `장중 조회 불가 · 전일 확정 데이터로 표시 중` 이 떴다. 실측한 원인은 이랬다:

```
KiwoomRateLimitError: 허용된 요청 개수를 초과하였습니다
[1700: 유량=5, API ID=ka10095]
```

장중 오버레이가 유니버스 4,295종목을 `fetch_multi_price` 하나에 넘기고, 그 함수가 내부에서 100종목씩 43번 HTTP 를 쏜다. 유량 거버너는 `fetch_fn` 전체를 **요청 1건**으로 세므로 그 43콜을 페이싱하지 못한다. 벤더 상한이 5 req/s 라 6번째 콜에서 거절당한다(실측: 0.23초 만에 chunk 5 에서 실패).

버그 자체는 국소적이다. 문제는 **그 원인이 사용자에게 도달하는 데 실패한 방식**이다.

### 실측 — 세 가지 실패 모드

`hoga/` 전체를 AST 로 훑었다(except 핸들러 413개, `contextlib.suppress` 12개, 광범위 핸들러 105개).

**M1. 원인 소거 (cause erasure).** 예외를 잡아 사유 문자열 하나로 접으면서 예외 타입과 메시지를 버린다.

```python
except Exception:  # noqa: BLE001 — 업스트림 경계
    return _empty(["intraday_quote_fetch_failed"])
```

유량 초과·네트워크 단절·JSON 파싱 오류·인증 만료가 전부 같은 한 단어가 된다. 처방이 전혀 다른데(대기 후 재시도 / 네트워크 확인 / 벤더 스키마 변경 / 토큰 재발급) 구분이 불가능하다.

**M2. 층간 상관 단절.** "로그가 없다"는 진단은 절반만 맞았다. 로그는 남는다 — 다만 **원인과 영향이 다른 층에 흩어져 있고 잇는 키가 없다**:

```
12:51:06 WARNING hoga.live.kiwoom_capacity   ka10095 rate-limited (quota=5)     ← 원인
12:51:08 WARNING hoga.api.request_timing     /api/screener/scan status=200      ← 영향
```

`hoga.api.screener_intraday` 로거의 출력은 **0건**이다. 폴백을 결정한 층이 침묵하므로, 위 두 줄을 보고도 "스크리너 장중 스캔이 죽어 전일 데이터로 대체됐다"를 복원할 수 없다. `status=200` 이라 실패 집계에도 안 잡힌다. 이 상태로 30초마다 재시도가 돌며 유량을 계속 태운다(12:39~12:51 에 16회).

**M3. 고아 신호.** 백엔드가 emit 하는 사유 문자열 45개 중 **9개는 UI 에 존재하지 않는다**:

```
capacity_overloaded_upstream · close_nonpositive · depth_corpus_unavailable · http_429
intraday_quote_fetch_failed · malformed_row · ohlc_inconsistent · out_of_range
rest_bypassed_intraday_overlay_skipped
```

소비 측이 화이트리스트 렌더이기 때문이다 — `ScreenerDrawer` 는 3개만 `includes()` 로 검사하고 나머지는 조용히 버린다. 백엔드가 정확히 진단해 보내도 **UI 에 매핑이 없으면 없었던 일이 된다.**

이 숫자는 조사 중에 한 번 크게 움직였다. 처음 측정했을 때는 46개 중 **25개**가 고아였는데, [#1046](https://github.com/Soochol/hoga-ops/issues/1046) 이 사유 이름에서 벤더 접두를 걷어내면서(`kis_transport_error` → `transport_error`) 프론트가 이미 알던 이름과 맞아떨어져 절반 넘게 해소됐다. **고아의 상당수는 "신호를 안 보냈다" 가 아니라 "두 쪽이 다른 이름으로 같은 것을 불렀다" 였다** — 카탈로그 단일화(P1)가 왜 필요한지를 그대로 보여준다.

### 이미 있는 정답 두 개

이 리포에는 위 세 모드를 전부 피하는 코드가 **이미** 있다. 전략은 새로 발명하는 게 아니라 여기로 수렴시키는 것이다.

**① `hoga/live/error_policy.py`** — 예외를 처방으로 번역하는 정책 테이블:

```python
LiveErrorPolicy(kind, reason, code, message, log_level, include_traceback, degraded, backoff_cycles)
```

로그 레벨과 백오프까지 예외 타입이 결정한다. 그런데 **소비자가 `program_trade_collector` 단 하나**고, 매핑 대상이 KIS 예외 4종뿐이다. 키움 예외 6종(`KiwoomRateLimitError` · `KiwoomBatchLimitError` · `KiwoomAuthError` · `KiwoomApiError` · `KiwoomTransportError` · `KiwoomRestError`)은 **하나도 매핑돼 있지 않아 전부 `unexpected_error`(ERROR + traceback)로 떨어진다.** ADR-0136 으로 주 데이터 경로가 키움으로 넘어갔으니, 지금 이 정책 테이블은 실제 트래픽의 에러를 거의 다루지 못한다.

**② `data_warnings: {reason, msg}[]` 계약** — `/live` 과거 데이터 경로가 쓴다. `reason` 으로 분류하고 `msg` 로 원문을 보존하며, 프론트 `liveDataWarnings.ts` 가 rate-limit 계열을 따로 분류해 **문구를 바꾼다**:

> candles==0 && hasRateLimit → 빈칸 문구를 "호출 한도로 지연"으로

**즉 `/live` 는 같은 상황에서 사용자에게 "호출 한도"라고 정확히 말한다. 스크리너는 같은 상황을 "장중 조회 불가"로 뭉갠다.** 정답과 오답이 한 리포에 공존한다.

## Decision

### 원칙 — 예외를 잡는 지점은 세 가지를 모두 산출한다

예외를 잡아 **정상 흐름으로 되돌리는** 모든 지점은 다음 셋을 빠짐없이 만든다. 하나라도 빠지면 그 `except` 는 미완성이다.

| 산출물 | 대상 | 내용 |
|---|---|---|
| **로그** | 운영자 | 무엇이 실패했고 **그래서 어떤 기능이 어떻게 강등됐는지** |
| **신호** | 소비자(API) | `{reason, msg, permanent}` — 접힌 분류 + **버리지 않은 원문** |
| **처방** | 시스템 | 재시도 / 폴백 / 중단 중 하나를 명시적으로 선택 |

### R1 — 광범위 `except` 는 세 곳에서만 허용한다

`except Exception` 은 (a) **감독 루프**(태스크가 죽으면 기능이 조용히 멈추는 곳), (b) **벤더 I/O 경계**, (c) **외부 산출물 파싱**(parquet·mst·업스트림 JSON) 에서만 쓴다. 그 외는 구체 예외를 잡는다. 현재 105개 광범위 핸들러 대부분은 (a)~(c) 에 해당하므로 이 규칙은 대량 리팩터가 아니라 **경계를 문서화**하는 것이다.

### R2 — 원인을 접되 버리지 않는다 (M1 대응)

사유 문자열은 분류일 뿐이다. 예외의 실체는 `msg` 에 보존한다.

```python
except Exception as exc:
    policy = classify_error(exc)              # 예외 → 처방
    log.log(policy.log_level, "screener intraday overlay 강등: %s (%d종목, 전일 확정으로 폴백)",
            policy.message, len(unique_codes), exc_info=policy.include_traceback)
    return _empty([Degradation(reason=policy.reason, msg=policy.message, permanent=policy.permanent)])
```

`reason` 은 UI 분기용, `msg` 는 진단용이다. **둘 중 하나만 남기는 선택지는 없다.**

### R3 — 폴백을 결정한 층이 로그의 책임자다 (M2 대응)

하위 층 로그는 원인만 안다. **어떤 기능이 무엇으로 대체됐는지 아는 것은 폴백을 고른 층뿐이다.** 그러므로 로그의 의무는 예외가 발생한 곳이 아니라 **삼키기로 결정한 곳**에 있다. 로그 문장은 원인이 아니라 **영향**으로 시작한다:

- ✅ `screener 장중 오버레이 강등 → 전일 확정 폴백 (원인: rate_limit ka10095 quota=5, 4295종목)`
- ❌ `ka10095 rate-limited (quota=5)`

### R4 — 영구 조건과 일시 장애는 다른 처방을 받는다

#976 에서 세운 원칙을 전역 규칙으로 승격한다.

| | 예 | 처방 | HTTP |
|---|---|---|---|
| **영구** | 자격증명 없음, 우회 모드, 데이터 부재 | 조용히 폴백 + 안내 | 200 + warning |
| **일시** | 유량 초과, 네트워크, 벤더 5xx | **재시도가 옳은 안내** | 200 + warning + `retry_after`, 또는 503 |
| **결함** | 파싱 실패, 계약 위반, 내부 예외 | 로그 ERROR + traceback | 500 |

`permanent` 필드가 이 구분을 실어 나른다. 재시도해도 소용없는 것에 "잠시 후 재시도"를 안내하지 않고, 재시도하면 되는 것을 영구 불가처럼 보이게 하지 않는다.

### R5 — 부분 성공을 전량 폐기하지 않는다

현재 스크리너는 5청크(500종목)를 성공해 놓고 6번째 예외 하나로 전부 버린다. 부분 결과는 살리고 `partial` 신호를 단다. ADR-0115 의 소스별 완결성 게이트와 같은 사고방식이다.

### R6 — 고아 신호를 테스트로 봉인한다 (M3 대응)

백엔드가 내보내는 `reason` 카탈로그와 프론트의 표시 맵을 **한 곳에서 정의하고 테스트가 일치를 강제한다.** 매핑 없는 `reason` 이 오면 UI 는 조용히 버리는 대신 **일반 문구로 표시한다**(`알 수 없는 문제: <reason>`). 침묵보다 못생긴 표시가 낫다.

### 계약

`error_policy.py` 를 `hoga/errors.py` 로 승격하고 벤더 중립으로 만든다:

```python
@dataclass(frozen=True)
class ErrorPolicy:
    kind: ErrorKind          # transport | rate_limit | auth | vendor_api | batch_limit | internal | unexpected
    reason: str              # UI 분기 키 (카탈로그에 등록된 값만)
    code: str                # 벤더 코드 (1700, EGW00201, ...)
    message: str             # 원문 — 절대 버리지 않는다
    permanent: bool          # R4
    log_level: int
    include_traceback: bool
    retry_after_s: float | None
```

키움 예외 6종 매핑을 추가한다. 특히 `KiwoomRateLimitError`(1700, 일시, retry_after 있음)와 `KiwoomBatchLimitError`(1634, **영구** — 재시도가 아니라 청킹이 답)는 벤더가 같은 `return_code 5` 로 돌려주므로 이 구분이 정책 테이블에 반드시 있어야 한다.

응답 계약은 `/live` 의 `data_warnings` 형태로 통일한다:

```
warnings: string[]                      →  degradations: {reason, msg, permanent, retry_after_s?}[]
```

기존 `warnings` 는 한 릴리스 동안 병행 제공 후 제거한다.

## Consequences

**얻는 것.** 유량 초과가 "잠시 후 다시 시도하세요(호출 한도)"로, 자격증명 부재가 "설정이 필요합니다"로 갈라진다. 운영자는 로그 한 줄에서 원인과 영향을 함께 본다. 고아 신호가 테스트로 막힌다.

**비용.** 응답 계약 변경이 프론트 소비처 전반을 건드린다. `degradations` 는 `warnings` 보다 무겁다(문자열 → 객체). 남은 고아 9개마다 UI 문구를 정해야 한다.

**하지 않는 것.** 광범위 `except` 105개를 일괄 리팩터하지 않는다 — R1 은 새 코드의 기준이고, 기존 코드는 만질 때 맞춘다. `ruff` 의 `BLE001` 설정도 건드리지 않는다(CLAUDE.md 의 `lint.external` 함정 참조).

## 적용 순서

| | 범위 | 내용 |
|---|---|---|
| **P0** | 이번 버그 | 키움 예외 6종 정책 매핑 + `screener_intraday` 에 R2·R3 적용 + 청킹을 거버너 위로 |
| **P1** | 신호 정합 | `reason` 카탈로그 단일화 + 고아 9개 처리 + 일치 테스트 |
| **P2** | 계약 통일 | `warnings[]` → `degradations[]`, `/live` 형태로 수렴 |
| **P3** | 감사 | 광범위 핸들러 105개를 R1 3범주로 분류, 벗어난 것만 수정 |
