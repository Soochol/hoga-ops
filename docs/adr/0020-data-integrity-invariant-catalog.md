# 0020 — Data Integrity Checks: 선언적 Invariant 카탈로그 + DiskState 확장

**Status:** accepted (2026-05-24) — implemented per `docs/superpowers/specs/2026-05-24-data-integrity-checks-design.md`

**Related:**
- ADR-0007 — disk_state 모듈 추출 (단일 분류 책임). 본 ADR이 그 분류기의 *입력 단계*로 invariants를 더한다.
- ADR-0013 — RangeBundle single read-path. 본 ADR이 그 read-path를 결함 데이터로부터 보호.
- `docs/superpowers/specs/2026-05-24-data-integrity-checks-design.md` — 본 ADR이 근거를 보존하는 spec

## Decision

데이터 무결성 검사를 `hoga/api/invariants.py` 단일 모듈의 **선언적 카탈로그**로 정의한다. 각 **Invariant**는 `(id, severity, description, check_fn)` 튜플이고, `check_fn`은 meta dict를 받아 위반 시 **Violation**을 반환하는 순수함수다. `DiskState`에 새 상태 `INVALID`를 추가하고, `classify_from_meta`가 invariants를 **매 호출마다 live로 평가**한다. `build_range_bundle`은 `INVALID` Stock-Date를 조용히 제외하고 응답 메타에 `excluded_dates` / `data_warnings` 필드로 surfacing한다.

기록되는 구조적 결정들:

1. **선언적 카탈로그 (vs 흩뿌려진 if).** Invariant 추가가 카탈로그 한 줄 추가로 끝나고, 모든 진입점(parser write-time / DiskState classify / read-path / CLI sweep)이 같은 등록처를 공유. ADR-0007의 "한 도메인 분류는 한 모듈에서" 철학의 자연스러운 확장 — invariants는 disk_state 분류기의 *입력 단계*다.

2. **`Callable[[dict], Violation | None]` 시그니처.** MVP가 meta-level invariants만 다루기 때문에 의도적으로 좁힘. series-level invariants (candles 단조성, snapshot 갭) 추가 시 새 시그니처 도입 + 카탈로그 분할 (`META_INVARIANTS` / `SERIES_INVARIANTS`)이 자연스러운 확장 — YAGNI 적용.

3. **DiskState 확장이지 새 분류 시스템이 아니다.** `INVALID` 한 값 추가, `classify_from_meta`에 한 분기 추가. eligibility/calendar 등 기존 DiskState 소비자가 자동으로 새 상태를 인식하게 됨. ADR-0007의 single-source-of-truth 원칙 유지.

3a. **Classify 우선순위는 `INVALID` > `CLIENT_INCOMPLETE`.** 초안에서는 "캡처 미완료가 더 근본"이라는 직관으로 `CLIENT_INCOMPLETE`를 먼저 두려 했으나, 그러면 5/18/003490 production 케이스(`collection_complete=False AND close_ms=0`)가 `CLIENT_INCOMPLETE`로 라우팅되고 `build_range_bundle`의 `INVALID` 필터를 통과하면서 차트 충돌이 동일하게 재발한다. 깨진 모양은 incompleteness보다 더 위험한 신호이므로 우선 분기: bundle은 제외, eligibility는 resume=False (corrupted parquet를 신뢰하지 않고 처음부터 fresh capture).

3b. **`classify_from_meta`는 `Classification(state, violations)`를 반환한다.** 초기 시그니처 `-> DiskState`는 shallow였다 — 호출처가 INVALID를 발견하면 `check(meta)`를 두 번 더 돌려 violations를 복원해야 했고, severity 비교 인라인이 4계층에 흩어졌다. `Classification` 데이터클래스는 같은 호출 한 번에 state + violations를 함께 반환하고, `.errors` / `.warnings` property로 severity partition을 한 곳에 보관한다. routing-only caller(eligibility, calendar, queries)는 `.state` 한 단어만 추가, surfacing caller(`build_range_bundle`)는 중복 호출 제거 + 인라인 severity 비교 5줄 절감. ADR-0007의 "한 도메인 분류는 한 모듈에서" 원칙이 한 단계 더 깊어진 형태.

3c. **Series-level invariants는 archival-cached이며 read-paths는 live 평가하지 않는다.** §3의 "매 호출 live 평가" 원칙은 meta-level 한정. Series catalog (`docs/superpowers/specs/2026-05-24-series-level-invariants-design.md`로 도입)는 candles/snapshots/trades parquet 로드를 필요로 하는데 — Stock-Date 하나당 수십 MB 가능 — 매 요청 로드는 `/api/range` SLO를 깨뜨린다. 대신 parser write-time archival이 전체 violation 리스트(meta + series)를 `meta.json::invariant_violations`에 박고, read-paths는 그 필드를 신뢰. 카탈로그 업데이트 후 stale은 사용자의 명시 책임 — `hoga validate --deep --fix`가 저장소 전체에서 재기록. 이 예외는 series-level에만 적용; meta-level은 여전히 live 평가 (싸고 I/O 없음).

4. **매 호출 live 평가 (vs cached archival 우선).** 카탈로그가 업데이트되면 archival 필드는 stale — self-healing 원칙. L1 parser hook이 `meta.json`에 `invariant_violations` 필드를 박지만 이는 archival/추적용일 뿐이고, 어떤 read-path도 그 필드를 우선 신뢰하지 않는다. 측정 결과 calendar 등에서 성능 문제 발견 시 그때 catalog-hash 기반 캐싱 도입 (premature optimization 회피).

5. **error 자동 제외 + 응답 메타 기록, warn 포함하되 surfacing.** 두 단계 severity로 분리. error는 데이터 형태 자체가 깨진 경우 (예: `close < open`) → segment 조립 불가. warn은 데이터 모양은 맞지만 신뢰도 낮음 (예: `collection_complete=false`) → 포함하되 사용자에게 경고. UI는 `RangeBundle.excluded_dates` / `data_warnings`로 두 신호를 모두 받음.

6. **모두 제외돼서 segment 0개면 404 (기존 분기 재사용).** 기존 "no captured Stock-Date" 404와 같은 status로 통일, detail 필드에 `excluded` 사유 동봉. 호출자는 두 케이스를 같은 분기로 처리하면서 디테일이 필요하면 사유를 본다.

7. **`hoga validate` CLI는 read-only by default.** `--fix` 옵션은 archival 필드(`meta["invariant_violations"]`)만 갱신 — 데이터 자체 수정/삭제 X. 결함 데이터의 복구는 항상 **재캡처**가 유일한 길이며 사용자의 명시적 결정.

## Context

2026-05-24, `(003490, 20260518)` Stock-Date의 meta.json이 `regular_session_close_ms=0`인 채로 저장됐다. 원인은 hogaplay upstream의 stagnation (4132 페이지 요청 → 1553 unique events, `abort_reason: stagnation_abort`) — upstream이 첫 페이지 info row의 close 필드를 `0`으로 반환했고, 파서는 자기 책임 범위(필드 파싱) 안에서 정확하게 `0`을 기록했다. `collection_complete: false`로 정확히 표시까지 됐다.

그러나 chart read-path(`build_range_bundle`)는 그 비트를 보지 않고 모든 captured Stock-Date를 그대로 segment로 조립했고, `close < open`인 segment 하나가 virtual axis를 망가뜨려 `lightweight-charts`의 `setData`가 `"data must be asc ordered by time"` assertion으로 터졌다. 사용자에게는 정체불명의 차트 실패.

**감지는 다 됐는데 무시됐다** — 캡처 측이 남긴 신호(`collection_complete`, `_progress.json::abort_reason`)를 read-path가 검증 없이 통과시킨 게 진짜 결함. 단발 if를 한 군데 추가하면 5/18은 해결되지만, 다음 결함은 또 다른 자리에서 재발한다. **검증 정책을 한 곳으로 모으는 구조**가 필요했다.

## Alternatives considered

### A. 흩뿌려진 if (현 상태 연장)

`build_range_bundle`에 `if not meta["collection_complete"] or meta["close_ms"] <= meta["open_ms"]: continue` 추가.

- **장점**: 코드 변경 최소. 5/18은 즉시 해결.
- **단점**: 다음 결함은 또 새 if를 다른 자리에 산재. eligibility/calendar/CLI 등이 같은 검사를 안 함 → 불일치. 단위 테스트가 호출 자리마다 mock.
- **각하 사유**: 같은 문제가 1년 안에 3~5번 더 발생할 가능성 — 그때마다 if 흩뿌리기는 디자인 부채.

### B. 선언적 invariant 카탈로그 (채택)

본 ADR의 결정. 5개 invariant 등록 → 4계층 모두 동일 카탈로그 사용.

### C. Pydantic 모델 validator

`StockInfo` / `RangeSegment` 등에 `@model_validator(mode='after')` 추가.

- **장점**: pydantic 생태계 활용. 모델 인스턴스화 시 자동 검증.
- **단점**: Pydantic은 "구조적 타입 검증"에 강함, "교차 필드 의미 불변값(close > open)"엔 결국 if 다시 짜야 함. severity / scope / id 같은 메타데이터를 모델만으로 표현 어려움. L4 sweep CLI에서 보고서 만들기 위해 별도 메커니즘 필요 (모델은 raise 후 모름).
- **각하 사유**: 모델은 "잘못된 값으로 인스턴스화 막기"가 목적. 본 spec은 "잘못된 데이터를 read-path에서 제외하면서 사용자에게 surfacing"이 목적 — 다른 도메인.

## Consequences

### Positive

- 4계층(parser write / DiskState classify / read-path / CLI sweep)이 같은 카탈로그를 공유 → 검증 정책 일관성.
- Invariant 추가가 카탈로그 한 줄 → 변경 비용 작음.
- `disk_state.py` ADR-0007의 single-source-of-truth 원칙이 한 단계 더 강화됨 (분류기의 입력도 한 곳).
- 응답 메타에 `excluded_dates` / `data_warnings`가 노출되어 UI가 "왜 이 날이 차트에 없는지" 설명 가능.

### Negative

- meta.json 읽을 때마다 invariants 평가 (산술 비교 5회) — 측정 전엔 비용 미상. 우선 단순 live 평가 채택, 측정 후 필요시 catalog-hash 기반 캐싱으로 전환.
- `DiskState` enum에 새 값 추가 → 기존 소비자(eligibility, calendar) 동시 업데이트 필요. 본 PR 범위에 포함되어 일관성 보장.

### Neutral

- 결함 데이터의 자동 복구는 명시적으로 비목표. `hoga validate --fix`는 archival 필드만 갱신, 데이터 재캡처는 사용자 결정.
- 시계열 invariants(candles 단조성 등)는 follow-up. 본 spec의 `Callable[[dict], Violation | None]` 시그니처가 series-level에는 맞지 않으나, 카탈로그를 type별로 분할하는 자연스러운 확장 자리만 비워 둠.

## Amendment (2026-06-03) — read-path가 archived series-error를 INVALID 게이트로 소비

위 Neutral의 "시계열 invariants follow-up" 자리가 메워졌으나(§3c에서 `SERIES_INVARIANTS` +
`check_series` 추가), **read-path 소비가 빠져 있었다**: parser write-path는
`META_INVARIANTS + SERIES_INVARIANTS`를 모두 평가해 `meta.json`의 `invariant_violations`에
archive했지만, `classify_from_meta`(read-path 단일 funnel)는 `check(meta)`(meta-only)만
재평가하고 archived 필드를 읽지 않았다. archived 필드의 유일 소비자는 `hoga validate --fix`
(forensic)였다.

결과 결함: `series.candles_ts_monotonic`(severity `error`, 차트 setData assert의 직접
원인 — 5/18/003490)이 write 시점에 archive돼도 `DiskState`를 `INVALID`로 바꾸지 못해
`build_range_bundle`이 해당 **Stock-Date**를 그대로 serve했다. read-path는 candle `ts_ms`를
dedup하지 않는다(`candles.query_all`=`ORDER BY ts_ms ASC`만). 즉 §4.6의 "read-path는 series를
live-evaluate하지 않고 **archived field를 trust**한다"는 설계 의도가 **구현되지 않은 상태**였다.

**결정:** `classify_from_meta`가 `meta["invariant_violations"]`에서 **`series.*` violation만**
union한다(meta는 `check(meta)`로 live 재평가가 진실원이라 double-count 방지; series는 archived가
유일원 — parquet 재로드 없이 per-request SLO 보존). error-severity면 `INVALID`, warn은
`Classification.warnings`. `Violation.from_dict`(=`as_dict` 역변환) 추가; malformed/unknown-severity
archive 항목은 skip(read-path-hot helper crash 방지).

**stale archive 신뢰 정책:** archived as-is 신뢰 + `hoga validate --fix` 1회 sweep으로 수정
이전(`series.candles_ts_monotonic` raw-order false-positive 시절) archive 정리. 단일 사용자 로컬
툴(ADR-0036)이라 운영상 충분 — version-gate self-healing은 분산 배포에서나 필요(미채택).

reopen 아님 — §4.6이 의도한 "archived field trust" 계약을 read-path에서 *이행*한 것.

## Amendment (2026-06-08) — `series.cum_vol_monotonic` 은 error 가 아니라 warn

§5의 severity 계약: **error = 데이터 *형태*가 깨져 segment 조립 불가**(예: `close < open`,
candles `ts_ms` 비단조 → lightweight-charts `setData` assert), **warn = 형태는 맞지만
신뢰도 낮음 → 포함하되 surface**. 2026-06-03 amendment가 series-error를 read-path INVALID
게이트로 *이행*하면서, `series.cum_vol_monotonic`도 `series.candles_ts_monotonic`과 같은
`error`로 등록돼 있었다 — 그러나 둘의 성격이 다르다.

**증상:** `(003490, 20260506)`에서 hogaplay 가 10:06:56 에 겹치는 trade 페이지를 재전송해
(새 `seq`·미세하게 다른 `ts_ms` 탓에 dedup 미적중) `cum_vol`이 한 번 역행(465068→452839).
단일 위반인데 read-path가 **날짜 전체를 INVALID 로 제외** → `/api/range` 가 segments·candles·
quote_ratio·fill_strength 를 전부 빈 배열로 반환 → 총잔량·호가비·체결강도 pane 백지. 같은 날
10호가·거래원 사이드바는 per-cursor 엔드포인트(invariant 게이트 없음)라 정상 렌더 →
"일부 지표만 안 보인다"는 비대칭. 저장소 전역 67개 Stock-Date가 이 한 invariant 만으로 제외됨.

**결정:** `series.cum_vol_monotonic` severity 를 `error` → **`warn`** 으로 정정. 근거:
1. **형태 불변이 아니다.** read-path 의 어떤 렌더 시리즈도 `cum_vol`을 소비하지 않는다 — candles
   는 자체 `vol_a/vol_b` 컬럼, fill_strength 는 `SUM(qty) WHERE side!=0`, quote_ratio 는 스냅샷
   파생. cum_vol 역행이 있어도 segment·candles·세 pane 모두 정상 조립된다. cum_vol 단조성은
   *형태*가 아니라 *신뢰* 신호 — §5 정의상 정확히 `warn` 군.
2. **캡처 경로와의 정합.** 캡처는 이미 같은 역행을 `warn` 으로 surface 한다
   (`captures._validation_error_to_warning`, severity="warn"; ADR-0020 lenient fallback —
   단일 페이지 리베이스로 10분 캡처를 버리는 건 잘못된 트레이드). 정정 전에는 parser archival 이
   같은 이상을 `error` 로 박아, 캡처 UI 는 "관용 가능 경고"라 부르는 사이 read-path 는 날짜를
   통째로 버리는 **자기모순**이었다.
3. `series.candles_ts_monotonic` 은 `error` 유지 — 그건 `setData` 크래시를 직접 유발하는 진짜
   형태 파손이다. 두 series-invariant 의 severity 가 갈리는 게 옳다.

`trades.validate()` strict raise 는 severity 와 무관(이진)하므로 lenient fallback 는 그대로
작동한다. 기존 archive 의 stale `error` 는 §4·위 stale-archive 정책대로 `hoga validate --deep
--fix` 1회 sweep 으로 `warn` 재기록(데이터 자체는 불변, archival 필드만). 근본 원인인
페이지-오버랩 중복 자체의 파서 dedup 은 별도 follow-up(해당 분(分) 버킷의 체결강도가 소폭
이중계상되나, 빈 화면보다 낫고 `warn` 으로 surface 됨).
