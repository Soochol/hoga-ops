# 0075 — Raw retention: scheduler 자동 prune (ADR-0036 무자동 원칙의 디스크 예외)

**Status:** accepted (2026-06-13)

**Related:**
- ADR-0036 — 로컬 전용: retry/enqueue 상한 미설정 (본 ADR이 부분 예외를 두는 대상)
- ADR-0019 — raw는 resume/재parse용 SSOT (왜 그동안 보존되었는가)
- ADR-0034 — Scheduler is a queue client (prune 통합이 이 invariant를 깨지 않음)
- ADR-0037 — source-subfolder layout (게이트가 hogaplay-source로 좁혀지는 근거)
- ADR-0039 — Source Preference fallback (aggregate COMPLETE가 hogaplay와 갈릴 수 있는 이유)
- `docs/superpowers/specs/2026-06-13-raw-data-retention-design.md` — 본 ADR의 설계

## Decision

`Daily Scheduler`(`hoga/api/scheduler.py:_daily_run`)에 **자동 raw prune 단계**를 추가한다.
Promotion 직후·거래일 체크 전에 매일 1회 실행되며, 다음 조건을 모두 만족하는
`raw/{date}/{code}/`만 `rmtree`한다:

1. `date < today − N`일 (N = `HOGA_RETENTION_DAYS`, 기본 3, **달력일**)
2. 해당 (date,code)의 **hogaplay-source parquet이 `DiskState.COMPLETE`** (aggregate 아님)

수동 실행용 `hoga prune` CLI(dry-run 기본, `--execute`로만 삭제)를 병행 제공한다.
순수 로직은 `hoga/api/prune.py`에 분리한다.

## Why — ADR-0036의 무자동 원칙에 예외를 두는 이유

ADR-0036은 "로컬 단일 사용자 배포는 백엔드가 사용자 명시 액션 없이 자동 동작하지 않는다"는
원칙으로 retry/enqueue 상한을 두지 않았고, Trigger Condition에 **"백엔드 자동 retry loop
추가 시 cap 필수"**를 명시했다. 자동 prune은 표면적으로 그 "사용자 액션 없는 백엔드 자동
동작"에 해당하므로 긴장이 있다. 그럼에도 예외를 두는 근거:

1. **이미 발생한 사고**: ADR-0036의 또 다른 Trigger Condition은 "재현 가능한 사고 발생 시
   도입"이다. 2026-06-13 raw 704GB가 디스크를 100%로 채워 쓰기가 실패했다 — 가설이 아니라
   실측된 사고다.
2. **증식이 아니라 수렴**: ADR-0036이 경계한 것은 *무한 증식*(retry loop, enqueue 폭주)이다.
   prune은 반대로 *삭제*이며, `COMPLETE`-only 게이트라 복구 불가능한 데이터(resume 소스,
   미완성, 갭 있는 partial)는 절대 건드리지 않는 **무손실·수렴적** 동작이다.
3. **가시성 계승**: ADR-0036은 "사용자 가시성(×N 배지)"을 사실상의 cap으로 삼았다. 본 설계도
   같은 정신으로 dry-run 기본 CLI + 자동 경로의 회수량 로깅을 둔다.

따라서 본 ADR은 ADR-0036을 **supersede하지 않고 보완**한다 — 디스크 retention이라는 다른
차원에 한정된 예외다 (retry/enqueue cap 부재는 그대로 유지).

## Why — 게이트가 aggregate가 아니라 hogaplay-source인 이유

raw/는 flat 레이아웃(`first_*.tsv`)으로 **hogaplay 캡처 전용**이다 (KIS live는 promote로
parquet에 직행, raw/ 미경유). 그런데 `aggregate_disk_state`는 "한 source라도 COMPLETE면
COMPLETE"다 (ADR-0039 Source Preference). 만약 hogaplay=SOURCE_PARTIAL, kis_live=COMPLETE면
aggregate=COMPLETE가 되어, **hogaplay 자신은 미완인데 그 raw가 삭제**될 수 있다. raw의 운명은
그 raw로 만든 parquet(hogaplay)의 상태에 묶여야 하므로, 게이트를 hogaplay-source로 좁힌다.

## Trigger Conditions (정책을 재검토할 미래 시그널)

- **비-COMPLETE raw 누적이 디스크를 위협**: `SOURCE_PARTIAL`·`CLIENT_INCOMPLETE`·parse 영영
  실패분은 게이트가 보존하므로 느리게 누적된다(2026-06-13 소급 ~10%). 이것이 실제 부담이 되면
  `--include-partial` 옵트인 또는 별도 진단/재처리 도구를 도입한다.
- **유예 기간 부적합**: 기본 3일이 운영상 짧거나 길면 `HOGA_RETENTION_DAYS`로 조정.
