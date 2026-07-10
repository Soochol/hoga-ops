# 0097 — 히트맵 종목을 KIS REST 30초 기록기에 REST-전용 추가 후보로 합류

**Status:** accepted (2026-07-10)

**Related:**
- ADR-0068 (히트맵 독립 스토어) — 이 ADR이 **일부 수정(amend)** 하는 결정. 규칙 2의 "히트맵 라우트는 `refresh_live_stream`을 호출하지 않는다"와 "히트맵은 read-only 소비자"를 완화한다. 규칙 1(별도 스토어·별도 락·캡처 필드 없음)과 규칙 3(1회 시드)은 **무변경**.
- `hoga/live/rest30_recorder.py` — 재사용되는 기존 30초 REST 기록기(호가 FHKST01010200 + 체결 + 거래원, JSONL→promote→parquet).
- `hoga/live/coverage.py` — `plan_storage_targets(rest_extra_candidates=...)` · `_compute_heatmap_rest_extras` (구현점).
- ADR-0038 (JSONL 핫패스 → parquet 승격) — 저장 경로 무변경으로 상속.

## Context

히트맵(`/heatmap`)은 시장-온도 모니터링 보드로, 종목 집합이 관심종목과 독립이다
(ADR-0068). 사용자는 히트맵에 올려둔 종목들의 10호가·체결·거래원을 REST로
10~30초 간격 영속 수집하기를 원한다 — 나중에 `/live`·`/study`에서 그날 데이터를
되돌아보기 위해서다.

정확히 이 목적의 인프라가 이미 있다: `Rest30sRecorder`는 관심종목 중 WS 슬롯을
초과한 종목을 30초 주기 REST(종목당 3콜)로 기록한다. 부족한 것은 대상 선정뿐 —
`_compute_capture_candidates`가 watchlist만 읽는다.

단순 union(히트맵 코드를 후보 리스트에 합류)은 함정이 있다: 관심종목이 WS
슬롯(계정당 ~10종목)을 다 채우지 않았을 때 히트맵 종목이 남는 슬롯으로 승격되어,
히트맵 편집마다 WS 재구독 churn이 생기고 "히트맵 = REST 수집"이라는 단순한
멘털 모델이 깨진다.

## Decision

**히트맵 종목은 REST-전용 추가 후보(`rest_extra_candidates`)로만 합류한다.**

1. `plan_storage_targets`에 `rest_extra_candidates` 파라미터를 추가한다.
   추가 후보는 **어떤 경우에도 WS 슬롯에 들어가지 않고** `kis_api_targets`
   뒤에 붙는다. watchlist 후보와 중복되는 코드는 dedup(관심종목 쪽이 이김).
   `ws_only` 정책에서는 **버려진다** — 정책이 "KIS API 저장 끔"을 의미하므로.
   `kis_rest_bypass_enabled`가 켜지면 기존대로 `kis_api_targets` 전체가
   비워지므로 히트맵 수집도 함께 꺼진다(의도).
2. `sync_storage_runtime`이 `_compute_heatmap_rest_extras(data_dir)`
   (히트맵 문서 순서 보존 + symbol-master 필터)를 공급한다.
3. 히트맵 라우트 중 **엔트리 집합이 바뀌는 4곳**(add, remove, folder-member
   add, bulk remove)만 `refresh_live_stream`을 best-effort로 호출해 저장
   타깃을 재동기화한다. 폴더 rename/reorder/move/delete-folder는 집합 불변이라
   훅이 없다. 히트맵 편집 시 WS 타깃은 불변이므로 `session.refresh`의 WS
   재구독 diff는 no-op — 훅 비용은 rest30 `set_targets` 갱신뿐이다.

주기는 기존 30초·범위는 기존 3콜(호가+체결+거래원)을 그대로 쓴다. 저장·승격·
조회·지표(체결분포·거래원·히트맵 pane 등)는 전부 기존 경로를 무변경 상속한다.

## Consequences

- 히트맵 종목 N개가 늘 때 지속 REST 부하는 0.1N 콜/s(30초 주기 3콜). 계정
  풀(15콜/s×3) 기준 100종목까지 여유. 기록기 콜은 전부 `background` 우선순위로
  용량 스케줄러에 들어가므로 사용자 대면(user_visible) 요청이 항상 선행한다.
- 히트맵은 여전히 hogaplay 캡처·일일 스케줄러·finalize 훅과 무관하다(ADR-0068
  규칙 2의 그 부분은 유지). 캡처 필드도 계속 없다 — 커버리지 계획이
  `load_heatmap`을 read-only로 읽을 뿐이다.
- 관심종목의 WS 배분·기존 REST 스필오버 순서는 한 종목도 바뀌지 않는다.
- 히트맵 편집이 `refresh_live_stream`을 트리거하므로, 그 안의
  `_buffer.drop_codes_except(ws_targets)`가 모든 REST 캡처 코드(히트맵 포함)의
  라이브 ring 버퍼를 드롭하고 다음 30초 폴에서 재적재한다 — 즉 히트맵 종목 추가
  직후 최대 30초간 라이브 버퍼 공백이 생길 수 있다. 이는 watchlist 편집이 이미
  유발하던 것과 **동일한 기존 동작**이고(트리거만 히트맵으로 확장), 저장(JSONL)은
  영향받지 않는다.
- 사이클 소요시간: 기록기는 순차 순회라 대상이 수백 종목이 되면 사이클이 30초를
  넘어설 수 있다(토큰버킷 지배). 그 시점이 오면 주기·범위 축소나 병렬화를 별도
  결정한다.
