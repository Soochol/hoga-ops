# 0061 — Source 관련 resolver 4개는 통합 "정책 모듈"로 합치지 않는다

**Status:** accepted (2026-06-03)

**Related:**
- ADR-0037 — Source별 서브폴더 layout
- ADR-0039 — Source Preference + fallback
- `docs/superpowers/specs/2026-06-03-architecture-deepening-design.md` 후보 3

## Decision

`hoga/api/`에는 source(`hogaplay` / `kis_live`)를 다루는 함수가 여럿 있다 —
`sources.resolve_source`, `queries._find_winning_meta`, `disk_state.aggregate_disk_state`,
`queries.list_stock_dates_in_range`. 한 아키텍처 리뷰가 이 넷이 "source precedence를
서로 다르게 판정한다"며 단일 "정책 모듈 + 타입드 accessor"로 통합하자고 제안했다.

**거부한다.** 넷은 *같은 질문에 불일치하는 답*이 아니라 **서로 다른 4개 질문에 각자
옳게** 답한다. 통합하면 복잡도가 한 곳에 집중되는 게 아니라 flag/variant로 이동해
shallow abstraction이 된다(LANGUAGE.md deletion test). 분리 유지한다.

## Why — 넷은 다른 질문에 답한다 (코드 검증)

| resolver | 답하는 질문 | precedence 근거 |
|---|---|---|
| `resolve_source` (sources.py) | 데이터를 **어느 source에서 읽을지** | pref 있으면 pref, 없으면 `next(iter())`, 둘 다 없으면 pref (ADR-0039 presence 기반) |
| `_find_winning_meta` (queries.py) | inventory에 **어느 meta를 표시할지** | hogaplay → flat → None. **kis_live 제외**: kis_live snapshots는 `t_ms`(Unix-ms), inventory reader는 hogaplay `ts_ms`(HHMMSSmmm) 인코딩 가정 — 렌더 불가한 *데이터-shape 비호환* |
| `aggregate_disk_state` (disk_state.py) | 전체 **완성도 STATE** | COMPLETE > SOURCE_PARTIAL > … (best-state-wins) |
| `list_stock_dates_in_range` (queries.py) | 날짜가 **존재하는지**(any source) | pref-first는 존재 체크 단축일 뿐 — 출력은 날짜 문자열이라 source 선택이 결과에 무관 |

리뷰가 "drift"라 한 *"kis_live COMPLETE + hogaplay CLIENT_INCOMPLETE가 resolver마다
다르게 분류"* 는 **버그가 아니다**: 데이터-읽기는 pref를, 완성도는 best-state를,
inventory는 (인코딩상 렌더 가능한) hogaplay를 — 각자 자기 질문에 옳게 답한 것이다.

진짜로 공유되는 건 source-이름 우선순위 튜플 `("hogaplay", "kis_live")` 정도인데,
각 resolver가 그마저 다르게 쓴다(`next(iter())` 임의 / hogaplay-only 명시 / pref-first).
공유 추출로 얻는 locality는 미미하고, 통합 모듈은 4개 다른 의미(presence vs display-compat
vs state-priority vs existence)를 콜백/플래그로 흡수해야 해 *interface가 제거하는 중복만큼
복잡*해진다. 핸들러 쌍둥이(byte-identical → 통합이 복잡도 집중, ADR 없음)·KIS walk-back
(skeleton 차이 → 분리, ADR-0060)과 같은 판단 계열.

## Consequences

- 네 resolver는 분리 유지. 코드 변경 없음.
- **알려진 product 한계(별도 이슈 후보, deepening 아님):** kis_live-only Stock-Date는
  inventory 페이지에 invisible(인코딩 비호환). 사용자는 /live·/replay(Source Preference)로만
  본다. 고치려면 inventory reader가 kis_live의 `t_ms` 인코딩을 인지하도록 별도 작업 필요 —
  본 ADR 범위 밖.
- 미래 아키텍처 리뷰가 "source resolver를 합쳐라"를 재제안하면 본 ADR이 근거(4개 다른
  질문 + kis_live 인코딩 제약)를 제공해 재litigate를 막는다.

## When to revisit

세 번째 source가 추가돼 *실제* 우선순위 충돌이 생기거나, kis_live snapshots가 hogaplay와
같은 `ts_ms` 인코딩으로 정규화돼 `_find_winning_meta`의 제외 근거가 사라지면, 그때 공유
우선순위 추출의 가치를 재평가한다.
