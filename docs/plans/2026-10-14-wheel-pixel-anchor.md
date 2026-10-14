# 분봉 휠 줌의 픽셀 앵커 안정화

## 조사 및 계획 검토

- 기존 `computeWheelOutcome`는 `to - from`을 확대하고 논리 인덱스 비율을 보존한다. lightweight-charts 5.2는 양 끝 봉을 포함한 `to - from + 1`로 간격을 계산하며, 봉 중심 좌표에는 `0.5`봉을 더한다. 현재 수식은 최신 캔들의 픽셀 위치를 고정하지 못한다.
- 실제 라이브러리와 production 휠 훅을 사용한 우측 빈 영역 재현에서 반복 줌의 캔들 이동은 약 0.06–14.11px였다. 봉 개수·중심을 반영한 비교 실험에서는 오차가 1e-9px 미만이었다. 근거: `docs/diagnostics/2026-10-14-wheel-axis/measurements.json`.
- Ctrl/Cmd 분기도 같은 오차를 가진다. 추가로 `coordinateToLogical`은 정수 봉으로 반올림하므로, 커서 위치를 고정하려면 현재 입력용 range와 차트 폭에서 연속 논리 좌표를 계산해야 한다. pending draw 중에도 `readChartInteractionViewport`가 제공하는 range를 사용한다.
- 줌아웃 한계뿐 아니라 줌인 한계도 미리 적용해야 한다. 라이브러리가 간격만 제한한 후 요청의 오른쪽 끝을 적용하면 줌이 팬으로 바뀐다. `maxBarSpacing`의 기본값은 차트 폭의 절반이다.
- 강한 줌의 실제 E2E에서 추가로 확인: native `rightOffset`은 최소 두 데이터 포인트를 남기도록 제한된다. 일반 휠에서도 우측 여백 비율에 따라 두 봉 간격 한계 전에 이 벽에 도달한다. Ctrl 휠이 빈 영역을 고정하면 더 일찍 도달한다. 마지막 캔들 위치와 앵커의 화면 비율에서 이 보정이 시작되는 최소 count를 구해, 같은 픽셀 앵커를 유지한 채 확대를 멈춘다. 다른 pane이 더 오른쪽의 포인트를 제공하는 경우 마지막 캔들은 보수적인 경계다.
- 가격축 폭 유지 기능은 실제 라이브러리에서 정상 동작했고, 사용자 화면의 축 폭은 68px로 유지됐다. 축 폭·폰트·레이아웃 변경은 이번 구현에 포함하지 않는다. 축 라벨 전체의 별도 이동이 재현되면 추가 조사한다.

## 유지할 계약

1. 일반 휠: 최신 캔들이 오른쪽 끝 이내에 있으면 그 봉 중심의 픽셀 위치를 고정한다. 과거 구간에서는 기존 `range.to` 고정 정책을 유지한다.
2. Ctrl/Cmd 휠: 커서의 연속 논리 좌표를 고정한다. 우측 빈 영역에서도 같은 원리가 적용된다. Shift가 함께 눌리면 팬이 우선한다.
3. Shift 휠: span과 우측 벽 정책을 그대로 유지한다. Alt 휠은 workarea에 전달한다.
4. 확대·축소 한계에서는 팬이나 불필요한 viewport 알림을 발생시키지 않는다.
5. 렌더 윈도우·과거 데이터 prepend·Virtual Axis 재생성 중에도 입력 range의 좌표 세대를 유지한다.

ADR-0045의 픽셀 앵커 불변식을 더 정확히 구현하며, ADR-0104의 백필 예산·좌측 무클램프 정책을 유지한다. 새로운 ADR 결정은 필요하지 않다.

### Invariant impact

| 불변량 | 영향 |
| --- | --- |
| 최신 캔들의 픽셀 위치 | 보존: 논리 span 비율을 inclusive count·봉 중심 좌표로 교체 |
| Ctrl/Cmd 커서의 픽셀 위치 | 보존: 정수 봉 스냅을 연속 좌표로 교체 |
| 과거 구간의 오른쪽 논리 끝 | 보존 |
| Shift span·우측 벽 및 Alt 스크롤 | 보존 |
| native 최소 데이터 노출 | 보존: 우측 빈 영역 줌은 팬으로 변하지 않고 일찍 멈춤 |
| 백필 예산·렌더 윈도우 좌표 세대 | 보존 |
| 축 폭·폰트·색·차트 창 배치 | 변경 없음 |

## 구현

1. `WheelInput`에 차트 폭과 줌인 최소 span을 추가한다. 훅은 이벤트 시점의 폭·`minBarSpacing`·`maxBarSpacing`으로 양쪽 한계를 전달한다.
2. 확대 대상은 봉 개수 `count = span + 1`이다. 제한된 새 count와 원래 count의 비율을 먼저 계산한다.
3. 봉 중심 앵커 `a`의 경우 `newTo = a - 0.5 + (to - a + 0.5) * ratio`, `newFrom = newTo - newCount + 1`로 계산한다. 과거 구간 또는 앵커 없는 fallback에서는 `newTo = to`를 유지한다.
4. Ctrl/Cmd 앵커는 `a = to + 0.5 - (width - 1 - mouseX) * count / width`로 계산한다. 폭을 제공하지 않는 순수 함수 호출은 기존 callback을 fallback으로 사용한다.
5. 휠 결과가 현재 range와 같으면 차트 쓰기·사용자 viewport 변경 알림을 생략한다.
6. native 우측 데이터 경계를 위한 최소 count도 합성한다. `p = (anchor - from + 0.5) / count`, `minCount = (anchor - lastBarIndex + min(2, lastBarIndex + 1) - 0.5) / p`. 오른쪽 끝을 따로 자르지 않고 최소 count를 적용하므로 앵커를 보존한다.

## 검증 및 완료 기준

- 순수 함수: 봉 중심 픽셀 위치, 연속 커서 위치, 양쪽 줌 한계, 과거 오른쪽 끝, Shift·Alt 정책, 0 span의 단일 봉을 검증한다. 기존 논리 비율 단언은 실제 렌더 좌표 단언으로 교체한다.
- 훅: 폭과 설정한 최대 간격의 한계 배선, 이벤트 단위 변환, overlay 버블링, 한계에서 no-op을 검증한다.
- 실제 라이브러리 E2E: native/windowed 양쪽에서 최신 캔들·우측 빈 영역 Ctrl 앵커·강한 확대·한 프레임 내 연속 입력·줌 한계 반복 입력을 측정한다. 고정할 앵커의 이동 허용치는 0.01px다.
- 기존 wheel viewport/prepend 및 실제 LiveChartRoot 백필 통합 E2E를 실행한다. 커서에서 벗어난 봉은 줌에 따라 움직이는 것이 정상이라, 커서와 선택 봉의 거리가 확대 비율에 따라 변하는지 검사한다.
- 관련 Vitest, 전체 타입 검사, lint, production 빌드를 수행한다. 사용자 서버(5173·8000)를 재시작하지 않고 워크트리 포트에서 검증한다.

## 상태

구현 및 검증 완료. `codex/fix-wheel-pixel-anchor` 워크트리 브랜치에 반영했다. 아래 검증을 완료한 시점에는 사용자 서버 `localhost:5173`이 별도 main 체크아웃을 제공했고, 변경은 아직 머지·pull 전이었다.

### 최종 검증 (2026-10-14 KST)

- 최신 main `9e729844b20d9a9be09cfb0301f4aa546ef0ec52`로 갱신했다. 창 리사이즈 변경을 포함한 최종 코드에서 관련 Vitest 6개 파일, **253개 테스트**가 통과했다.
- 실제 라이브러리 E2E **52개 테스트**가 통과했다. 빈 영역 앵커 16개 조합(native/windowed × 일반/Ctrl × 4배율)의 최대 픽셀 이동은 **1.03e-10px**였다. 가격축 폭도 유지됐고, 두 줌 한계에서 추가 viewport 알림이 발생하지 않았다.
- `npm run typecheck`, `npm exec eslint -- . --quiet`, `npm run build`, `git diff --check` 통과. build의 700KB 초과 청크 경고 및 mocked 전체 화면 백필 테스트의 ResizeObserver loop 경고는 남아 있다.
- 실계정·백엔드를 사용하지 않았고 사용자 서버를 재시작하지 않았다. 진단 입력은 synthetic 캔들과 mocked HTTP다. 축 라벨 전체의 별도 흔들림은 독립적으로 재현·수정한 것으로 주장하지 않는다.
- 명령, 런타임 버전, base SHA, 입력 지문 및 픽셀 측정값은 [verification.json](../diagnostics/2026-10-14-wheel-axis/verification.json)에 기록했다.

워크트리 `frontend/`에서 브라우저 검증을 재현한다. 설정은 저장소의 워크트리 포트를 사용하며 다른 서버를 재사용하지 않는다.

```bash
npm exec playwright -- test --config ../docs/diagnostics/2026-10-14-wheel-axis/playwright.config.mts
```

관련 Vitest:

```bash
npm exec vitest -- run src/util/wheelInteractions.test.ts src/live/useWheelInteractions.test.tsx src/live/LiveChartRoot.test.tsx src/chart/windowedChart.test.ts src/live/workspace/WorkspaceCanvas.resize.test.tsx src/workspace/WorkspaceCanvas.test.tsx
```
