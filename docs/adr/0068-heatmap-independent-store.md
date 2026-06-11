# 0068 — 히트맵은 독립 스토어: watchlist 공유를 끊고 heatmap.json 평행 스토어로

**Status:** proposed (2026-06-11)

**Related:**
- `docs/superpowers/specs/2026-06-11-heatmap-watchlist-separation.md` — 이 ADR이 근거를 기록하는 스펙.
- `docs/superpowers/specs/2026-06-10-watchlist-heatmap-design.md` — 이 ADR이 **반전**하는 선행 결정("**백엔드 무변경**", `useWatchlist` 재사용, "페이지 = `useWatchlist()`가 주는 걸 그릴 뿐"). 그 스펙의 렌더링 설계(레이아웃·히트 색·정렬 토글)는 유효; **데이터 소스 결정만** 뒤집는다.
- ADR-0065 (watchlist.json v2: forward-migrate, never quarantine) — heatmap.json도 **같은 거버넌스를 독립적으로** 따른다(아래 Decision §3).
- ADR-0004 (Wire Model = consumer shape; 미분류는 render-only 그룹) — heatmap도 동일하게 `folder_id is None`을 합성 폴더 없이 render-only 그룹으로 다룬다.
- ADR-0052 (activeCode SSOT·jump-to-live), ADR-0056 (KIS live quote 오버레이) — 히트맵 행 클릭/시세 오버레이는 무변경.

## Decision

**관심맵(`/heatmap`)과 관심종목(Watchlist)은 더 이상 같은 데이터를 공유하지 않는다.** 히트맵은 자체 영속 스토어 `<data_dir>/heatmap.json`, 자체 REST `/api/heatmap/*`, 자체 React Query 키 `['heatmap']`을 갖는 **독립 리스트**가 된다. 한쪽에 종목/폴더를 추가·이동·삭제해도 다른 쪽은 변하지 않는다.

세 가지 규칙:

1. **별도 스토어 · 별도 락 · 캡처 필드 없음.** `hoga/api/heatmap.py`는 `watchlist.py`를 복제하되 `_path → heatmap.json`, **자체 `asyncio.Lock()`**(watchlist 락 공유 금지 — watchlist 락은 캡처 핫패스/finalize 훅에 묶여 있다), 그리고 `HeatmapEntry = {code, name, folder_id, order}`로 **캡처 필드(`registered_at_kst_date`·`last_success_date`)와 그 시드/`bump_last_success`/`set_last_success`를 제거**한다. 히트맵은 monitoring-only라 캡처 시맨틱이 없다.

2. **캡처/라이브 파이프라인은 watchlist만 따른다.** `live_session.py`의 Live Set 랭킹(`_compute_live_set`·`display_ordered_codes`), `scheduler.py`의 일일 캡처/캐치업, `captures.py`의 finalize 훅은 **전부 watchlist 전용으로 유지**한다. 히트맵 라우트는 watchlist 라우트의 `refresh_live_stream` 호출(watchlist_routes에 15곳)을 **전부 제거**한다 — 히트맵은 `/api/live/quotes`를 폴링하는 read-only 소비자일 뿐 KIS WebSocket 구독을 구동하지 않는다.

3. **부팅-시 1회 시드, 이후 영구 독립.** `heatmap.json`이 **부재**하고 **watchlist가 비어있지 않을 때만** watchlist `load_document`를 **읽어서**(쓰기 0 → watchlist 무손상) folders + entries를 캡처 필드 제거 후 복사한다(폴더/엔트리 order 보존). 존재하면 skip(멱등). **빈 watchlist에는 시드하지 않는다** — 빈 채로 `heatmap.json`을 만들면 영구 미재시드되는 footgun이라, 빈 상태면 다음 부팅에 재시도한다(그릴링 G6). folder_id는 **verbatim 복사**(문서 스코프라 동일 id 안전 — G5). 시드는 단방향·1회뿐 — 이후 지속 동기화는 **없다**.

heatmap.json 자체의 로드/세이브는 ADR-0065를 **독립적으로** 따른다: `schema_version 2`, 전진-마이그레이션(quarantine 금지), 손상 시 `heatmap.json.corrupt-<TS>` 백업 후 빈 문서. (단일 watchlist 마이그레이션이 아니라, 같은 패턴을 따르는 **두 독립 스토어**다.)

## Context

선행 스펙(2026-06-10)은 의도적으로 "**백엔드 무변경**"을 택했다: 히트맵을 `useWatchlist()`의 한 뷰로 만들어 **즉시 출시**하고 백엔드 표면을 늘리지 않으려는 결정이었다. 그 결과 히트맵·관심종목·드로어·라이브·캡처가 모두 `watchlist.json` 하나를 공유한다. CONTEXT.md L186도 관심맵을 "**한 Watchlist의** 모든 폴더 종목을 펼친 화면"으로 규정한다.

그러나 운영하며 드러난 의미적 충돌:

- **관심종목 = "내가 캡처/추적하는 종목"**(운영 머신리: 일일 캡처 enqueue, `last_success_date`, 캐치업). **히트맵 = "내가 시장 온도로 훑어보는 종목"**(모니터링). 두 집합은 본질적으로 다르다 — 캡처하고 싶지 않지만 지켜보고 싶은 종목, 캡처하지만 히트맵에 두고 싶지 않은 종목이 모두 존재한다.
- 공유 스토어에서는 히트맵에 한 종목을 더하는 것이 곧 **캡처 파이프라인에 그 종목을 등록**하는 부작용을 낳는다(`refresh_live_stream` → KIS 구독, 일일 enqueue). 모니터링 편의가 운영 부하·구독 한도(메모리: KIS 등록 한도 ~32/연결)를 건드린다.

사장님은 2026-06-11 Q&A에서 **완전 독립**을 명시 선택했다. 따라서 선행 스펙의 "백엔드 무변경" 전제는 더 이상 유효하지 않으며, 이 ADR이 그 반전을 기록한다.

두 개의 잠재 함정이 코드 주석이 아니라 ADR을 필요로 했다:

- **공유 락 재사용의 유혹.** heatmap.py가 watchlist `_lock`을 import해 쓰면 히트맵 UI 조작이 캡처 finalize 훅(`bump_last_success`, 매 캡처 성공마다 발화)과 직렬화돼 캡처 핫패스를 블록할 수 있다. 규칙 1이 자체 락을 강제한다.
- **미분류 가시성과 시드의 상호잠금.** 현재 `heatmap/visibleGroups.ts`는 `folder !== null`로 미분류를 **숨긴다**(선행 스펙 §53 "렌더 노이즈 방지"). 시드 복사를 하면서 이 필터를 유지하면 — 그리고 POST가 항상 미분류로 먼저 들어가므로 — 시드된 미분류 종목과 **이후 추가하는 모든 종목**이 보이지 않는 "추가했는데 아무 일도 없음" 사일런트 버그가 된다. 그래서 시드(결정 1)와 미분류 표시(결정 3)는 **함께** 채택해야 한다. 스펙 §4.4가 `visibleGroups`를 `g.entries.length > 0`로 바꾸고 보드/폴더에 null-safe 분기를 추가한다.

## Alternatives considered

- **(기각) 빈 히트맵으로 시작.** 사장님이 234종목+섹터 폴더를 손으로 재구축해야 한다 — 강한 비추천. 시드 복사가 현재 레이아웃을 무손상 승계한다.
- **(기각) watchlist entry에 `in_heatmap: bool` 플래그 추가(단일 스토어 유지).** 두 리스트가 여전히 한 문서·한 락·한 캡처 파이프라인을 공유 → 부작용 분리 실패. "별도 폴더 분류"도 표현 불가(히트맵 섹터 ≠ 캡처 그룹). 진짜 독립이 아니다.
- **(기각) 캡처 필드를 heatmap entry에 보존.** 분리의 목적(관찰 vs 운영 디커플)을 정면으로 무효화하고, `last_success_date` 시드가 의미 없는 디스크 조회를 유발한다. 필요해지면 향후 `schema_version 3+`로 추가 가능.
- **(채택) heatmap.json 평행 스토어 + 1회 시드 + 캡처 파이프라인 watchlist 전속.** watchlist.py를 검증된 템플릿으로 복제(축소)해 새 버그 표면을 최소화하고, 운영/모니터링 관심사를 깨끗이 가른다.

## Consequences

- **신규 백엔드 표면**: `hoga/api/heatmap.py`, `hoga/api/heatmap_routes.py`, `models.py`에 3 모델, `app.py`에 라우터 마운트 + 시드 호출. 에러 코드 `already_in_heatmap`은 `already_in_watchlist`와 분리(프론트 판정 교차오염 방지).
- **프론트 데이터-소스 커플링은 정확히 2파일에서 끊긴다**: `pages/Heatmap.tsx`(`useWatchlist`→`useHeatmap`), `heatmap/useAddToFolder.ts`(watchlist 훅→heatmap 훅). 순수 유틸(`grouping.ts`/`visibleGroups.ts`/`heat.ts`)·`heatmapPrefs`는 공유/독립 그대로.
- **편집 표면은 신규 스코프다(그릴링 G3)**: 2026-06-10 설계는 히트맵의 무거운 편집(삭제·폴더간 이동·폴더 rename/delete)을 공유 `WatchlistDrawer`에 위임했다. 분리 후 그 드로어는 watchlist만 편집하므로, 히트맵은 **보드 인라인 편집**(행 메뉴=삭제+폴더이동, `WatchlistRowMenu` 파라미터화 재사용; 폴더 헤더 메뉴)을 자체로 가져야 한다. 삭제는 MVP 필수, 폴더 rename/delete는 2차 패스 허용. 메뉴 기반 이동이라 멀티칼럼 DnD를 피한다.
- **우측 레일은 watchlist/screener 그대로(그릴링 G4)**: `rightRail` 패널에 'heatmap'을 추가하지 않는다. /heatmap에서 드로어를 열면 watchlist(다른 리스트)를 보여주지만 React Query 키 분리로 상호 간섭이 없다 — 분리 후엔 정상. 보드 인라인 편집이 있어 히트맵 편집에 드로어가 불필요하다.
- **DRY 절충(그릴링 G2)**: 본 ADR의 clone 방향은 캡처-크리티컬 watchlist.py 리팩터를 피하기 위함이지 DRY 포기가 아니다. 순수·캡처무관 헬퍼(`_reindex`/`_mint_folder_id`)는 import 공유한다. 프론트 훅 중복이 과하면 백엔드는 clone 유지한 채 훅 팩토리 파라미터화(hybrid)로 회복 가능 — 3번째 foldered-list가 생기면 그때 백엔드도 일반화(rule-of-three).
- **관심종목은 풀페이지 시각화를 잃는다** — 분리 후 watchlist의 유일한 홈은 우측 `WatchlistDrawer`다(결정 5). 필요해지면 별도 작업으로 `/watchlist` 라우트(HeatmapBoard 재사용, watchlist 키)를 추가할 수 있다.
- **데이터 안전**: 시드는 watchlist를 읽기만 하므로 watchlist 무손상. heatmap.json도 ADR-0065 백업-온-손상을 받는다.
- **선행 문서 갱신 필요**: CONTEXT.md L186–188(관심맵 정의에서 "한 Watchlist의" 제거, 독립 리스트로 재서술), 2026-06-10 스펙에 supersede 노트("데이터 소스 결정은 ADR-0068로 반전, 렌더링 설계는 유효").
- **리뷰어 주의**: heatmap_routes에 `refresh_live_stream`이 **없는 것**은 누락이 아니라 결정(규칙 2)이다. 히트맵 조작은 라이브 구독·캡처를 건드리지 않아야 한다.
