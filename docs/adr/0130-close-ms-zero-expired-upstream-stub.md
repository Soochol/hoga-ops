# ADR-0130 — `close_ms=0` 만료 업스트림 스텁: 복구 불가 확정 + 재시도 차단

- 상태: 채택 (2026-07-29)
- 관련: ADR-0063(`open_ms=0` 분류단계 정상화 — **본 ADR 이 그때 미룬 후속**),
  ADR-0093(확인된 업스트림 갭 스킵), ADR-0126(세션 경계 갭 사전 판별),
  ADR-0020(invariant 카탈로그), ADR-0019(raw = resume/재parse SSOT)

## 배경

ADR-0063(2026-06-03)이 `open_ms=0` 을 분류 단계에서 KRX 09:00 으로 정상화하면서,
같은 sentinel 을 쓰는 `close_ms=0` 은 손대지 않고 이렇게 남겼다:

> `close_ms=0`은 129건(6개 날짜)이나 `collection_complete=False`/`is_partial=True`
> 복합 결함으로 메타 보정만으론 못 살리는 별도 트랙이다.
> — `close_ms=0` 129건은 미해결 — 수집 미완 복합 결함으로 별도 재캡처 트랙(후속 ADR).

그 후속 ADR 은 쓰이지 않았다. 본 ADR 이 그것이다.

2026-07-29 에 `hoga validate` 의 ADR-0037 사각(코퍼스의 2.1% 만 스캔)을 고치자 이
클래스의 실제 규모가 드러났다. **573개 소스**, `meta.close_after_open` 573 +
`meta.close_in_kst_range` 573 — 두 invariant 가 정확히 같은 소스에서 발화하고
ctx 가 전부 `{"close_ms": 0, "open_ms": 90000000}` 이다. 129 → 573.

## 진단 — 파서 결함이 아니라 업스트림 스텁

`meta` 에 보존된 `raw_info_tsv` 가 직접 증거다. `parts[5]`(파서가
`regular_session_close_ms` 로 읽는 필드, `hoga/parser/__init__.py:59`)가 실제로 `0`
이다. 파서는 업스트림 값을 정확히 기록했다.

hogaplay 는 보유 창(실측 ~18시간) 밖 거래일을 요청받으면 실패하는 대신 **스텁**을
돌려준다. 정상 캡처와 대조하면 규모가 분명하다:

| | 573건 (중앙값) | 정상 COMPLETE |
|---|---:|---:|
| `total_unique_events` | 3,003 | 33,884 |
| `pages_collected` | 311 | 1,271 |

**정상의 약 9%**. 전부 `collection_complete=False` / `is_partial=True` / `INVALID` 분류.
6개 거래일(2026-03-13·03-31·05-18·05-26·05-27·06-01)이 각각 그날 캡처의 72~80% 를
차지하고, 나머지 1건은 2026-07-20 이다.

즉 파서 → invariant → 분류 → read-path 제외까지 **전 구간이 올바르게 동작한 결과**다.
결함은 데이터가 아니라, 이 상태에 도달한 뒤 아무도 멈추지 않았다는 데 있었다.

## 문제 — 재시도 차단만 빠져 있었다

`decide_capture` 의 정책은 다음과 같았다:

```
SOURCE_PARTIAL + upstream_gap_confirmed → skip "upstream_gap"    ← 차단 있음 (ADR-0093)
INVALID                                 → proceed, fresh capture  ← 차단 없음
```

ADR-0093 의 `upstream_gap` 스킵은 `SOURCE_PARTIAL` 전용이다. 그런데 `close_ms=0` 은
error severity 라 **`INVALID` 로 먼저 라우팅**된다. 그 순서 자체는 옳다 —
`collection_complete=False` 를 먼저 보던 시절 5/18/003490 이 `build_range_bundle` 의
INVALID 필터를 빠져나가 차트를 깨뜨린 사고를 고친 것이 그 순서였다(ADR-0063 시기).

**같은 수정이 이 클래스를 재시도 차단 경로에서 빼냈다.** 결과적으로 날짜 범위 백필이
그 6개 날짜를 반복해 훑을 때마다 스텁을 받아 `INVALID` 를 재생산했다. 2026-07-29
시점에 573건 중 **537건이 최근 14일 내에 새로 쓰인 것**이었고 최신은 당일 13:02 였다.
과거 부채가 아니라 진행 중인 출혈이었다.

## 결정

### 1. "재캡처 트랙" 을 폐기하고 복구 불가로 종결한다

ADR-0063 이 상정한 별도 재캡처 트랙은 성립하지 않는다. hogaplay 보유가 ~18시간이고
대상은 3~6월 거래일이므로 **업스트림에 원본이 이미 없다**. 재캡처는 같은 스텁을,
재parse 는 같은 `0` 을 얻는다(573 중 334건은 raw 가 남아 있지만 파서가 읽는 값이
동일하다). 이 573건은 영구히 복구 불가다.

### 2. 만료된 스텁의 재시도를 차단한다

`decide_capture` 에 가드를 추가한다(`hoga/api/eligibility.py`). 두 조건을 **모두**
요구한다:

1. error 집합이 `{meta.close_after_open, meta.close_in_kst_range}` 와 **정확히 일치**
2. 캡처 날짜가 업스트림 보유 창(달력일 2일) 밖

`force_retry=True` 는 ADR-0093 과 동일하게 우회한다. `skip_reason` 은 새 값을 만들지
않고 `upstream_gap` 을 재사용한다 — 사용자에게 뜻이 같고, union 을 넓히면 프론트
미러 union(`frontend/src/api/types.ts`)과 표시 매핑까지 함께 손대야 한다.
`phase.ts` 는 이미 `upstream_gap` 을 `source_partial` 표시로 접는데 이 클래스에도
그 표시가 맞다.

### 3. `close_ms` 는 여전히 정상화하지 않는다

`open_ms=0` 을 09:00 으로 복원했으니 `close_ms=0` 도 15:30 으로 복원하면 되지 않나 —
자연스러운 질문이고, 답은 **하면 더 나빠진다** 이다.

| | `open_ms=0` (ADR-0063) | `close_ms=0` (본 ADR) |
|---|---|---|
| 수집 상태 | `collection_complete=True`, `is_partial=False` | `collection_complete=False`, `is_partial=True` |
| 데이터 | 정상 (시각만 결함) | 정상의 ~9% (스텁) |
| 정상화 결과 | `INVALID` → `COMPLETE`, 차트에 복귀 | `INVALID` → `CLIENT_INCOMPLETE` |

`open_ms` 는 **시각만 고치면 나머지가 멀쩡했다** — 31/32 가 salvageable 이었다.
`close_ms` 는 시각을 고쳐도 데이터가 9% 그대로다. 더 나쁜 건 분류가 옮겨가는 방향이다:
`CLIENT_INCOMPLETE` 는 `decide_capture` 가 **`resume=True` 로 재시도하는** 상태다.
즉 정상화는 (a) 재시도를 막기는커녕 늘리고, (b) 앱에는 "이어받으면 되는 것" 처럼
보이게 만든다. 실제로는 이어받을 원본이 업스트림에 없다.

그래서 `normalize_session_bounds` 는 `close_ms` 를 계속 제외한다. 그 docstring 이
가리키는 "별도 복합 결함" 의 결론이 본 ADR 이다.

## 결과

- 백필이 그 6개 날짜를 다시 훑어도 `upstream_gap` 으로 스킵된다. 실 코퍼스 검증:
  573건 전부 스킵, `force_retry=True` 는 통과, 정상 Stock-Date 200건 표본에서
  `upstream_gap` 0건(가드가 넘치지 않는다).
- 업스트림 요청이 그만큼 줄어든다 — hogaplay 예의 측면의 이득이기도 하다.
- 기존 573건은 디스크에 남는다. `INVALID` 라 `build_range_bundle` 이
  `excluded_dates` 로 빼므로 차트·조회에서 보이지 않는 비활성 상태다. **삭제 여부는
  본 ADR 의 범위 밖**이며 사용자 판단으로 남긴다(ADR-0019 가 raw 를 재parse SSOT 로
  규정한 것과 별개로, 이 parquet 들은 재parse 해도 같은 결과다).
- `hoga validate` 는 이들을 계속 error 로 보고한다. 그게 맞다 — 상태를 감추는 것이
  아니라 "복구 불가로 알려진 것" 으로 다루는 것이 본 결정이다.

## Trigger Conditions (정책을 재검토할 미래 시그널)

- **보유 창 추정이 틀린 것으로 드러남**: `_UPSTREAM_RETENTION_DAYS = 2` 는 실측
  ~18시간에 여유를 둔 값이다. 창 안인데 스텁이 오거나 창 밖인데 정상 데이터가 오면
  상수를 재조정한다. 좁게 잡아 받을 수 있는 캡처를 막는 쪽이 더 나쁘다는 판단은 유지.
- **hogaplay 가 스텁 대신 명시적 에러를 주기 시작**: 그러면 `close_ms=0` 시그니처
  대신 그 에러를 1차 신호로 삼는 편이 정확하다. 본 가드는 시그니처 매칭이라
  업스트림 응답 형태 변경에 취약하다.
- **`close_ms=0` 이 보유 창 안에서 반복 관측**: 장중 캡처의 정상 상태와 구분되지
  않는 새 결함이 생겼다는 뜻이다. 조건 (2)의 전제가 흔들리므로 재설계.
- **573건이 디스크 압박 요인이 됨**: 현재는 비활성이라 방치가 합리적이다. 정리가
  필요해지면 "INVALID + 복구 불가 확정" 을 삭제 게이트로 쓸 수 있다(ADR-0075 의
  `--include-confirmed-gaps` 와 같은 옵트인 형태).

## References

- 구현: `hoga/api/eligibility.py::_is_expired_upstream_stub`
- 테스트: `tests/test_api_eligibility.py` (만료 스텁 스킵 / 창 안 진행 / force_retry
  우회 / 다른 error 혼재 시 진행 / CLIENT_INCOMPLETE 넘침 방지)
- 진단 경위: `hoga validate` 의 ADR-0037 사각 수정(스캔 404 → 19,221건)이 규모를 노출
