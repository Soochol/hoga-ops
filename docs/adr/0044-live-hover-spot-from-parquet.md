# 0044 — Live page hover spot reads from parquet, not LiveBuffer

**Status:** accepted (2026-05-28)

**Related:**
- ADR-0038 — Live Capture는 JSONL append + 17:00 Promotion
- ADR-0039 — Source Preference는 preference + fallback (sources_available 판정에 SSE buffer 포함)
- ADR-0043 — Today Promotion (장 중 5분 주기 jsonl→Parquet overwrite)
- `docs/superpowers/specs/2026-05-28-live-page-hover-spot-design.md`

## Decision

`/live` 페이지에서 캔들 차트에 hover하면 sidebar(10호가·거래원·체결)는 그 시점의
spot 데이터를 보여준다. 이 spot 데이터는 **promoted parquet에서만** 읽는다 —
구체적으로 기존 replay용 REST 엔드포인트(`/api/orderbook`, `/api/trades`,
`/api/brokers/series`)를 그대로 사용한다. **LiveBuffer(SSE in-memory ring buffer)
는 hover spot 조회 경로에 참여하지 않는다.**

source preference(`useSourcePreferenceStore`, hogaplay/kis_live)는 위 세 엔드포인트
에 `source_pref` 쿼리 파라미터로 전달되어 ADR-0039의 preference+fallback
의미론을 따른다. 단, **그 fallback 체인은 parquet 가용성만 고려한다** — SSE buffer는
가용성 판정에서 제외한다.

## Why

세 가지 대안:

**A. parquet-only path (replay 엔드포인트 재사용)** ← 채택
근거:
- hover spot은 **(t, code) 키 기반 조회**다. LiveBuffer는 "최신 1건"만 보관하는
  ring buffer라 구조적으로 spot 조회를 서빙할 수 없다 — SSE 경로를 쓰려면 시간
  키 인덱스를 따로 만들어야 함.
- 이미 검증된 read path 재사용. `_resolve_source` 의 fallback 로직, 카드 컴포넌트
  (`OrderbookTable`, `BrokerTrajectoryTable`, `TradesTable`), 캐시 전략(`useSpot`)
  모두 replay에서 일하고 있음.
- ADR-0043 덕분에 오늘 자 데이터도 평균 5분 lag로 parquet에 들어옴 — 절대적인
  데이터 누락 윈도우는 작음.

**B. LiveBuffer에 시간 키 인덱스 추가 → SSE-based hover spot**
거부 사유:
- ring buffer에 시간 인덱스 추가 = retention 정책, 메모리 부담, multi-source
  멀티플렉싱 책임이 hot path로 흘러 들어옴.
- 데이터가 partial(retention 윈도우 내) → spec UX는 "데이터 있으면 보이고 없으면
  비어 있음"인데, retention 경계가 사용자에게 비가시 → 디버깅 어려운 케이스 양산.
- 5분 lag 해소 외에 다른 이득 없음.

**C. parquet 우선 + LiveBuffer 폴백 하이브리드**
거부 사유:
- 같은 시점에 대해 두 데이터 소스가 다른 답을 줄 가능성(예: LiveBuffer는 10s
  snapshot, parquet은 bucket-aligned) → "어느 게 진짜야?" 디버깅 함정.
- 두 경로 모두 유지 + 테스트 = 비용 두 배. 5분 lag 해소를 위한 비용으로는 과함.

## Trade-off accepted

- **오늘 자 첫 5분(또는 Today Promotion 사이클 직후~다음 사이클 시작 전 사이의
  최신 데이터)**: live chart에는 SSE로 들어와 캔들/표시가 되지만 같은 시점에
  hover하면 sidebar는 빈 상태가 나올 수 있다. 사용자 인지부조화가 발생 가능.
- 완화책:
  - sidebar 빈 상태에 "다음 가용: HH:MM" 힌트(가능한 경우 `available_from`
    응답 필드 활용).
  - `LiveStatusBar` source chip이 실제로 데이터를 가져온 source를 반영해
    fallback 사실을 투명화.
- 이 trade-off가 운영상 실제 마찰이 된다면(=사용자 시그널 발생), 본 결정을
  뒤집고 LiveBuffer 인덱스 도입을 재검토.

## Boundary with ADR-0039

ADR-0039의 `/live` `sources_available` 판정 셋째 줄("SSE buffer에 데이터가 있으면
'kis_live' 가용")은 **live chart의 tick stream** (캔들 그리기, status chip)에만
적용된다. **hover spot은 그 규칙의 부분집합** — parquet 가용성만 본다.

이 boundary는 의도된 비대칭이다: 두 데이터 경로가 다른 데이터 형태(tick stream
vs spot 조회)를 다루기 때문.

## Invariant introduced

> `/live` 페이지의 hover spot 데이터 fetch 경로는 LiveBuffer / SSE 스트림에
> 의존하지 않는다. `useLiveOrderbookAtCursor` / `useLiveTradesAroundCursor` /
> `useLiveBrokersAtCursor` 의 fetcher가 `useLiveStream` 또는 LiveBuffer 관련
> 모듈을 import하면 ADR-0044 위반.

위반 시: 두 데이터 경로가 silently 섞이면서 같은 시점에 다른 답이 나오는
케이스가 만들어짐.

## Future signal to revisit

- 오늘 자 첫 5분 갭(또는 Today Promotion이 비활성/실패한 환경)의 빈 sidebar가
  사용자 보고로 올라올 때.
- LiveBuffer의 retention 정책이 "최신 1건 + 시간 keyed 인덱스"로 자연스럽게
  확장될 다른 요구(예: live replay scrub)가 정당화될 때.
- Today Promotion 주기가 1분 이하로 짧아져서 갭 자체가 무의미해질 때(역방향
  완화 — ADR이 무용해지면 그때 superseded 표시).

## Amendment (2026-06-11) — 최근 캔들 갭은 프론트 SSE 버퍼로 봉합

**트리거:** 위 "Future signal to revisit" 첫 줄(최근 캔들의 빈 sidebar가 사용자
보고로 올라올 때) 발생. blessp 보고 — /live 1분봉에서 최근 캔들(전/전전)에 hover하면
10호가가 빈칸. 실측(2026-06-11 장중): kis_live parquet은 직전 ~2분을 아직 안 들고
있어 `/api/orderbook` 가 `snapshot=null` 반환. = 본 ADR이 명시적으로 예고한 trade-off.

**개정:** 거부됐던 **대안 C(parquet 우선 + 버퍼 폴백 하이브리드)를 좁은 형태로 채택**한다.

- spot **fetcher**(`useLiveOrderbookAtCursor` 등)는 **여전히 parquet-only** — 위
  invariant 그대로 유효. 하이브리드는 fetcher가 아니라 **`LiveSidebar` 합성 레이어**에
  산다(테스트가 요구한 "새 seam"). `live.ob`(SSE 15분 슬라이딩 버퍼,
  `liveSnapshotBuffer.ts`)는 이미 페이지가 들고 있으므로 새 fetch/연결 없음.
- 우선순위: **parquet authoritative.** `LiveSidebar` 는 parquet spot 을 먼저 보고,
  그게 `null` 일 때만 `orderbookSnapshotAtCursor(ob, cursorMs, bucketMs)` 로 버퍼에서
  **버킷 대표값**(백엔드 `query_bucket_representative` 와 동일 의미론 — 버킷 내 마지막
  연속거래 book, 동시호가 3단 제외)을 뽑아 채운다.
- **대안 C 반론("어느 게 진짜?")의 무력화:** 두 소스가 시간대를 **공유하지 않는다**.
  parquet 은 승격된 과거, 버퍼는 미승격 최근 꼬리 — 한 시점에 대해 정확히 하나만
  답한다. 둘 다 없을 때만(= 버퍼 윈도우 밖 진짜 갭) 기존 빈 상태 + "다음 가용" 힌트
  유지.

**별개 수정(같은 PR):** rightOffset whitespace(마지막 캔들 오른쪽 빈 띠) hover 시 lwc 는
`CrosshairMode.Normal` 에서 빈 time 이 아니라 가상축을 외삽한 **미래 시각(세션 꼬리
15:20–15:30)** 을 준다. 그대로 두면 커서가 미래 무데이터 슬롯에 고정돼 빈칸이 된다.
`LiveChartRoot` crosshair 핸들러는 `realMs > 마지막 캔들 ts_ms` 를 감지하면
현재 커서를 최신값으로 되돌리는 대신 **마지막 유효 hover 포인트를 보존**해 사이드바 표시를
유지한다. (이건 spot 데이터 소스와 무관 — 빈 띠는 과거 시점이 아니다).
