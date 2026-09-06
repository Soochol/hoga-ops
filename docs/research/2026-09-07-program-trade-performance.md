# 프로그램 순매수 실시간 갱신 최적화

2026-09-07. 기준: `2c73ca9000f1e3cacab63999cac7b64041814771` (히트맵 PR #1753).

프로그램의 live 꼬리가 바뀔 때 날짜 필터가 새 과거 배열을 만들고, 병합에서 전체를 Map/정렬한 뒤, projector가 전체 배열 참조 변경으로 과거 캐시를 무효화했다. 오늘 값만 바뀌어도 긴 과거 구간을 다시 계산했다.

## 변경

- 캔들의 KST 날짜 집합이 같으면 프로그램 날짜 필터 결과의 배열을 재사용한다. 공용 `tradingDayOf`를 사용해 점마다 날짜 문자열을 만들지 않는다. 저장 배열별 마지막 날짜 집합만 WeakMap에 보관하므로 날짜 조합이 무한히 쌓이지 않는다. 중간 날짜 추가/삭제도 키가 달라진다.
- 저장 이력의 중복 제거·정렬과 최대 시각은 불변 입력 배열별 한 번만 계산한다. 매 갱신에서는 그 최대 시각 뒤의 live 꼬리만 last-wins로 합치고 정렬한다. 저장 데이터의 중복/역순도 기존과 같은 결과다.
- projector는 전체 프로그램 배열 참조 대신 **과거 원소 참조 전체**를 비교한다. 오늘 꼬리만 바뀌면 과거의 버킷 계산·축 투영을 재사용하고, 과거 중간 프로그램 값이나 호가 결손 표시를 교체하면 다시 계산한다. 종목·봉·세그먼트·축 변경도 무효화 조건이다.
- 과거/오늘 사이의 투명 연결선, 같은 버킷의 last-wins, 정규장 마감 동시호가 제외, null 금액 규칙은 그대로다.

참조 비교·날짜 집합 생성·최종 배열 연결은 여전히 O(N)이다. 전체 처리가 O(1)이 되었다고 주장하지 않는다. 정렬/버킷 집계/좌표 계산을 오늘 구간으로 제한하는 것이 핵심이다. 캐시는 기존 API/상태 저장소의 **불변 배열·원소** 계약을 따른다. 과거 정정은 배열/원소 교체로 전달해야 한다.

## 측정

실제 변경 전/후 함수를 동일 프로세스에서 호출했다. 합성 KRX 세션 × 390개 1분봉, 마지막 세션 저장 이음매 뒤 15:10:01에 live 1점을 매번 새로 생성해 갱신한다. 완료된 과거 입력과 axis는 안정적이다. 2회 워밍 후 11회 중앙값(ms), 다른 테스트와 분리해 실행했다.

| 이력 | 봉 수 | 병합+투영 전 | 후 | 날짜 필터 포함 전 | 후 |
|---|---:|---:|---:|---:|---:|
| 5세션 | 1,950 | 0.541 | 0.179 | 1.245 | 0.195 |
| 30세션 | 11,700 | 3.737 | 0.246 | 7.123 | 0.377 |
| 90세션 | 35,100 | 14.182 | 0.654 | 23.913 | 0.981 |

90세션의 날짜 필터 포함 갱신 계산 비용이 약 96% 감소했다. 위 시간에는 HTTP·React 전체 렌더·차트 라이브러리의 `setData`·Canvas 그리기가 포함되지 않는다. 실제 운영 화면의 표시 지연 개선율을 의미하지 않는다.

[원시 결과](2026-09-07-program-trade-performance.json)와 [측정 하네스](2026-09-07-program-trade-benchmark.test.ts.txt)를 보존했다. 재현은 저장소 루트에서 다음처럼 한다.

```sh
git show 2c73ca900:frontend/src/chart/projectors/programTrade.ts > frontend/src/chart/projectors/programTrade.audit-before.ts
git show 2c73ca900:frontend/src/live/programTradeLiveTail.ts > frontend/src/live/programTradeLiveTail.audit-before.ts
cp docs/research/2026-09-07-program-trade-benchmark.test.ts.txt frontend/src/chart/projectors/programTrade.audit.test.ts
cd frontend
node_modules/.bin/vitest run src/chart/projectors/programTrade.audit.test.ts
rm src/chart/projectors/programTrade.audit.test.ts src/chart/projectors/programTrade.audit-before.ts src/live/programTradeLiveTail.audit-before.ts
```

## 회귀 검증

- 필터 → live 병합 → cached projector 전체 경로가 원래 풀 투영과 동일한지 확인한다. live-only 갱신에서 과거 시각의 `classifyAndProject` 호출이 0인지 검사한다.
- 같은 길이의 과거 중간 금액 정정, 호가 결손 표시 정정, 종목/봉/세그먼트/이력 범위 변경, 입력 순서 변경을 검증한다.
- 저장/실시간 중복 시각, 역순 도착, 저장 이음매 갱신, null/잘못된 값, KST 자정과 중간 날짜의 추가/삭제를 검증한다.
- 안정된 저장 이력의 시각 getter가 live-only 병합에서 다시 읽히지 않는지 검사한다. 벽시계 임계값으로 테스트를 만들지 않는다.

실제 Chromium + lightweight-charts에서도 합성 90세션으로 확인했다. 초기 적재 후 `+100,000,000 → -50,000,000 → +250,000,000`으로 live 값을 갱신했고, 세 번 모두 최신 값이 일치하며 과거 시각의 축 투영 호출은 0이었다. 브라우저 콘솔 오류는 없었다. 실제 DOM/Canvas를 사용한 컴포넌트 경로 검증이며 운영 종목의 실시간 세션을 측정한 것은 아니다.

프론트 전체 7,120개(533개 파일), 타입 검사, 프로덕션 빌드, E2E 36개 통과. 측정용 임시 모듈/브라우저 페이지는 제품 소스 트리에서 제거했다.

Ruff 및 백엔드 4,777개 통과(2 skipped, wallclock 13 deselected). 백엔드 제품 코드는 변경하지 않았다.
