# 최대화 휠 중 임시 스크롤바 재현 및 수정

2026-10-15 KST · 기준 main `c1f2397a4776be2f44b56be89a88dcd7622c2cd2` (#2030)

## 이전 결론의 범위 수정

#2030은 과거 구간의 숫자 `to` 고정으로 인한 봉 중심 오차를 수정했다. 사용자가 다시
제보한 **브라우저 최대화에서 휠을 돌리면 우측 스크롤바가 생기고 마우스를 움직이면
사라지는 현상**은 별도 경로였다. 이전 픽셀 앵커 테스트는 실제 정지 포인터를 차트에
올리지 않아 크로스헤어 보존 레이어가 생성되지 않았으며, 스크롤 높이도 검사하지 않았다.

## 원인

`persistentCrosshair.ts`는 windowed 차트가 시리즈를 교체하는 동안 크로스헤어와 축 라벨을
유지하기 위해 native 상단 캔버스를 복사한다. lightweight-charts 5.2.0은 각 pane 높이를
DPR 단위로 반올림하고 마지막 pane 높이는 올림하므로 전체 캔버스의 끝이 차트 높이보다
소수 픽셀만큼 아래로 내려갈 수 있다.

사용자의 열린 최대화 차트에서 CSS 폭 약 2410.01px, 높이 약 1292.05px, DPR 약 1.35와
native table 높이 약 1292.70px를 관측했다. native widget은 자기 캔버스를 자르지만,
새 보존 레이어는 `position:absolute`이고 native widget은 `position:static`이다. 그 레이어의
containing block은 바깥 `position:relative` 차트 surface다. 복사 레이어의 overflow가
`visible`이면 잘렸던 캔버스 끝이 바깥 `overflow-y:auto`의 스크롤 영역에 다시 포함된다.

레이어가 생길 때만 `scrollHeight`가 1292→1293으로 증가하고 제거되면 원래 높이로
돌아간다. 실제 포인터 이동은 보존 레이어를 즉시 해제하므로 사용자가 제보한 사라짐과
일치한다. 브라우저 스크롤바 표시 방식에 따라 폭 변화가 발생할 수 있으며, headless
검증의 overlay scrollbar에서는 clientWidth 변화 없이 overflow 출현을 확인했다.

## 수정과 대조

크로스헤어 보존 레이어 자체에 `overflow:hidden`을 적용했다. 전체 차트나 pane의 높이,
정상적인 세로 스크롤, 원본 캔버스와 휠 계산은 변경하지 않는다. native에서 이미 잘리던
영역만 같은 경계에서 잘라낸다.

실제 라이브러리와 production 보존 컨트롤러를 사용한 격리 테스트, 실제 `/live` 3분봉에서
5700개 이상 캔들·최대화·정지 포인터·wheel·rewindow를 사용하는 통합 테스트를 추가했다.
scrollHeight와 clientWidth를 보존 레이어의 DOM 삽입/제거 시점에 읽는다.

| 대조 | 클론 없음 | 클론 있음 | 제거 후 |
| --- | ---: | ---: | ---: |
| 수정 전, 격리 viewport h=1292 | 1292 | **1293** | 1292 |
| 수정 후, 같은 viewport | 1292 | **1292** | 1292 |
| 수정 전, 실제 LiveChartRoot h=1292 | 1292 | **1293** | 1292 |
| 수정 후, 같은 LiveChartRoot | 1292 | **1292** | 1292 |

두 새 테스트는 수정 전 코드에서 모두 실패하고 수정 후 통과했다. 최종 수정 후 검증을
마친 뒤 overflow 속성 한 곳만 잠시 제거해 두 테스트가 다시 실패하는 것을 확인했으며,
이후 수정 파일을 정확히 복원했다. 복원한 파일의 SHA-256은 최종 통과 실행과 같다.
높이 1230px인 통합 대조 구간도 스크롤바 없이 유지됐다.

## 검증

- 새 스크롤바 회귀 2개와 기존 크로스헤어 E2E 5개: **7개 통과**.
- persistentCrosshair/windowedChart/LiveChartRoot Vitest: **197개 통과**.
- 전체 TypeScript 검사, 관련 ESLint 오류 검사, production build, diff 검사 통과.
- 기존 mocked 화면의 ResizeObserver loop 경고와 700KB 청크 경고는 남아 있다.
  이 경고를 원인 확인의 근거로 사용하지 않았다.
- 사용자의 브라우저 배치·저장소를 변경하거나 사용자 서버를 재시작하지 않았다.

```bash
cd frontend
npm exec playwright -- test -c ../docs/diagnostics/2026-10-15-maximized-wheel/scrollbar.playwright.config.mts
npm exec vitest -- run src/chart/persistentCrosshair.test.ts src/chart/windowedChart.test.ts src/live/LiveChartRoot.test.tsx
```

수정 전후 측정과 검증 입력은 `scrollbar-verification.json`에 기록한다.
