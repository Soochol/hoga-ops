**hoga-ops 성능 리뷰 — 2026-09-05**

이 문서는 구현 전 리뷰 기록이다. 이후 세 개선을 반영한 내용과 최종 측정값은 [구현 결과](2026-09-05-performance-improvements.md)에 정리했다. 아래의 코드 설명·줄 번호·재현 명령은 기준 커밋을 대상으로 한다.

기준 커밋: `fd3cbe3c7f8ecf582cf61dd583c109a60bb29059`. 초기 리뷰 단계에서는 애플리케이션 코드를 변경하지 않고 실행 경로를 읽고, 합성 데이터·가짜 WebSocket·관련 테스트·프론트 빌드로 확인했다. 운영 서버, 실거래 데이터, 외부 증권사 API는 사용하지 않았다.

개선 우선순위는 **불필요한 패턴 검색 요청 제거 → 검색 기간을 계산 전에 제한 → 같은 종목의 프론트 버퍼 공유**다. 아래 세 항목은 현재 코드에서 재현했다. 모두 조건부 성능 문제(P2)이며 운영 장애나 운영 응답 시간 저하를 직접 관측했다는 뜻은 아니다.

| 순서 | 발견 | 확인한 근거 | 개선 방향 |
| --- | --- | --- | --- |
| 1 | 패턴 검색 조건을 바꿔도 이전 요청이 계속 남는다 | 봉수 5→10 변경 후 언마운트: 6개 요청 모두 fetching, AbortSignal 0개. now/history 각각 재현 | 입력 변경을 짧게 모으고 취소 신호 전달; 서버 대기 단계에서도 폐기 |
| 2 | 과거 검색의 기간 조건이 비싼 계산 뒤에 적용된다 | 합성 100만 봉, 5·20 이평: 같은 결과를 내는 범위 축소 실험본에서 검색 함수 88.73→7.92ms | 종목별 검색 시작 위치를 먼저 찾고 필요한 구간만 계산 |
| 3 | 같은 종목을 보는 창마다 실시간 버퍼를 중복 처리한다 | 8개 소비자, WS 1개·REST 1회·서버 구독 1회지만 프레임 push 8회·반환 배열 8개 | 종목·거래일별 버퍼/flush를 공유하고 venue별 결과를 구독 |

**1. [P2] 사용자가 떠난 패턴 요청을 작업 큐에 남겨 두지 않기**

근거: [usePatternSearch.ts](../../frontend/src/pattern/usePatternSearch.ts#L126), [searchPattern](../../frontend/src/api/screener.ts#L345), [백엔드 라우트](../../hoga/api/screener.py#L466).

`queryFn`이 React Query의 `signal`을 받지 않고, `searchPattern`도 fetch 옵션에 신호를 전달하지 않는다. `PatternDrawer`의 봉수 버튼은 클릭마다 바로 상태를 바꾼다. `history`에서는 길이가 항상 캐시 키에 들어가고, `now`도 기본 조건인 `flexBars=2`에서는 길이가 캐시 키에 들어간다. 따라서 기본 now 화면에서도 봉수 연타가 별개 요청을 만든다.

재현 테스트는 응답이 아직 오지 않은 상태에서 봉수를 5, 6, 7, 8, 9, 10으로 바꾸고 훅을 언마운트했다. 두 모드 모두 요청 6개, 신호를 받은 요청 0개, 언마운트 후 fetching 쿼리 6개였다. 응답 순서 때문에 최신 화면에 옛 결과가 표시된다는 주장은 아니다. 낭비는 이미 안 보는 요청의 네트워크·CPU·대기 시간이다.

서버도 요청을 곧장 `pools.wide`에 제출한다. 이 풀의 기본 워커는 3개이며 넓은 range·거래원·히트맵 계산 등과 공유된다. 인접 `/scan`에는 있는 동일 요청 병합도 패턴 라우트에는 없다. 패턴 연타가 최신 검색과 다른 무거운 조회를 지연시킬 수 있는 경로다. 운영 큐 지연의 크기는 이번에 측정하지 않았다.

권장 변경은 `queryFn({ signal }) → searchPattern(body, signal) → fetch` 전달과 서버 제출 전 대기/이탈 처리를 함께 설계하는 것이다. 짧은 입력 지연이나 마지막 입력만 실행하는 방식으로 제출 자체를 줄이고, 동일 바디의 동시 요청은 하나로 합친다. debounce 시간은 조작 반응과 서버 비용을 함께 재서 정한다.

**브라우저 fetch 취소만으로 실행 중인 프로세스 계산이 멈추지는 않는다.** 이미 시작한 작업과 아직 제출하지 않은 작업을 구분하고, 대기 중 폐기부터 구현하는 편이 범위가 작다. 기본 미사용 쿼리의 완료/캐싱 동작은 [TanStack Query 공식 문서](https://tanstack.com/query/v5/docs/framework/react/guides/query-cancellation), 실행 중 Future의 취소 제약은 [Python 공식 문서](https://docs.python.org/3/library/concurrent.futures.html#concurrent.futures.Future.cancel)와 일치한다.

완료 기준: 빠른 연타 시 제출 작업 수 감소, 패널 종료 후 대기 작업 제거, 같은 조건의 동시 요청 1회 실행, 마지막 선택 결과 유지, 넓은 range와 혼합 부하에서 최신 검색의 대기 시간/p95 확인.

**2. [P2] `since`로 제외할 과거 봉을 상관 계산 전에 자르기**

근거: [search_history](../../hoga/api/screener_pattern.py#L724), [뒤늦은 기간 필터](../../hoga/api/screener_pattern.py#L752), [구조 게이트](../../hoga/api/screener_pattern.py#L1053).

지금은 종목의 전체 이력에 `_win_sd`, 각 채널의 `np.correlate`, 선택된 거래량·거래대금 계산을 수행한 뒤 `since`보다 앞인 결과를 `-inf`로 만든다. UI의 일봉 검색 기간 기본값은 최근 1년이다. 기간을 짧게 골라도 주요 계산량은 전체 보유 이력에 비례한다. 구조 게이트를 켜면 그쪽도 전체 코퍼스를 먼저 돈다.

합성 코퍼스 100종목 × 10,000봉에서 마지막 252봉의 시작 위치만 허용하는 검색을 비교했다. 질의 길이 15, 이후 20봉, 구조 게이트/거래량 축 OFF; 두 변형을 교대로 7회 실행한 중앙값이다. 코퍼스 생성과 절단 준비 시간은 제외했다. 벤치 실행 시 이 리뷰가 시작한 빌드·테스트는 종료된 상태였다.

| 조건 | 현재 함수 | 범위를 제한한 실험본 | correlate 입력 원소 수 |
| --- | ---: | ---: | ---: |
| 이평 OFF | 56.80ms | 5.54ms | 4,000,000 → 100,800 |
| 이평 5·20 | 88.73ms | 7.92ms | 6,000,000 → 163,200 |

실험본은 기존 코퍼스의 중심화와 미리 계산한 이평을 유지하고, 이평 사례에서는 앞쪽 20봉을 더 남겼다. 두 사례 모두 후보 점수 21,800개와 이후 수익률을 `atol=rtol=1e-8`로 대조했고, 정렬된 매치의 종목·원래 위치도 일치했다. **약 10~11배는 이 합성 입력의 검색 함수 비교**이며, 운영 API 전체나 전체 옵션 조합의 개선율이 아니다.

구현은 매 요청마다 코퍼스를 복사하는 방식보다 종목별 `last_days`에서 시작 위치를 찾고 배열 뷰로 필요한 부분만 읽는 방향이 적절하다. 월·주봉은 버킷 키가 아니라 `last_days` 경계를 유지해야 한다. 원래 매치 offset, 이평 워밍업, 자기 구간/날짜 겹침 제거, 이후 수익률, 길이 유연, 구조 게이트의 인덱스를 함께 보존해야 한다.

구조 게이트를 먼저 적용해 상관 모집단까지 줄이면 응답의 분포·베이스라인 계약이 달라진다. 제안은 **이미 기간 조건으로 제외되는 구간만** 계산 전에 제거하는 것이다.

완료 기준: D/W/M 경계일, MA off/short/mid, 길이 유연, 거래량, 구조 두 기준선, 동일 종목/기간 겹침 조건의 결과 동등성; 실제 기본 요청(최근 1년·이평 short·길이 ±2)의 cold/warm 응답 시간과 CPU 측정.

**3. [P2] 같은 종목의 실시간 수집·필터 작업을 창 사이에서 공유하기**

근거: [버퍼 생성](../../frontend/src/api/liveSeries.ts#L200), [창별 push/타이머](../../frontend/src/api/liveSeries.ts#L233), [차트 소비](../../frontend/src/live/useLiveChartData.ts#L166), [데이터 창 소비](../../frontend/src/live/workspace/DataWindow.tsx#L190).

각 `useLiveSeries`는 자기 `LiveSnapshotBuffer`, 150ms 타이머, 스냅샷 배열, venue 필터 결과를 가진다. 차트 창과 호가·체결·거래원 등의 데이터 창이 같은 종목으로 열려도 이 작업은 공유되지 않는다. 아래쪽 WebSocket 전송과 초기 REST는 이미 중복 제거된다.

동일 종목·venue의 훅 8개에 호가 프레임 1개를 넣었다. 소켓 1개, 서버 subscribe 1회, 초기 series fetch 1회였지만 `LiveSnapshotBuffer.push`는 8회 호출됐고 호가 배열도 서로 다른 8개였다. 배열 복사·필터·타이머 비용이 같은 종목의 소비자 수만큼 반복되는 것을 확인했다.

공유 버퍼와 참조 카운트 구독, 종목별 단일 flush, venue/kind별 안정적인 스냅샷을 제공하면 중복 전처리를 줄일 수 있다. 창별 캔들 단위·지표 계산은 계속 독립적으로 필요하다. 프레임 payload 객체는 전송 계층에서 공유하므로 **전체 메모리가 정확히 8배이거나 렌더가 8배 줄어든다는 뜻은 아니다.** 이 항목의 실제 밀리초 이득은 React Profiler와 장시간 버퍼 크기별 측정이 필요하다.

완료 기준: 같은 종목의 여러 창에서 프레임당 버퍼 push 1회, 한 창 종료 시 다른 창 유지, 날짜/종목 교체·재연결·venue 변경과 마지막 호가 폴백의 동등성, 1/4/8창에서 commit 시간과 배열 할당 비교. 버퍼 보존 시간을 줄여 최적화하면 range 갱신 사이의 데이터 연결이 깨질 수 있으므로 보존 계약을 유지한다.

**프로젝트 구조와 추가 관측**

데이터는 키움 WS → LiveStream → 표시 버퍼/브라우저 WS와 저장 JSONL → parquet로 나뉜다. 조회는 FastAPI가 DuckDB·Polars 계산을 사용하며, 최근 추가된 wide/narrow 프로세스 풀이 무거운 계산을 API 이벤트 루프에서 분리한다. 프론트는 React Query의 과거/현재 조회 결과에 WS 꼬리를 합쳐 lightweight-charts와 데이터 창을 갱신한다. 따라서 이 프로젝트에서는 단일 계산 속도뿐 아니라 실시간 수신 지연, 오래된 요청의 큐 점유, 창 수에 따른 반복 전처리를 함께 봐야 한다.

이전 감사의 꺼진 지표 게이트, 축출 대응 증분 계산, range 캐시 회수, 창 rect의 memo 안정화, DuckDB 연결 공유는 현재 코드와 기록에서 반영을 확인했다. 이번 새 발견으로 재등재하지 않았다. 과거 기록의 측정값도 현재 운영값으로 사용하지 않았다.

현재 프론트 빌드의 entry에서 정적 import로 도달하는 JS는 1,372,848B, CSS는 97,493B, 합계 **1,470,341B(약 1.40MiB)**다. 동적 전용 청크·폰트 파일·소스맵·API 응답은 제외했다. `live-workspace`는 818,122B로 700kB 경고가 발생했다. 이 수치는 초기 코드 크기 관측이며 FCP/LCP 측정이 아니다. 지난 감사에서 lazy만 추가하는 시도가 바이트를 늘려 기각된 기록이 있으므로 파일명이나 소스 파일 크기만으로 절감량을 추정하지 않는다. 추가 분할은 실제 import 도달성 및 초기 합계의 대조 실험으로 판단한다.

**검증과 재현**

- Python 3.14.4, NumPy 2.5.2, Polars 1.41.0, DuckDB 1.5.2, Node 24.13.1, 논리 CPU 32개. 메인 체크아웃의 Python 런타임을 사용하되 `PYTHONPATH`로 이 워크트리 코드를 지정했다.
- 백엔드 관련 테스트 **115개 통과**: 패턴 검색·구조·컴퓨트 풀. 프론트 기존 관련 테스트 **18개 통과**: liveSeries·dayPeaks 성능 계약. 별도 재현 테스트 **3개 통과**: 8창 중복 처리, now/history 요청 생존. 전체 테스트 스위트나 장중 E2E를 실행했다는 뜻은 아니다.
- `npx vite build --sourcemap --manifest` 성공. 소스맵 생성 빌드의 JS 바이트를 기록했으며 `.map` 파일 자체는 합계에서 제외했다. 원본 앱 코드는 그대로다.
- [측정 원본과 재현 코드](2026-09-05-performance-review-evidence)는 이 문서와 함께 보관했다. 처음 범위 실험은 테스트와 병행됐으므로 버렸고, 최종 JSON은 해당 작업들이 끝난 뒤 다시 수집했다.

재현 명령(이 워크트리 루트 기준):

```bash
uv run python docs/research/2026-09-05-performance-review-evidence/pattern_probe.py
uv run python docs/research/2026-09-05-performance-review-evidence/pattern_probe.py --ma-short
uv run --extra dev pytest -q tests/unit/api/test_screener_pattern.py tests/unit/api/test_screener_pattern_structure.py tests/unit/api/test_compute_pools.py -m 'not wallclock'
```

프론트 재현 코드는 앱 디렉터리의 상대 import를 사용한다. `frontend-probe.test.tsx`를 임시로 `frontend/src/api/performance-review.probe.test.tsx`에 복사하고, `/tmp/hoga-performance-review-20260905` 디렉터리를 만든 뒤 `frontend`에서 다음을 실행한다. 실행 후 임시 테스트만 제거하면 된다. 이번 리뷰에서도 임시 파일을 제거했다.

```bash
npx vitest run src/api/performance-review.probe.test.tsx src/api/liveSeries.test.tsx src/live/useDayPeaks.perf.test.tsx
```
