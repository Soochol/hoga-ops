# 차트 Maximum update depth 조사 — 2026-09-07

조사 기준: `c345463d0`, React 18.3.1 / Zustand 4.5.7. 아래 원인 분석과 대조표는 수정 전 기록이다.

## 수정 결과

사용자 승인 후 `useViewportBackfill`의 캐시 완료 후속 확장을 `setTimeout(0)`으로 예약하도록 수정했다. 실제 fetch의 하강 엣지는 이미 비동기 요청을 거쳤으므로 기존 즉시 진행을 유지한다. 총 예산 60과 캐시 완료 판정은 그대로다.

예약은 effect cleanup에서 취소하고, 실행 직전에 현재 범위·fill 스텝·목표·로딩 상태·진행 게이트를 다시 확인한다. 예산과 처리 완료 표시는 실제 dispatch 때만 갱신하므로 취소·재예약이 진행 기회를 잃게 만들지 않는다. 종목/봉/차트·캔들 소스·저장뷰 목표·날짜 하한 변경도 effect 의존성에 포함한다. 소스 변경 시 진행 목표를 버리는 대신 이전 예약을 취소하고 새 소스의 완료 신호로 재판정한다.

백필 진행 로그에 `settledBy: cache | fetch`도 추가했다. 그룹 링크 채널과 전역 업데이트 진단 ring buffer는 변경하지 않았다. 이들은 아래 후속 개선안으로 남긴다.

실제 workspace action/구독을 연결한 `frontend/src/live/useViewportBackfill.cached.test.tsx`에 회귀 테스트 11개를 추가했다. 수정 전 첫 9개가 모두 실패했고, 수정 후에는 추가 대조 케이스까지 통과한다. 기존 warm-cache 테스트 2개는 다음 태스크 실행 후 결과를 확인하도록 조정했다.

- 기존 재현 실행기 `sync`: **54회 쓰기 후 예외 → 60회 쓰기 후 정상 stop**, 최종 날짜 `20250515`.
- 전체 프론트 테스트: **531개 파일 / 7,103개 테스트 통과**.
- 타입 검사: `npm run typecheck` 통과.
- 프로덕션 빌드: `npm run build` 통과. `live-workspace` 청크 825.93 kB가 설정 임계치 700 kB를 넘는 경고는 남아 있다.
- 브라우저 E2E: **36개 통과** (1.3분). 이 워크트리 전용 포트 20196/21196, 무자격 테스트 백엔드에서 실행했다. 기존 전체 흐름의 회귀 검증이며 사용자의 당시 쿼리 캐시를 재현한 테스트는 아니다.

이 변경은 사용자 브라우저의 당시 캐시를 직접 재현한 검증은 아니다. 조사 때 확인한 동일 오류 경로를 실제 React/Zustand 훅 테스트에서 제거했다.

## 결론과 확실성

**캐시 완료 신호를 받은 백필 effect가 다음 범위 확장을 동기적으로 실행하면서 React 업데이트 체인을 너무 길게 만드는 결함을 재현했다.** 백필은 예산 60스텝으로 유한하지만, 설치된 React의 중첩 업데이트 제한은 50이다. 이 때문에 종료 조건에 도달하기 전에 예외가 발생할 수 있다.

첨부 로그와 같은 `useViewportBackfill → windowView.extend → workspace.extendChartHistoricalRange` 경로에서 같은 예외가 발생했다. 현재 소스를 실제 Vite `transformRequest`로 변환했을 때도 로그의 `useViewportBackfill.ts:1033`은 원본 `useViewportBackfill.ts:1206`의 진행 루프(3a) `historicalRange.extend(plan.nextFrom)`와 일치했다.

다만 **사용자 브라우저의 당시 쿼리 캐시·종목·봉·저장뷰·날짜 하한은 확보하지 않았다.** 재현에서는 캐시 응답의 완료 날짜를 훅 입력으로 모델링했다. 실제 React, Zustand, 창 Provider, 범위 확장 액션과 구독을 사용했지만 전체 `useLiveBundle` 쿼리 파이프라인이나 실제 차트 렌더러를 실행한 것은 아니다. 따라서 동일 오류 경로의 충분조건을 확인한 것이며 당시 사용자 조작까지 확정한 것은 아니다.

## 반복 경로

1. 저장뷰 등 과거 구간 요구가 fill을 시작한다.
2. 요청한 `historicalFromDate`가 이미 서빙 중인 캐시 응답의 `settledFromDate`와 같고 `isExtending=false`면 3a의 `settledByCache`가 참이다.
3. `planFillStep`이 다음 범위를 계산하고 effect 안에서 즉시 workspace를 갱신한다.
4. workspace 구독이 React 렌더를 일으키고 다음 캐시 완료 날짜가 전달된다.
5. 각 스텝의 날짜는 계속 과거로 이동하므로 동일 날짜 중복 방지와 스토어의 단조 감소 가드를 모두 정상 통과한다.
6. 이 체인이 충분히 길면 백필 예산을 소진하기 전에 React가 중단한다.

재현의 `coverage_gap` 경로는 dispatch당 1스텝이다. 분봉 `left_pan`은 여러 스텝을 묶을 수 있으므로 **60스텝이 모든 모드에서 60번 렌더를 뜻하지는 않는다.** 날짜 하한이나 가까운 목표는 더 일찍 종료시킨다.

주요 코드:

- `frontend/src/live/useViewportBackfill.ts:62`: `MAX_FILL_STEPS = 60`
- `frontend/src/live/useViewportBackfill.ts:1156`: `settledByCache`
- `frontend/src/live/useViewportBackfill.ts:1206`: 동기적인 다음 스텝 dispatch
- `frontend/src/live/liveDateTime.ts:652`: 예산·날짜 하한·목표를 기준으로 다음 스텝 계획
- `frontend/src/live/useLiveBundle.ts:1669`: 활성 소스의 캐시 완료 날짜 산출
- `frontend/src/state/workspace.ts:1009`: 실제 범위가 더 과거이면 스토어 갱신
- `frontend/src/live/workspace/windowView.ts:583`: windowId 기준으로 메모한 액션 어댑터

React 설치 소스 `frontend/node_modules/react-dom/cjs/react-dom.development.js:25397`의 `NESTED_UPDATE_LIMIT = 50`과 `:27328`의 throw를 직접 확인했다. 50은 이 버전의 내부 값이며 앱이 의존할 공개 계약은 아니다. 테스트에서 관측한 총 store 쓰기 54회도 React의 내부 중첩 카운트와 동일한 지표가 아니다.

## 대조 실험

차트·axis·bundle·canTriggerBackfill 참조를 고정하고 그룹 링크 채널을 제외했다. 기본 입력은 1분봉, 초기 축 2026-07-09, 먼 저장뷰 목표 2020-01-01, 하한 없음이다. 네 경우 모두 같은 하니스를 사용한다.

| 실험 | 바꾼 조건 | 실제 workspace 쓰기 | 결과 |
|---|---|---:|---|
| sync | 캐시 완료 즉시 다음 스텝 | 54 | 동일 Maximum update depth 예외 |
| shallow | 목표만 2026-06-01로 변경 | 6 | 목표 범위를 덮고 정상 stop |
| no-echo | 완료 날짜만 null로 변경 | 1 | 예외 없음, 하지만 fill이 완료되지 않고 멎음 |
| deferred | 액션 실행만 setTimeout(0)으로 넘김 | 60 | 예산 소진 후 정상 stop |

`sync`는 최초 하니스와 최종 실행기에서 반복 실패했다. deferred의 종료 날짜는 2025-05-15로, **먼 목표 날짜까지 완주했다는 뜻이 아니라 예산 상한까지 안전하게 진행하고 종료했다는 뜻**이다. deferred는 액션 경계에서 실행 시점만 바꾼 인과 확인용 실험이며 완성된 수정 구현은 아니다.

기존 관련 테스트도 실행했다: `useViewportBackfill.test.tsx`, `workspace.chartConfig.test.ts`, `groupChartLinkSource.test.ts` **92개 통과**. 기존 백필 테스트는 다수가 extend를 no-op spy로 바꾸거나 수동 rerender로 다음 응답을 주므로, 실제 store 쓰기 → 자동 재렌더 → 즉시 다음 캐시 완료의 연쇄를 놓칠 수 있다.

## groupChartLink의 역할

로그의 `workspace×20`, `groupChartLink×18`은 한 프레임에 함께 발생한 쓰기 집계다. 20은 앱의 진단 임계치이며 React의 50회 제한과 별개다.

`ChartWindow.tsx:667` 이후 발행 effect는 매 커밋 실행되지만 `lastLinkRef`로 값 동등성을 검사한다. bundle이나 adjustFactors 참조가 바뀌면 링크를 발행하고 구독 데이터 창을 갱신한다. 채널 자체에는 중복 발행 가드가 없다.

**그룹 링크 없이도 같은 오류가 재현되므로 이 채널은 오류 발생의 필수 원인이 아니다.** 첨부 로그에서 후속 렌더 비용을 늘렸을 가능성이 있지만, 당시 어떤 필드가 달라져 발행됐는지는 현재 로그로 알 수 없다. `useSyncExternalStore`의 snapshot이 읽을 때마다 새 객체를 만드는 문제도 아니다. 현재 구현은 Map에 저장된 객체를 그대로 반환한다.

## 개선안 우선순위

### 1. 백필 진행을 예약하고 취소 가능한 방식으로 바꾼다

3a에서 다음 스텝을 React의 현재 동기 업데이트 체인 밖으로 예약한다. `setTimeout` 등의 별도 태스크를 사용하는 방향이 실험에서 유효했다. 적용 시 요구사항:

- 창별 대기 작업은 하나만 유지하고, fetch/cache 완료 신호가 겹쳐도 중복 진행하지 않는다.
- 실행 직전 현재 요청 날짜·fill 세대·code·timeframe·chart·소스·하한과 진행 가능 여부를 다시 확인한다.
- 언마운트·차트 교체·종목/봉/소스 변경·새 기간 점프로 무효화된 작업을 취소한다.
- dispatch를 취소했는데 예산만 소비되거나 fill이 잠기는 상태를 만들지 않는다.
- 기존 날짜 하한과 총 예산, 캐시 완료 신호를 유지한다.

`requestAnimationFrame`은 화면 갱신과 맞추기 좋지만 백그라운드 탭에서 지연되므로 정책 선택이 필요하다. 단순 `queueMicrotask`, deps 삭제, StrictMode 해제는 검증된 대안이 아니다. 예산을 50 미만으로 줄이는 것도 내부 제한에 의존하면서 정상 과거 조회 범위를 줄이는 임시 우회다.

### 2. 실제 구독을 연결한 회귀 테스트를 추가한다

현재 재현을 수정 전 실패 / 수정 후 성공하는 정식 테스트로 옮긴다. 60개 연속 캐시 응답에서 정확한 예산 종료, 콜드/웜 혼합, stale 응답, 알려진 하한, 예약 도중 종목·차트 변경 및 언마운트 취소를 확인한다. 그 다음 실제 캐시가 있는 브라우저에서 저장뷰·기간 점프·좌측 팬과 그룹 데이터 창 동반 상태를 검증한다.

### 3. 후속 렌더와 진단을 개선한다

`publishGroupChartLink` 입구에 의미상 동일한 발행을 걸러주는 비교를 모으면 호출자마다 가드를 빠뜨릴 위험을 줄인다. 비교 항목은 현 계약의 모든 필드를 포함해야 하며 bundle 깊은 비교는 피한다. 이것만으로 현재 재현 결함이 해결되지는 않는다.

업데이트 진단에 `windowId`, 이전/다음 from, fill 종류, stepCount/budget, 완료 신호 종류(cache/fetch), fill 세대를 제한된 ring buffer로 남기면 다음에는 실제 반복 원인을 첨부 로그만으로 구분하기 쉽다. 현재 로그는 writer의 스택은 보여주지만 무엇이 바뀌어 다시 실행됐는지는 보여주지 않는다.

## 재실행

프론트 의존성이 설치된 저장소 루트에서 실행한다. 실행기는 `frontend/src/live/`에 고유한 임시 테스트를 복사하고 종료 시 제거한다. 앱 소스는 수정하지 않는다.

```bash
bash docs/diagnostics/2026-09-07-update-depth/run.sh sync
bash docs/diagnostics/2026-09-07-update-depth/run.sh shallow
bash docs/diagnostics/2026-09-07-update-depth/run.sh no-echo
bash docs/diagnostics/2026-09-07-update-depth/run.sh deferred
```

수정 전 코드에서 sync의 exit 1은 의도된 재현 결과였다. 수정 후에는 sync도 exit 0이며, 실행기는 예약된 진행의 정상 종료까지 기다린다. no-echo의 성공은 결함을 고쳤다는 뜻이 아니라 진행 신호 제거 시 단발 정지가 발생함을 확인한 것이다. 사용자 개발 서버나 저장된 브라우저 상태는 변경하지 않았다.

React 공식 문서도 effect의 상태 변경이 의존성 변경으로 돌아올 때 반복이 생긴다고 설명한다: [useEffect](https://react.dev/reference/react/useEffect#my-effect-keeps-re-running-in-an-infinite-cycle). 외부 스토어 snapshot의 참조 안정성 계약은 [useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore#im-getting-an-error-the-result-of-getsnapshot-should-be-cached)에 별도로 정리돼 있다.
