# 0163 — 유예 밖 CLIENT_INCOMPLETE raw 회수 (resume 할 수 없는 resume 소스)

**Status:** accepted (2026-08-27)

**Related:**
- ADR-0075 — raw retention 자동 prune (본 ADR이 게이트를 넓히는 대상)
- ADR-0019 — raw는 resume/재parse용 SSOT (CLIENT_INCOMPLETE가 보존돼 온 근거)
- ADR-0135 — 보유 창 밖 미확정 갭 회수 (같은 형태의 선례: "확정될 수 없으면 terminal")
- ADR-0093 · ADR-0126 — 업스트림 갭 확정 경로

## Decision

`hoga prune` 에 옵트인 게이트를 추가한다. 다음을 **모두** 만족하는 raw 만 회수한다:

1. `date < today − N`일 (기존 유예 창, 기본 3일)
2. hogaplay-source가 `DiskState.CLIENT_INCOMPLETE`
3. **그 (date,code)의 parquet이 존재한다** (`_has_parsed_parquet`)

수동 `--include-stale-incomplete`, 자동 `HOGA_PRUNE_STALE_INCOMPLETE`. 둘 다 기본 off.

## Why — "resume 소스" 라는 근거가 유예 밖에서 성립하지 않는다

ADR-0075는 `CLIENT_INCOMPLETE` 를 **절대 삭제 불가**로 두었다. 근거는 "raw가 resume
커서의 소스이고, 지우면 처음부터 다시 받아야 한다" 였다. 그 전제는 **업스트림에 데이터가
남아 있을 때만** 성립한다.

hogaplay 업스트림 보유는 **~18시간**이다. 즉 유예(기본 3일)를 통과한 시점에 resume 도,
처음부터 다시 받기도 **물리적으로 불가능**하다. 그 raw는 "재개 소스" 가 아니라 *재개할
수 없는 재개 소스* 이고, ADR-0075의 게이트가 상태만 묻고 **나이를 묻지 않아** 영구
보존돼 왔다.

**실측 2026-08-27** (raw 272GB 시점):

| CLIENT_INCOMPLETE 나이 | dirs | 용량 | resume |
|---|---:|---:|---|
| 0~1일 (업스트림 창 안) | 42 | 5.1 GiB | ✅ |
| 2~3일 (유예 안) | 76 | 9.3 GiB | ❌ |
| 4~30일 | 258 | 27.8 GiB | ❌ |
| 31~180일 | 555 | 49.9 GiB | ❌ |
| 180일 초과 | 235 | 32.6 GiB | ❌ |
| **합계** | **1,166** | **124.7 GiB** | 유효분 **4%** |

가장 오래된 것이 **367일 전**이었다. 디스크는 85% 사용(여유 139GB) 상태였고 raw는
거래일당 44~45GB씩 늘고 있었다(캡처 종목 61→311).

## 조건 3이 load-bearing 이다 — parquet 없는 raw는 유일 사본이다

`CLIENT_INCOMPLETE` 는 "받다 만" 상태다. 받은 만큼이 parquet에 있으면 raw를 지워도
**그 부분은 보존**된다 — 잃는 것은 "더 받아서 이어붙일 능력" 뿐이고 그 능력은 이미
업스트림 만료로 사라졌다. parquet이 없으면 raw가 그 (date,code)의 **유일한 사본**이라,
지우면 데이터가 통째로 사라진다.

실측: 유예 밖 1,048건 중 1,007건(96.1%)이 parquet을 갖고 있었고 41건이 없었다. 나이
조건만으로 열었다면 그 41건을 잃었을 것이다. 조건 3이 그것을 지킨다.

`_scan` 이 이 판정을 하고 `_is_prunable` 에 결과만 넘긴다 — 술어가 디스크를 읽지
않게 하려는 분리다. 보존된 건은 `client_incomplete(no_parquet)` 라벨로 갈라 보고해,
"플래그를 켰는데 왜 안 줄지" 가 출력에서 바로 보이게 한다.

## ADR-0135와 같은 형태, 다른 클래스

ADR-0135는 `SOURCE_PARTIAL` + 미확정 갭 중 **확정될 수 없게 된 것**을 회수했다. 본 ADR은
`CLIENT_INCOMPLETE` 중 **재개될 수 없게 된 것**을 회수한다. 둘 다 "시간이 지나 그 상태의
존재 이유가 소멸했다" 는 같은 논증이고, 스위치를 따로 두는 것도 같다 — 다른 결정이므로
한 플래그로 묶지 않는다.

## Consequences

- 회수 기대량 ~106 GiB (110.3에서 parquet 없는 몫 제외).
- **되돌릴 수 없다.** 지운 raw의 미수집 구간은 영영 채울 수 없다 — 다만 그 구간은
  이미 업스트림 만료로 채울 수 없었고, 이 결정이 바꾸는 것은 "채울 수 없는 상태로
  디스크를 점유하는가" 뿐이다.
- 기본 off라 켜지 않으면 종전과 동일하다.

## Trigger Condition

`client_incomplete(no_parquet)` 가 유의미하게 쌓이면(수집이 파싱보다 앞서는 구조적
문제) 그 자체가 별도 조사 대상이다 — 본 ADR의 게이트는 그것을 **회수하지 않고 보고만**
한다. 또한 업스트림 보유 창(~18h)이 늘어나면 조건 1의 유예(3일)가 그 창보다 짧아지지
않도록 재검토한다.
