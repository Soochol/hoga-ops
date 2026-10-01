# 정규장 분봉 드래그 반복 계산 조사

## 원인

`useLivePastCandles`와 `useLiveRangeDelta`는 병합본을 다음 렌더의
`previous`로 보관한다. 오늘 응답은 React Query에 계속 남아 있으므로,
부모 렌더마다 동일 응답을 병합본에 다시 병합했다. 새 캔들 배열과
수정주가 계수 객체가 생겨 `useLiveBundle`의 memo 경계도 무효화됐다.
정규장 모드에서는 이어서 과거 호가와 전체 번들의 재귀 필터까지 실행됐다.

실제 캔들 값이 변하지 않는 프레임에서도 이 경로가 실행됐다. 과거 응답을
받은 이후 부모 렌더 20회에서 데이터 참조가 변하는 단위 테스트로 재현했다.

## 수정

- 창/조회 identity별 병합기가 같은 응답을 이미 반영한 병합본에 재적용하지 않는다.
  새 응답이나 다른 이전 데이터는 정상 병합한다. 기존 청크 워크백, 실패 복구,
  범위 축소 경로는 유지한다. 내용이 같은 재조회도 최신 조회 시각을 갱신해
  다음 주기 재조회의 신선도 판정을 유지한다.
- 창 소유 WeakMap 필터가 불변 과거 캔들·지표·호가 레벨을 재사용한다.
  변경된 꼬리 객체는 다시 판정하며, 축출 데이터는 약한 참조로 회수된다.
- 정규장 판정은 날짜 문자열 생성/파싱 대신 UTC 하루 내 밀리초를 비교한다.
  KST 09:00와 15:30을 모두 포함한다.

## 브라우저 CPU 표본

격리된 Playwright 개발 서버에서 KRX 10분봉, 20일의 1분 원본,
거래량/호가비/체결강도/프로그램 pane을 사용했다. CDP CPU 샘플링 간격은
500µs였다. 실제 마우스를 누른 채 120px 왕복을 3회, 각 방향 50단계로
이동했고 실시간 프레임은 120ms마다 주입했다. 해당 프레임의 과거 봉 값은
불변이어서 데이터 준비의 불필요한 반복을 구분할 수 있었다.

아래는 각 파일을 포함하는 호출 스택의 누적 CPU 표본 시간이다. 서로
중첩되는 값이므로 합산하지 않는다.

| 경로 | 수정 전 | 수정 후 |
|---|---:|---:|
| useLiveBundle | 638.29ms | 21.65ms |
| regularSessionView | 487.30ms | 0.55ms |
| livePastCandles | 112.56ms | 0.55ms |
| ChartWindow | 650.47ms | 31.08ms |

측정 구간은 각각 6.05초/5.34초였다. 이 수치는 전체 화면 FPS나 사용자
환경의 지연 보장이 아니라, 동일 마우스 이동 재현에서 발견한 반복 계산의
제거 근거다. 원본 프로파일은 조사 환경의 `/tmp/minute-pan-before-true.json`,
`/tmp/minute-pan-true.json`에 보관했다.

## 회귀 검사

- 부모 렌더 20회에서 캔들/호가/sidecar 병합본 참조 유지.
- 새 오늘 응답 반영 및 기존 과거 봉 보존.
- 과거 호가 10,000개의 필터 결과 재사용, 신규/교체 꼬리 및 마감 +1ms 배제.
- KRX 1/3/5/10분봉에서 정규장 전환 후 실제 마우스 드래그와 정상 체결 틱을
  함께 구동. native 논리 범위 이동, 인접 봉 간격, barSpacing, 최신 종가를 확인하고
  드래그/단일 꼬리 갱신 동안 캔들 `setData(전체)` 호출 0회를 검사한다.

기존 간격 테스트는 정적 `setVisibleLogicalRange`와 옵션 전환만 검증했으므로
실제 드래그·실시간 갱신 비용을 검출하지 못했다.

최종 소스 기준 TypeScript 검사와 빌드, Vitest 598개 파일의 7,662개 테스트가
통과했다. 차트/정규장 대상 E2E 8개도 통과했다. 전체 E2E는 134개 통과,
10개 실패이며 실패 목록은 이전 PR 검증 로그와 동일하다. 기존 저장뷰,
스크리너, 관심종목 메뉴 실패가 남아 있어 전체 E2E 통과로 보고하지 않는다.

## 추가 렌더링 비용 개선

KRX 10분봉, 과거 20일, 300봉 표시, 5개 pane에서 실제 마우스 왕복 드래그
300단계와 120ms 간격의 유효 체결 틱을 함께 구동했다. 체결강도 축의
`toLocaleString('ko-KR')`는 약 5.4초에 14,544회 실행돼 직접 계측 95ms를
사용했다. 공유 `Intl.NumberFormat`으로 바꾼 뒤 14,582회에 5ms였다. 부호,
정수 반올림, 누적선의 소수점, NaN/무한대 출력은 이전 포맷과 동일하다.
같은 반복 포맷을 사용하던 총잔량 축도 공유 정수 포맷터를 사용한다.

보이지 않는 레전드 cells는 시리즈 값 판독·포맷 이전에 제외한다. 지표
레전드 전체를 숨기거나 분봉 전용 flag가 적용되지 않는 경우에도 값 provider를
실행하지 않는다. 이름 핸들 및 숨김 지표의 조작 기능은 유지하고, 표시를 다시
켰을 때 현재 값을 읽는다. 숨긴 체결강도의 20회 갱신은 판독·포맷 0회다.

고저 라벨은 renderer 소유 WeakMap에 불변 봉의 가상시각을 보관한다. 좌표는
여전히 각 draw에서 native 축·가격 API로 구해 팬/줌에 따라 움직인다. 축 교체는
시각 캐시를 폐기하며 새 꼬리는 새로 변환한다. 가격·대비율·시각·축이 같은
라벨의 텍스트만 재사용한다. 위치는 매번 충돌 검사하고, 안전한 기존 위치는
바로 재사용한다. 새 위치를 찾을 때는 왼쪽부터 정렬된 두 장애물 스트림을
선형으로 병합해 후보 행마다 배열 생성·정렬하는 비용을 없앤다. 임의 순서의
입력도 한 번 정렬해 처리한다.

500µs CDP 샘플링의 파일별 inclusive CPU 표본은 다음과 같다(중복 합산 금지).

| 경로 | 수정 전 | 수정 후 |
|---|---:|---:|
| fillStrength | 93.02ms | 3.33ms |
| extremeLabelClearance | 27.90ms | 12.41ms |
| HighLowLabelsPrimitive 전체 | 138.23ms | 130.18ms |
| PaneLegendOverlay 전체 | 109.48ms | 104.74ms |

측정 구간은 5.37초/5.39초다. 전체 프레임 간격 p95는 21ms/22ms로, 이번
재현에서 화면 FPS 개선은 확인하지 못했다. 개선 근거는 특정 반복 처리의
비용 감소와 불필요한 값 판독 제거다. 캔들 및 보조지표의 전체 `setData`는
두 실행 모두 0회였고 새 체결 종가는 정상 갱신됐다. 원본은
`/tmp/extra-pan-before-improvement-current.json`, `/tmp/extra-pan-current.json`,
재현 스펙은 `/tmp/extra-pan-diagnostic.spec.ts`에 보관했다.

추가 개선의 최종 소스는 타입 검사·Vite 빌드, Vitest 598개 파일 7,667개
테스트를 통과했다. 전체 E2E는 134개 통과·10개 실패(8.4분)이며, 실패 제목과
위치는 앞선 `/tmp/minute-pan-e2e.log`와 동일하고 신규 실패는 없다. KRX
1/3/5/10분봉 실제 드래그·체결 갱신, 레전드 표시 전환 및 native 값 판독 검사가
모두 통과했다. 최종 로그는 `/tmp/extra-pan-typecheck-final.log`,
`/tmp/extra-pan-vitest-final.log`, `/tmp/extra-pan-e2e-final.log`에 보관했다.

## 초봉·분봉 종합 재점검

### 조사 대상과 버전

작업 트리 `d4be870fa`를 격리된 Playwright 서버에서 검사했다. Chrome의 열린
팬오션 라이브 탭은 `localhost:5173`을 사용했고 창 8개가 있었다. 해당 서버
프로세스의 checkout은 `/home/dev/code/hoga-ops/frontend`이며, main HEAD는
`137d12cad`다. 직전 수정 `c6681d279`와 `d4be870fa`는 이 main에 아직 포함되지
않았다. 사용자 화면의 설정·저장소·서버는 변경하지 않았다.

초봉은 `SecondChartWindow → useSecondHistory → useSecondAggregates` 경로,
분봉은 `ChartWindowInner → useLiveChartData → LiveChartRoot` 경로다.
초봉은 캔들·MA20·거래량 2개 pane을 직접 만들며 분봉의 `RangeSeriesPane`,
`PaneLegendOverlay`, `HighLowLabelsPrimitive`를 사용하지 않는다. 공통으로
사용하는 가상 시간축과 120ms 연결 창 커서 throttle은 양쪽에 적용된다.

### 재현 조건 및 결과

- KRX 1/5/10/30초 및 1/3/5/10분, 정규장 OFF → ON → OFF.
- 실제 마우스로 120px 왕복 드래그 및 커서 이동, 각각 약 6.7~8.5초.
- 분봉: 과거 20일, 300봉 표시, 캔들·거래량·호가비·체결강도·프로그램 pane.
- 초봉: 앞 구간 12페이지까지 추가하고 300봉 표시. 현재 원본은 1초 revision
  응답으로 1초마다 갱신한다. 과거 페이지 응답은 요청한 from/to를 지킨다.
- 초봉 연결 창: 호가와 호버 시점 누적 매물대를 함께 표시. 1초당 가격 셀 6개를
  가진 하루 원본을 사용해 초기 source 및 갱신 부하를 추가 확인했다.
- 분봉은 120ms 간격의 유효 WS 체결을 주입했다. 최종 비교에서는 동일 분봉
  안에서 시각을 증가시켜 새 봉 생성 비용과 단순 꼬리 갱신 비용을 구분했다.

| 주기 / 구성 | 정규장 OFF 드래그 p95 | ON 드래그 p95 | ON 커서 이동 p95 |
|---|---:|---:|---:|
| 1초 | 17ms | 17ms | 16ms |
| 5초 | 18ms | 16ms | 17ms |
| 10초 | 17ms | 17ms | 16ms |
| 30초 | 17ms | 17ms | 17ms |
| 1분, 20일·5 panes | 57ms | 42ms | 38ms |
| 3분, 20일·5 panes | 30ms | 20ms | 25ms |
| 5분, 20일·5 panes | 31ms | 17ms | 17ms |
| 10분, 20일·5 panes | 23ms | 21ms | 19ms |
| 1초 + 호가·누적 매물대 | 19ms | 20ms | 19ms |

이 표는 개발 빌드·CDP 샘플링·고정 Date를 사용한 합성 데이터 재현이다.
초봉과 분봉의 pane 수와 이력 깊이가 다르므로 주기 간 성능 우열을 뜻하지
않는다. 개별 프레임 최대값에는 초기 계측 비용도 섞인다. 마지막 전체 보기로
돌아온 표본은 표에서 제외했다. 3분/5분 일부 표본과 동시에 별도 Python
벤치마크가 잠시 실행됐으므로 작은 수치 차이를 개선 효과로 해석하지 않는다.

안정된 표시 범위에서 인접 봉 좌표 간격/barSpacing 비율은 모두 1이었다.
드래그·커서 이동 중 전체 series setData는 0회였으며 꼬리 update는 계속
실행됐다. 이 재현에서는 정규장 ON이 모든 주기에서 지속적으로 더 느리지는
않았다. 초봉 단독에서는 50ms 이상의 main-thread long task가 기록되지
않았고, 누적 매물대를 붙인 ON 커서 이동 표본에서는 63ms task 1회가 있었다.

초기 진단 스펙은 setVisibleLogicalRange 직후 아직 적용되지 않은 배율을 읽어
잘못된 비교를 만들었다. 적용된 300봉 폭을 기다리도록 수정했다. 5분의 OFF
복귀 직후에는 첫 이동량 검사가 3회 실패했다. 두 rAF까지 표시를 안정시킨
별도 추적에서는 세 단계 모두 약 52.8봉 이동했고, 드래그 중 앱의
setVisibleLogicalRange 호출은 0회였다. 이 초기 실패를 사용자 입력 장애로
확정하지 않는다. 동일 초기화 경합을 피하는 기존 회귀 검사는 통과했다.
Vite 로그에는 초기 로딩의 ResizeObserver 알림 경고도 있어 관찰 사항으로
남긴다. 지속적인 리사이즈 루프나 해당 경고가 버벅임의 원인이라는 근거는
이번 조사에서 확보하지 않았다.

### 남은 반복 계산

1. **분봉의 캔들 인덱스가 가격 갱신에도 전체 재생성된다.**
   `CandleTooltip`은 candles 참조 변경마다 contains 필터와 시간→index Map
   두 개를 다시 만든다. `PaneLegendOverlay`도 별도의 필터와 가상시각 Map을
   만든다. OHLC만 바뀐 경우 시간 인덱스는 동일하다. `useViewportBackfill`의
   최초 표시 봉 찾기도 전체 캔들을 훑는다. 1분 정규장 드래그 CPU 표본에서
   tooltip 63.3ms, legend 166.4ms, 시간 처리 225.7ms가 포함됐다. 값들은
   inclusive이고 중첩되므로 합산하지 않는다.

2. **날짜 경계·가격선 계산도 같은 이력을 다시 훑는다.**
   `resolveDayBoundaryTicks`와 `PriceLevelDotsOverlay`가 각각
   `resolveSessionSpans`를 호출한다. 가격선 overlay는 enabled 확인 이전에
   spans Map을 만들기 때문에 토글을 꺼도 준비 계산이 실행되는 구조다.
   공통 `classifyWithinSegment`는 각 점마다 같은 구간의 개장 날짜와 정규장
   마감 시각을 재계산한다. mock Date 없는 별도 브라우저에서 7,820봉을
   인덱싱하는 비용은 1.4~3.9ms, spans 생성은 0.9~1.7ms/회였다. 한 번은
   작지만 실제 체결 갱신마다 여러 소비자가 중복 실행한다.

3. **초봉 서버의 증분은 응답 크기를 줄이지만 계산을 증분으로 만들지는 않는다.**
   `get_seconds`는 매 요청 전체 저장·메모리 원본을 합치고 `_project_response`로
   전체 범위 OHLCV와 가격 셀 모델을 만든다. 그 뒤 `SecondResponseRevisions`
   가 이전 전체 응답과 비교해 바뀐 초만 추린다. `useSecondAggregates`는
   매물대 창이 없어도 공통 source에서 include_prices=true를 요청한다.
   이 부하는 브라우저에서 API를 모킹한 위 프레임 표에는 포함되지 않는다.

   별도 Python 3.14.7 프로세스에서 마지막 봉 하나만 바꾸고 각 조건 5회
   반복했다. 브라우저 테스트 종료 후 독립 재측정한 중앙값은 다음과 같다.

   | 원본 / 가격 셀 | 전체 응답 구성 | revision 비교 | 반환 봉 / 가격 셀 |
   |---|---:|---:|---:|
   | 3,000초 / 3,000셀 | 11.92ms | 5.90ms | 1 / 1 |
   | 23,401초 / 가격 제외 | 186.45ms | 35.25ms | 1 / 0 |
   | 23,401초 / 23,401셀 | 305.52ms | 80.34ms | 1 / 1 |
   | 23,401초 / 140,406셀 | 914.20ms | 188.75ms | 1 / 6 |

   합성 밀도이며 실제 종목 응답 시간은 아니다. 파일 읽기·라우트 병합 비용도
   제외했다. 큰 데이터에서 839바이트의 증분 응답을 만들기 위해 약 1.1초를
   처리하는 구조가 확인됐다는 의미다.

4. **초봉 누적 매물대는 수정된 초 하나에도 전체 인덱스를 재생성한다.**
   prices 배열이 새로 생기면 `buildSecondPriceDistributionIndex`는 전체 셀을
   필터·정렬하고 가격별 prefix를 다시 만든다. hover 조회 자체는 이진 탐색을
   사용하므로 매 마우스 이동이 전체 스캔을 만드는 것은 아니다. 연결 창 표본의
   전체 인덱스 비용은 약 6.9초에 27~94ms였다. 당장 단독 차트 드래그의 주원인으로
   확정하지 않지만 데이터 밀도와 연결 창 수가 커질 때 줄일 수 있는 비용이다.

### 개선 순서

1. 분봉 창 소유의 표시 캔들 인덱스를 tooltip·legend·backfill이 함께 사용한다.
   불변 시간 prefix를 재사용하고 꼬리 가격 변경은 현재 값만 교체한다. prepend,
   실제 시각 교정, venue/정규장/축 변경은 명시적으로 재구축한다.
2. 날짜 경계 spans를 공유하고 가격선이 꺼져 있으면 준비 계산도 생략한다.
   날짜·마감 구간 판정은 불변 segment에서 한 번 계산한다. 공통 시간축 소비자에
   적용하되 초봉·분봉 모두 마감 체결/반일장/날짜 연결 결과를 보존한다.
3. 초봉 source는 저장 원본의 revision을 기준으로 바뀐 1초 bucket만 모델화한다.
   디스크 원본 교체·서버 재기동·캐시 축출은 full reset으로 복구한다. 가격 셀은
   매물대 수요가 있을 때 활성화하되 동일 종목 source 조회 공유를 유지한다.
4. 초봉 매물대 prefix 인덱스는 changed_ms를 받아 수정된 초·가격 레벨부터
   갱신한다. 과거 정정, 가격 범위 확장, 방향별 수량 삭제도 전체 결과와 같아야 한다.

이번 요청은 조사이므로 런타임 소스는 변경하지 않았다. 임시 계측 스펙은 repo에서
제거하고 `/tmp/comprehensive-{audit,linked,pan-trace,native-time}.spec.ts`로 보관했다.
기존 정규장 봉 간격 4개, 실제 초봉 writer 1개, 초봉 선택·과거 날짜/호가 연결
3개와 native Date 측정 1개가 모두 통과했다(9 passed). 초봉 4주기 진단과
연결 창 2조건도 통과했다. 전체 E2E/단위 테스트는 이 조사에서 재실행하지 않았다.
로그는 `/tmp/comprehensive-audit.log`, `/tmp/comprehensive-audit-final.log`,
`/tmp/comprehensive-pan-trace.log`, `/tmp/comprehensive-regression.log`,
`/tmp/comprehensive-second-backend-isolated.log`에 보관했다.

## 후속 구현 — 분봉 인덱스 공유와 초봉 증분 계산

2026-10-01 후속 개선 요청에 따라 다음을 구현했다.

- `drawnCandleIndex`를 축별로 소유하고 tooltip·legend가 같은 표시 캔들 및 시간
  인덱스를 공유한다. OHLC 변경은 최신 캔들 객체를 반영하면서 기존 Map을
  재사용한다. 새 꼬리는 추가 구간만 투영한다. prepend·timestamp 정정·삭제와
  새 axis에서는 안전하게 다시 만든다. 과거 원본 배열의 참조 체인을 보관하지 않는다.
- `resolveSessionSpans`는 정렬된 캔들의 양 끝을 세션별로 이분 탐색한다.
  가격선이 꺼져 있으면 spans 준비도 생략하고, backfill 최초 봉 탐색은 첫
  포함 캔들에서 멈춘다. 세션 판정의 날짜·마감 계산은 segment별 캐시를 사용한다.
  개장/마감 값의 변경을 검사하므로 mutable segment에서도 캐시가 틀리지 않는다.
- 초봉 증분 API는 원본의 값 서명을 먼저 비교한다. 수정된 초만 모델화하며
  5/10/30초 요청에서는 해당 상위 버킷의 원본을 다시 집계한다. 가격 셀도
  수정된 초 단위로 통째로 교체한다. revision 숫자가 같아도 값이 다른 파일
  교체, 중첩 가격 셀의 수정·삭제, 범위 밖 관측 시각 변경을 검출한다.
  source/scope 변경·재기동·캐시 축출은 full reset을 유지한다. 전송 계약은 그대로다.
  원본 병합·서명·관측 시각 계산은 여전히 하루를 스캔하지만 전체 모델 생성과
  전체 Pydantic 응답 비교를 매 갱신마다 실행하지 않는다.
- 초봉 매물대는 창이 소유하는 인덱스에 changed_ms를 적용한다. 마지막 초의
  체결 변경은 마지막 prefix만 고친다. 과거 정정은 해당 가격별 prefix와
  극값 suffix를 고친다. 삭제·범위 확장·여러 초의 삽입/삭제도 전체 계산과 같으며
  누락된 revision·날짜·구간 수 변경은 다시 만든다. cutoff ON/OFF 모두 사용한다.
  원본 배열 간 lineage는 WeakRef로 보관하여 이전 하루 배열을 계속 붙잡지 않는다.

초봉 source의 동일 종목 조회 공유는 유지했다. include_prices 수요에 따라 source
쿼리를 전환하는 작업은 별도 개선으로 남았다. 현재 요청은 기존과 같이 가격 셀을
포함한다. 추가로 기존 측정 요약 스크립트의 Ruff 위반 두 건을 출력 변화 없이
정리했고, 실제 저장된 측정 JSON으로 이전·이후 출력의 완전 일치를 확인했다.

### 구현 후 검증

- 프론트 전체 typecheck, Vitest **599 files / 7,674 tests passed**, Vite build 통과.
- KRX 1/5/10/30초 및 1/3/5/10분의 OFF→ON→OFF 실제 마우스 드래그·커서,
  초봉 호가/매물대 연결 및 native Date 계산 계측: **11 passed**.
  모든 주기에서 논리 봉 간격 1과 barSpacing이 유지됐고 안정된 꼬리 갱신 중
  전체 series.setData 호출은 0회였다. 이 재현은 API mock과 dev/CDP 환경이며
  실제 종목·서버 연결의 FPS를 보장하는 측정은 아니다. 이번 계측 중 추가
  테스트 파일 작성으로 CSS HMR이 발생한 표본도 있어 작은 프레임 차이는
  개선율로 해석하지 않는다.
- native Date에서 7,820봉의 동일 시간격자 가격 갱신 인덱스 준비는 최초 생성
  5.8ms, 이후 0.2~0.6ms였다. 세션 spans는 0~0.2ms였다.
- 초봉/가격 셀 전체 재계산과 증분 재구성의 일치를 서버 1/5/10/30초,
  include_prices ON/OFF, 정규장 ON/OFF, 정정·삭제·source 변경·범위 변경으로
  검증했다. API wire 계약 포함 최종 관련 백엔드 테스트 51개도 통과했다.
  프론트 매물대는 60회의 여러 과거 버킷 정정 및 여러 cutoff에서
  전체 계산과 일치한다. 마지막 초 변경 시 이전 5,000초의 가격 셀 읽기는
  0회이고, 같은 날 커서 60회 이동에서도 기존 셀 읽기는 0회다.

독립 Python 3.14.7 마지막 버킷 변경 5회 중앙값(파일 읽기/라우트 병합 제외):

| 입력 | 이전 전체 모델 생성 + 응답 비교 | 원본 증분 투영 | 반환 봉 / 셀 |
|---|---:|---:|---:|
| 3,000초 / 3,000셀 | 17.82ms | 2.79ms | 1 / 1 |
| 23,401초 / 가격 셀 미포함 | 221.70ms | 31.83ms | 1 / 0 |
| 23,401초 / 23,401셀 | 385.86ms | 45.56ms | 1 / 1 |
| 23,401초 / 140,406셀 | 1,102.95ms | 77.61ms | 1 / 6 |

마지막 행은 약 93% 감소다. 합성 데이터의 서버 계산 비용이며 사용자 드래그
속도가 같은 비율로 개선됐다는 뜻은 아니다. 초기 조회·캐시 reset에는 전체
모델 생성이 필요하고, 오래된 체결 정정에는 매물대 prefix의 뒤쪽 복구가 필요하다.

전체 Ruff는 통과했다. 백엔드 전체 pytest는 **5,277 passed / 4 failed / 2 skipped**.
실패한 `test_every_range_bundle_field_is_classified` 1건(기존 ProgramTradePoint
buy/sell 수량·금액 4필드 분류 누락), `test_today_bootstrap_skips_factors...` 3건
(기존 nullable trade_value_won 기대값 불일치)은 변경 전 HEAD d4be870fa를 별도
archive로 실행해 **동일 4 failed / 28 passed**로 재현했다. 이번 변경의 새 회귀
실패는 아니다. 검증 가드나 기대값을 완화하지 않았다.

전체 Playwright는 **134 passed / 10 failed**. 실패 이름 10개는 이전
`extra-pan-e2e-final.log` 결과와 정확히 같으며 저장 보기·스크리너·관심목록의
기존 실패다. 차트·정규장·초봉 관련 테스트는 통과했다.

임시 계측 스펙은 제거했고 `/tmp/incremental-{performance,linked,native-time}.temp.spec.ts`
및 `/tmp/incremental-*.json` CPU 표본으로 보관했다. 로그는
`/tmp/incremental-chart-{typecheck,vitest,ruff,pytest,e2e}-final.log`,
`/tmp/incremental-chart-browser.log`, `/tmp/incremental-chart-back-target-final.log`,
`/tmp/incremental-chart-build-final.log`, `/tmp/incremental-chart-backend-baseline.log`,
`/tmp/incremental-second-backend-final.log`에 있다. 사용자 5173/8000/8001 서버는
재기동하지 않았다. 이 구현은 작업 브랜치에 있고 main 서버에는 아직 반영되지 않았다.
