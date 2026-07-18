# /live 웜 로드 캔들·지표 히스토리 패리티 플랜 (PR 1~4)

증상: /live 분봉에서 **콜드 로드는 캔들·보조지표가 같은 창을 함께** 받아 정렬되는데,
**웜 로드(종목 복귀·타임프레임 전환·탭 복귀)는 캔들만 병합 캐시의 딥 히스토리를
복원**하고 range 지표(mode=hoga/sidecar: 호가비·체결강도·최대벽·매물대·POC·히트맵·
프로그램)는 기본 시드 창으로 줄어든다 — "분봉은 과거가 있는데 지표는 과거가 없는" 상태.

근본 원인 4개 비대칭 (2026-07-18 분석):

| # | 비대칭 | 캔들 (`livePastCandles.ts`) | 지표 (`range.ts` 델타) |
|---|---|---|---|
| ① | 웜 복원 정책 | `previous.from <= from` → 딥 서빙 + 오늘-델타 (`livePastCandles.ts:202`) | `previous.from_date < input.from` → 좁은 창 full refetch + **딥 폐기** (`range.ts:253`) |
| ② | 캐시 수명 | canonical merged key gcTime **2h** (`main.tsx:46`) | 전역 기본 **30분** + `/study` 축출(`useStudyRangeCacheEviction`)에 노출 |
| ③ | 타임프레임 축 | merged key `[code, to, venue]` — tf 무관(1m 재집계) | identity에 `bucketMs` 포함 → 1m↔5m 전환도 콜드 |
| ④ | 갭 리페어 | — | coverage_gap 백필(A안)은 **뷰포트 이벤트에만** 발화 — 초기 표시 시 갭 방치 |

PR-1이 ①(직접 원인), PR-2가 ②, PR-3이 ④, PR-4가 ③을 담당한다.
PR-1+2만으로 "웜 복귀 시 지표만 과거 소실"의 대부분이 해소될 것으로 예상.

실행 순서: PR-1 → PR-2 → PR-3 순차(각각 독립 머지 가능, 뒤 PR이 앞 PR 효과를 전제로
테스트를 좁힘). PR-4는 1~3 착지 후 실사용 관찰로 착수 여부 결정.

---

## PR-1. [핵심] range 델타 플랜 "previous가 더 깊음" 분기를 재사용으로 전환

**파일**: `frontend/src/api/range.ts` (`planLiveRangeDelta`)

현행 `range.ts:253` 분기 — `sameIdentity && previous.from_date < input.from`이면
`canReusePrevious:false, servePrevious:false, usePlaceholderData:false`로 좁은 창
`[input.from, to]`를 전체 재요청하고 딥 캐시를 폐기한다. 웜 복귀(종목 전환 후 복귀
등)는 `historicalFromDate`가 null로 리셋돼 `input.from`이 기본 시드 창으로 좁아지므로
정확히 이 분기에 걸린다. 부수 증상: `servePrevious:false`라 재요청 동안 지표가
빈 화면으로 플래시.

- [ ] **1a. 분기 병합**: `previous.from_date === input.from` 분기(`range.ts:237`,
  오늘-델타)의 조건을 `previous.from_date <= input.from`으로 확장하고 `<` 전용
  분기(253~265행)를 삭제. 결과: previous(딥 병합본) 서빙 + `from=to=today` 오늘-델타
  요청 + `liveRangeRefreshDue` 게이팅(at-rest면 `enabled:false` +
  `scheduleRefreshAtMs`) — 캔들의 `livePastCandles.ts:202` 분기와 의미론 일치.
- [ ] **1b. 데이터 경로 확인**: `useLiveRangeDelta`의 data memo에서
  `canReusePrevious && previous` → `mergeRangeBundles(previous, todayDelta)` —
  merge가 `from_date = min(...)`을 취하므로 딥 커버리지가 유지되는지 단언.
- [ ] **1c. 소비자 영향 스윕**: `useLiveBundle`의 `indicatorCoverageFromDate`가
  웜 복귀 직후 previous의 딥 `from_date`를 보고하게 됨 → coverage_gap 백필이
  불필요하게 발화하지 않는 방향(개선)임을 확인. `isHistoricalDeltaFetching` /
  `isSidecarLoading` / reveal 게이트에 회귀 없는지 LiveChartRoot 테스트로 확인.

**테스트** (`frontend/src/api/range.test.tsx`):

- [ ] plan 단위: "previous가 요청 창보다 깊음(웜 복귀) → 오늘-델타 요청 +
  `servePrevious:true`" — sidecar·hoga 각 1케이스.
- [ ] plan 단위: 위 상태 + at-rest(최근 fetch) → `enabled:false` +
  `scheduleRefreshAtMs` 설정(기존 `===` 분기의 refreshDue 계약 승계).
- [ ] 훅 단위(기존 1096행대 하니스 확장): 캐시에 딥 번들 존재 + 좁은 input →
  `data`가 딥 병합본이고 발사된 URL이 `from=to=today` 1건.
- [ ] merge 단위: 오늘-델타 merge 후 `from_date`가 previous의 딥 값 유지.

**리스크/판정**:

- 메모리: 딥 번들이 힙에 더 오래 서빙됨 — /live는 활성 종목 1개라 유계.
  `/study`의 수십 MB 문제(#689)는 `useRange` 경로라 이 변경과 무관(델타 훅은
  /live 전용).
- "좁은 창을 일부러 다시 받아야 하는" 소비자 없음 확인(2d1eed3b는 스캔 복원 추가
  커밋이고 이 분기는 보수적 폴백이었음 — 축소 의미론에 의존하는 테스트가 있으면
  해당 테스트를 새 계약으로 갱신).
- vdist 가격 경계는 identity 중립(#583)이라 이 분기 변경과 직교 — 주석 근거 유지.

**검증**: `cd frontend && npx vitest run src/api/range.test.tsx
src/live/useLiveBundle.test.tsx src/live/LiveChartRoot.test.tsx && npm run build`.
도그푸딩(/browse): 종목 A에서 좌측 팬으로 지표 확장 → 종목 B 전환 → A 복귀 →
① 지표 과거 구간 유지 ② `network`로 range 요청이 오늘-델타 1건인지 ③ 복귀 순간
지표 pane 빈 플래시 없음.

---

## PR-2. canonical merged key + gcTime 패리티 (캔들 `mergedPastCandlesKey` 모방)

**파일**: `frontend/src/api/range.ts`, `frontend/src/main.tsx`

문제 3겹: (a) range 전역 gcTime 30분 vs 캔들 merged 2h — 30분~2h 사이 복귀는 PR-1을
해도 콜드. (b) 복원이 실키 스캔(`cachedLiveRangeDeltaPrevious`) 의존이라 개별 청크
키가 gc되면 최광폭 병합본이 소실. (c) `/study`의 `useStudyRangeCacheEviction`이
`['range', code]` inactive 쿼리를 축출 — /study를 다녀오면 /live 웜 캐시가 지워진다.
단순 `setQueryDefaults(['range'], {gcTime: 2h})`는 (c)를 못 풀고 /study 번들 수명만
연장(#689 역행)이라 **반려**. 캔들과 동일한 전용 네임스페이스가 정답.

- [ ] **2a. canonical key 정의**: `mergedLiveRangeKey(mode, identity)` →
  `['live', 'range-merged', mode, identity]`. identity는 기존
  `liveRangeDeltaIdentity`(from·vdist 경계 중립화 JSON) 재사용 — code·to·bucketMs·
  venue·옵션 조합이 이미 들어 있다. `'range'` prefix 밖이라 /study 축출과 비충돌.
- [ ] **2b. 발행**: `useLiveRangeDelta`의 기존 merge effect(`range.ts:542`)에서
  `setQueryData(mergedLiveRangeKey(...), data)` 추가 — 워크백 스텝마다 최광폭으로
  덮어쓰기(캔들 `publishedRef` 패턴 372행 그대로: 렌더 단계 pin과 분리해 effect에서만
  발행).
- [ ] **2c. 복원**: `cachedLiveRangeDeltaPrevious` 앞에 canonical key 정확-조회
  O(1)를 두고, 실키 스캔은 폴백으로 유지(구버전 캐시·동시 창 대비).
  `to_date === input.to` 검증은 데이터 쪽에서 유지(키의 identity에 to 포함이라
  자연 만족하지만 명시 가드 유지).
- [ ] **2d. gcTime 승격**: `main.tsx`에
  `qc.setQueryDefaults(['live', 'range-merged'], { gcTime: 2 * 60 * 60_000 })` —
  캔들(46행)과 동일 수명·동일 근거("점심 후 복귀"). 실 청크 쿼리는 30분 유지(병합본만
  장수명 — 메모리 상한이 identity당 1개로 유계).

**테스트**:

- [ ] 훅 하니스: 청크 워크백 완주 후 canonical key에 최광폭 병합본 존재.
- [ ] 리마운트(옵저버 소멸→재생성) 시 canonical key만으로 딥 복원 + 오늘-델타 1건.
- [ ] `/study` 축출 시뮬: `removeQueries({queryKey:['range']})` 후에도 canonical
  병합본 생존 → 웜 복원 성공.
- [ ] 날짜 롤오버(to 변경 → identity 변경): 어제 병합본을 참조하지 않고 콜드 시드로
  시작(오염 방지 — 캔들 merged key도 `to` 포함으로 동일 정책).

**리스크**: identity JSON에 지표 토글이 포함돼 토글 변경 시 병합본이 분화 —
현행 스캔도 동일 한계라 회귀 아님(개선은 PR-4 범위). 메모리는 mode 2 × 토글 조합
소수 × 2h로 유계이며, /live 병합본은 /study 번들(피크 수십 MB)보다 훨씬 작다.

**검증**: PR-1 검증 세트 + gcTime을 테스트에서 짧게 오버라이드해 만료 경계 확인.
도그푸딩: /live → /study 저장뷰 열람 → /live 복귀 → 지표 과거 유지.

---

## PR-3. 초기 표시 시 coverage_gap 1회 자동 판정 (A안 트리거 보강)

**파일**: `frontend/src/live/useViewportBackfill.ts`

coverage_gap 백필(3b else-분기, `useViewportBackfill.ts:374`)은
`subscribeVisibleLogicalRangeChange` 이벤트에만 발화한다. 저장 뷰포트가 처음부터
지표 커버리지 밖 과거를 보고 있으면 사용자가 팬/줌하기 전까지 지표가 빈 채 방치.
PR-1/2로 "받아본 범위"는 복원되므로, 남는 갭은 캔들 병합 캐시가 지표보다 원래 깊은
경우(주로 타임프레임 전환)다.

- [ ] **3a. 효과 3c 신설**: 최초 캔들 settle 후 1회, 3b의 coverage_gap 판정
  (viewport 좌단 날짜 < `indicatorCoverageFromDate` → `nextCoverageFrom`으로
  `extendHistoricalRange` dispatch)을 실행. 판정 로직은 3b의 else-분기를 함수로
  추출해 3b·3c가 공유(중복 금지).
- [ ] **3b. 게이트 승계**: `canTriggerBackfill()`(초기 뷰포트 배치 경합 가드) ·
  `candleCountRef > 0` · `fillKindRef === null` · `isExtendingRef === false` —
  3b와 동일 세트. 발화 시 fill 상태 동결(`fillKindRef='coverage_gap'` 등)도 동일
  경로를 타므로 진행 루프(3a)가 이어받는다.
- [ ] **3c. 1회성 보장**: `initialCoverageCheckedRef`를 두고 (code, timeframe) 리셋
  effect(`useViewportBackfill.ts:158`)에서 함께 초기화. 판정 결과가 "갭 없음"이어도
  체크 완료로 마킹(반복 판정 금지 — 이후는 기존 이벤트 트리거가 담당).
- [ ] **3d. 정책 불변 확인**: 목표는 **뷰포트가 실제 보는 날짜까지만**
  (`nextCoverageFrom` window-base) — 캔들 전체 범위 따라잡기 금지 유지(#582
  wide-range 52s 재발 방지). `livePerfLog`에 `trigger: 'initial_coverage'` 태그 추가.

**테스트** (`useViewportBackfill.test.tsx` / `LiveChartRoot.test.tsx`):

- [ ] 저장 뷰포트가 커버리지 밖 + 캔들 settle → `extendHistoricalRange` 1회 dispatch.
- [ ] 커버리지 안(PR-1/2 딥 복원 상태 포함) → 무발화.
- [ ] code/timeframe 전환 시 1회성 리셋 → 새 뷰에서 재판정.
- [ ] 초기 뷰포트 배치(`canTriggerBackfill` false) 중에는 홀드, 허용 후 발화.

**검증**: PR-1 검증 세트 + 도그푸딩: 1m에서 딥 팬 → 5m 전환(캔들 딥·지표 콜드) →
손 안 대고 지표가 뷰포트 범위까지 자동 충전되는지, `network`로 청크 워크백 요청
수가 뷰포트 범위 상당인지.

---

## PR-4. [보류] sidecar per-date 지표의 bucket-중립 캐시 축 분리

**상태(2026-07-18)**: 4a 사전 조사에서 **핵심 전제가 반증되어 미구현·보류**.
아래 표의 "확인 필요"·"무관" 가정이 백엔드 캐시키 실측으로 뒤집혔다 — 갱신된 표:

| 필드 | 백엔드 캐시 키 | bucket 의존 |
|---|---|---|
| **ask_peaks / bid_peaks (최대벽)** | `(…, source, **bucket_ms**)` (bundle.py:609 "버킷 대표 위 집계") | **의존** |
| depth_heatmap | `("depth", …, **bucket_ms**)` | **의존** |
| quote_ratio / fill_strength (mode=hoga) | reaggregate(bucket_ms) | **의존** |
| volume_distributions | `("vdist", …, range_count, price_min, price_max, cutoff_ms)` | 무관 |
| trade_volume_pocs | `("poc", …, range_count, price_min, price_max)` | 무관 |
| broker_late_entries | bucket 인자 없음 | 무관 |
| program_trade | `dates`만 | 무관 |

**반증의 함의**: 최대벽(peaks)이 bucket 의존이라, 4b(mode 분리)로 tf 전환에 웜으로
만들 수 있는 건 무관 4종(vdist·poc·broker_late·program_trade)뿐. 최대벽·depth·hoga는
백엔드가 tf별로 다른 값을 재계산하므로 첫 tf 전환에선 프론트 캐시를 아무리 나눠도
콜드다. 게다가 PR-2의 canonical key가 identity(bucketMs 포함)별 병합본을 저장하므로
`1m→5m→1m` 왕복은 **이미 웜**. PR-4의 남은 실효는 "1m 딥 팬 → 5m 첫 전환"에서 무관
4종을 재활용하는 것뿐이라, 백엔드+프론트 대공사(mode 신설·델타 훅 추가·reveal/배압/
coverage 3원화) 대비 효과가 미미. 실사용 관찰 후 재결정으로 보류.

**대안 후보(더 근본적)**: 진짜 병목은 최대벽의 tf 재집계 비용이다 — quote_ratio/
fill_strength가 1m 캐시에서 reaggregate로 합성하듯, peaks도 1m 캐시에서 bucket 대표를
합성하면 tf 전환 시 디스크 재쿼리 없이 웜해진다. 이는 프론트 identity 문제가 아니라
백엔드 캐시 효율 개선이라, 착수 시 별도 ADR로 다룬다.

<details><summary>원래(반증된) 4b/4c 설계 스케치 — 참고용 보존</summary>

당초 가정: sidecar 필드의 bucket 의존성이 아래처럼 갈린다고 봤다(peaks를 무관으로 오판):

| 필드 | 단위 | bucket 의존(당초 가정) |
|---|---|---|
| ask_peaks / bid_peaks | per-date | 무관 ← **오판** |
| volume_distributions / trade_volume_pocs | per-date | 무관 |
| broker_late_entries | t_ms 이벤트 | 무관 |
| depth_heatmap | t_ms 버킷 | **의존** |
| program_trade.points | t 버킷 | 확인 필요 → 무관(실측) |
| quote_ratio / fill_strength (mode=hoga) | t 버킷 | **의존** |

- [ ] **4a. 사전 조사**: program_trade의 서버 버킷팅 여부 확정(`hoga/api` bundle
  빌더). depth_heatmap의 전환 빈도 대비 재fetch 비용 실측.
- [ ] **4b. 설계**: sidecar를 두 쿼리로 분리 — `mode=sidecar_daily`(per-date 4종
  + broker_late_entries, identity에서 bucketMs 제외 → tf 전환에도 웜) /
  `mode=sidecar_bucketed`(depth_heatmap + program_trade, 현행 유지). 백엔드
  `/api/range` mode 파라미터 확장 + 프론트 델타 훅 1개 추가(`useLiveBundle`에서
  두 sidecar를 합성). PR-2의 canonical key는 mode별이라 자연 확장.
- [ ] **4c. 대안(저비용) 비교**: depth_heatmap·program_trade가 꺼진 옵션 조합에서만
  identity의 bucketMs를 중립화하는 조건부 중립화 — 백엔드 무변경이지만 identity
  규칙이 옵션-의존이 되는 복잡도. 4b와 트레이드오프 표로 결정.
- [ ] **4d. 리스크**: 쿼리 2분화로 reveal 게이트(`isSidecarLoading`)·배압
  (`isHistoricalDeltaFetching`)·coverage(`indicatorCoverageFromDate` max 정책,
  `useLiveBundle.ts:914` 주석의 동반 확장 전제)가 3원이 된다 — 이 전제 주석이
  명시적으로 재검토 대상.

</details>

---

## 공통 완료 조건

- `cd frontend && npx vitest run` 관련 스위트 그린 + `npm run build`.
- 도그푸딩 시나리오 3종(/browse): ① 팬 → 종목 전환 → 복귀(PR-1) ② /study 왕복
  (PR-2) ③ 타임프레임 전환 후 무조작 자동 충전(PR-3). 각각 `network`로 요청 폭 확인.
- 회귀 감시: 콜드 시드+청크 워크백(#582)·vdist identity 중립화(#583)·오늘-델타
  60s/5min 리프레시 계약은 어느 PR에서도 불변.
