# 0095 — KIS 과거 분봉 디스크 캐시: memory-only 재확인 (되돌림 거부)

**Status:** accepted (2026-07-09)

**Related:**
- ADR-0040 — Live Candle Backfill은 별도 cache namespace + 별도 wire (2026-07-04 amendment로 memory-only)
- ADR-0043 — Incremental Promote Today (오늘치는 프로모션 중 → 영속 금지)
- ADR-0075 — Raw retention auto-prune (디스크 증가 프루닝 선례)
- ADR-0090 — Live minute backfill warm + read-ahead (콜드→웜 선행 채움)
- ADR-0092 — Dual-horizon cache primitive (`PastCandlesCache` mem vs `PastIndicatorsCache` disk)
- `docs/superpowers/specs/2026-07-04-kis-candle-cache-consolidation-design.md` (Implemented)

## Context

성능 스윕(PR #504 depth·#506 체결분포/거래원·#508 탭복귀)으로 "과거일 불변 결과의
재계산·재요청·재변환" 클래스를 소진한 뒤, /live에 남은 가장 큰 콜드 비용은 **서버
재시작 후 워밍창 밖 과거로 딥스크롤할 때의 KIS 분봉 콜드 fetch**다. 실측 16.4초
(267260, 콜드 8캘린더일 청크, `LiveMinuteCandleBackfill` concurrency=3 세마포어 +
KIS 15/s 공유 버킷). 세션 내에서는 `PastCandlesCache` 메모리 히트 + 워밍(ADR-0090)이
이미 네트워크 0에 수렴한다 — 비용은 **재시작 직후 + 워밍창 밖 딥스크롤**에 국한된다.

이 콜드 비용을 없애는 유일한 큰 레버는 완결된 과거 거래일 분봉(불변)을 디스크에
영속화해 재시작을 건너뛰는 것이다. 그런데 이는 **2026-07-04에 의도적으로 제거한 결정을
되돌리는 일**이므로, 본 ADR로 되돌림 여부 자체를 판단한다.

## 되돌림 대상 결정 (2026-07-04)

원래 ADR-0040(2026-05-28)은 KIS 과거 분봉을 `~/.local/share/hoga-ops/kis-past-candles/
<code>/<YYYYMMDD>.json`에 **영구 디스크 캐시**했다. 2026-07-04 amendment + consolidation
spec(Status: Implemented, 커밋 d36167a8)이 이를 **process memory-only로 전환**하며 세
가지 근거와 하나의 값(value)을 명문화했다:

1. **혼란스러운 중간지대** — 저장 데이터처럼 보이나 Source Preference·Inventory·
   DiskState·`/api/range` 완결성 어디에도 속하지 않음.
2. **원치 않는 디스크 증가** — 사용자가 보존을 원치 않는 데이터. (legacy
   `kis-past-candles/`에 실제 ~28,026개 JSON이 아직 잔존.)
3. **데이터 소유권 단순화** — KIS REST Bypass 시 "메모리에 있으면 표시, 없으면 저장된
   데이터로 폴백하거나 빈 구간, KIS를 조용히 치지 않음".
- **값**: spec Acceptance "**Restarting the backend clears KIS candle cache and does not
  count as data loss**", UX "없으면 없는 대로 표시하고 또 다른 저장 시스템을 만들지
  않는다". Out-of-scope에 "Persisting KIS candles into parquet" 명시. Open Follow-Up:
  "later only if it becomes a real product requirement — **that should be a separate
  ADR-level decision**." 본 ADR이 그 요구된 ADR-level 결정이다.

## 핵심 질문

전용 namespace의 **순수 캐시**(=`kis-past-indicators/`와 동일 계약: `/api/range`가 읽지
않음·비-Source·비-Inventory·투명 재빌드)로 디스크 영속하면 위 폐기 근거가 해소되는가?

## 근거별 평가

- **③ Bypass — 쉽게 해소.** 디스크는 KIS 앞의 한 캐시 티어일 뿐이다. Bypass = (mem ∨
  disk) 히트, 미스면 KIS 무접근. "silently hit KIS 금지" 계약이 그대로 유지된다.
- **① 혼란스러운 중간지대 — 부분 해소, 잔여 있음.** 전용 캐시 계약이면 방금 랜딩한 지표
  캐시(ratio/fill/peak/poc/depth/vdist/broker)와 동형이라 Source/완결성 오염은 없다.
  **그러나 결정적 차이가 남는다**: 지표 캐시는 로컬 parquet에서 **재계산**된다(무손실·
  무료). KIS 분봉은 **로컬 durable source가 없어**(kis_live는 설계상 candles.parquet을
  만들지 않음 — ADR-0040) 재빌드가 곧 **외부 KIS 재fetch**(느림·quota 소모)다. 즉 이
  디스크 파일이 **유일한 로컬 사본**이 되어 "저장처럼 느껴지는" 근원이 실제로 남는다.
- **② 디스크 증가 — 상한으로 완화 가능하나 신규 부담.** ADR-0075 auto-prune 선례가
  있고 ~1MB/code/year(ADR-0040 추정)이지만, LRU+캡 없이는 무한 증가한다. consolidation
  spec은 "explicit command 없는 auto-delete 반대"를 명시하므로, 자동 프루닝 정책 자체가
  또 하나의 새 결정을 요구한다.
- **가치 충돌 (가장 첨예).** spec Acceptance "재시작이 KIS 캔들 캐시를 비우고 이는
  데이터 손실이 아니다"는 디스크 영속과 **정면으로 배치된다**. 디스크 영속의 목적이 바로
  재시작을 건너뛰는 것이므로, "재시작 = 초기화"라는 명시적 계약을 깬다. "디스크는
  재빌드 가능한 가속기이므로 잃어도 손실이 아니다"라는 재해석은 논리적으로 가능하나, 이는
  **팀이 5일 전에 택한 값의 반전**이다.

## Decision

**되돌림을 거부한다. KIS 과거 분봉 캐시는 process memory-only를 유지한다**(ADR-0040
2026-07-04 amendment 및 consolidation spec 재확인).

## Why

1. **이득이 좁다.** 콜드 비용은 재시작 직후 + 워밍창 밖 딥스크롤에만 발현한다. 로컬
   단일-사용자 정상 사용에서 상시 부과되는 세(稅)가 아니며, 워밍(ADR-0090)이 종목 활성
   시 최근 구간을 백그라운드로 이미 재-채운다.
2. **근거 ①·②와 가치 충돌이 실재한다.** 외부-only 데이터의 유일 로컬 사본이라는 점에서
   지표 캐시와 본질이 다르고("저장 vs 캐시" 경계가 진짜 흐려짐), 이를 되살리는 것은 5일
   전 명시적으로 반전한 값을 다시 뒤집는 일이다. 짧은 시차의 왕복 반전은 결정의 신뢰도
   자체를 훼손한다.
3. **경제성.** 되돌림은 무효화 함정(§Consequences), 자동 프루닝 정책, 새 테스트 스위트를
   동반하는 ADR급 작업인데, 이득은 occasional하다.

## Trade-offs and what we considered

- **(거부) 딥스크롤 성능을 위해 되돌림.** 위 Why.
- **(채택) memory-only 유지 + 워밍 의존.** ADR-0090 워밍이 재시작 후 콜드를 부분 완화하는
  기존 경로를 신뢰. 딥스크롤 첫 진입의 지연은 수용된 비용.
- **(향후 조건부) 되돌림 재개.** 아래 Trigger 중 하나가 충족되면 본 결정을 supersede하고
  "Reversal 설계"로 진행한다.

## Trigger Conditions (되돌림 재검토)

다음 중 하나라도 충족 시 본 ADR을 재검토한다:

- **재시작이 잦은 배포 형태 등장** — 로컬 단일 프로세스가 아니라 잦은 재기동/멀티
  인스턴스가 되면 콜드 재fetch가 상시 비용이 된다.
- **딥스크롤 콜드가 상시 UX 불만으로 측정** — `_fresh_past_fetches`(콜드 재지출 지표,
  `live_candle_backfill.py`)가 재시작 후 반복적으로 높게 관측되고 사용자 체감으로 확인.
- **KIS quota가 실질 제약** — 재fetch 회피 가치가 디스크 비용을 압도.

## Reversal 설계 (Trigger 충족 시 그대로 실행)

되돌리기로 하면 아래 설계로 구현한다(조사로 확정, 인프라 완비):

- **신규 namespace** `data_dir/kis-past-minute-candles/<venue>/<code>/{date}.json`. legacy
  `kis-past-candles/`는 venue 세그먼트가 없어 재사용 금지. `PastIndicatorsCache` 패턴
  이식: `SCHEMA_VERSION` 게이트 · `atomic_write_json`(temp+fsync+replace) · corrupt/버전
  불일치 → 미스 후 재fetch로 자가치유.
- **read-through는 `PastCandlesCache.get_past` 내부**(mem miss → 디스크 조회 →
  `_bars_match_date` 검증 → `record_disk_hit` + mem 승격). fetch/`_inflight` 단일비행
  레이어는 무변경(디스크 히트가 그 위에서 콜드 fetch를 원천 차단 → `_fresh_past_fetches`
  안정).
- **past만 영속.** `_today_mem`은 절대 디스크에 쓰지 않는다(ADR-0043 — 오늘은 프로모션
  진행 중). 비거래일 `[]`는 negative 캐시로 영속하되, "거래일인데 빈 비-KRX venue"는
  영속 금지(아래 함정).
- **Bypass 게이트** = (mem ∨ disk) 히트, 미스면 정책에 따라 KIS 또는 warned-empty.
  데이터 소유권 표: KIS minute candles `Durable? = No`(rebuildable cache) 유지, Storage =
  "process memory + rebuildable disk cache".
- **디스크 상한**: per-code 캡 + 전역 LRU 또는 ADR-0075식 age 프루닝(자동 프루닝 정책을
  명시적으로 채택).

## Consequences

- KIS 과거/오늘 분봉은 계속 process memory-only. `/api/live/past-candles`는 새 디스크
  파일을 쓰지 않는다. 재시작은 KIS 캔들 캐시를 비우며 데이터 손실이 아니다.
- `/api/range`·Source Preference·Inventory·DiskState 불변. legacy `kis-past-candles/`는
  런타임 입력이 아닌 상태 유지(정리는 별도 명시 명령/유지보수 액션으로만).
- **(Reversal 시에만) 무효화 함정 — critical:** `delete_past`·`_drop_date`(stale) 및
  비-KRX 폴백 성공 후 `delete_past(policy, ...)`가 디스크 파일도 제거해야 한다. 안 그러면
  "거래일인데 빈 비-KRX venue" 항목이 디스크에 박제돼, 재시작 후 read-through가 이를
  covered로 오인하여 KRX 폴백을 영구 억제한다.
- ADR-0040의 2026-07-04 amendment와 consolidation spec의 판단이 본 ADR로 **재확인**된다
  (되돌림 없음).
