# 거래량 색상 기준 검증 (2026-10-29)

## 변경

- 거래량 보조지표별 `volumeColorMode`: `candle`(기본) / `previous-volume`.
- 직전 봉보다 많을 때만 양봉 색상, 동일·감소는 음봉 색상. 첫 관측은 캔들 방향.
- 초·분·D/W/M에서 공용 투영기를 사용하며, 화면 밖 직전 봉과 과거/당일 캐시 경계를 유지한다.
- 반복 지표·창·봉 프로필의 저장/복원과 기존 편집기 되돌리기·프리셋 경로를 사용한다.
- 기본 거래량의 캔들 겹쳐 표시도 같은 설정을 읽는다. 반전·색상·투명도는 기존 표시 규칙을 따른다.
- 반복 지표 복원 시 기존 `volumeOverlayUpColor` / `volumeOverlayDownColor` 문자열이
  누락되는 문제를 함께 수정했다. 빈 문자열 또는 6자리 hex만 보존한다.

## 기준과 입력

- 작업 base 및 확인한 origin/main: `e8a778ac77795c7d171d01820f225f037bcf0fac`.
- 검증 대상은 이 base 위의 거래량 색상 기준 변경분이다. 운영 서버·Electron 설치는 변경하지 않았다.
- Node v24.13.1, npm 11.8.0, TypeScript 6.0.3, Vitest 4.1.7, Playwright 1.60.0, Vite 8.0.16.
- E2E는 저장소 설정의 시스템 Chrome, 단일 워커, 빈 벤더 자격증명을 사용했다.
  백엔드 20236 / 프론트 21236 / 데이터 `/tmp/hoga-e2e-data-236`.
- 입력 지문은 아래 범위의 추적 파일 경로와 현재 바이트를 정렬해 SHA-256으로 계산했다.
  이 검증 기록 자체는 지문에서 제외했다.

## 검증 결과

- `npm run typecheck`: 앱·단위·E2E TypeScript 검사 통과.
- `npx vite build --logLevel error`: 빌드 통과.
- `npx vitest run src/chart/projectors/volume.test.ts src/live/indicators/VolumeConfig.test.tsx src/state/indicatorSettingsV2.test.ts src/state/liveIndicatorsPersistence.test.ts src/live/indicators/IndicatorPanel.instances.test.tsx`: 143개 통과.
- 저장 색상 보존 검증 추가 후 `npx vitest run src/state/indicatorSettingsV2.test.ts`: 38개 통과.
- `npx playwright test indicator-instances.spec.ts --grep 'volume color mode' --reporter=list`: 2개 통과.
  두 테마에서 캔들/거래량 비교 색상, 동일 거래량의 음봉 처리, 실제 시리즈 데이터,
  편집기 되돌리기, 반복 지표 독립성, 새로고침, 겹쳐 표시를 확인했다.
  1440px·390px 화면을 캡처하고 밝은 넓은 화면·어두운 좁은 화면을 시각 확인했다.
- `git diff --check`: 통과.

## 전체 단위검사의 별도 관측

최초 전체 실행은 9,266개 중 9,264개 통과·2개 실패였다. 이를 전체 통과로 기록하지 않는다.

1. `IndicatorPanel.instances.test.tsx`의 거래량 복원 실패는 변경 전 HEAD를 별도 임시
   디렉터리에 추출하고 별도 `npm ci`로 실행해 동일 재현했다. 위 hex 보존 수정으로 해결했고
   해당 파일의 46개를 포함한 관련 검사 143개가 통과했다.
2. `LiveChartRoot.test.tsx`의 `holds an empty-candle chart until the hoga path also settles`는
   병렬 전체 실행에서 opacity 기대값이 달랐다. 해당 파일과 반복 지표 파일의 단독 재실행에서
   차트 파일은 통과했고, 변경 전 HEAD의 같은 실행에서도 차트 파일은 통과했다.
   이 테스트나 reveal 코드는 수정하지 않았다. 최초 전체 실행의 이 실패는 남은 관측 사항이다.

전체 실행 후 변경 영향 범위의 검사를 재실행했으며 전체 9,266개를 다시 반복하지는 않았다.

## 입력 지문

`c3b54e85632d7efad7a7e8f8581499dac227bfd030a0ccb2e78504a45c3911b0` (2814개 파일)

`git ls-files frontend hoga tests pyproject.toml uv.lock .python-version ruff.toml`의
각 파일을 경로 순으로 정렬해 `경로 UTF-8 + NUL + 내용 바이트 + NUL`을 연결하여
SHA-256으로 계산했다. frontend의 전체 소스·테스트·픽스처·설정·package/lockfile과
E2E 백엔드의 추적 소스·테스트·설정·의존성을 포함한다. 생성물·node_modules·.venv·
이 검증 기록과 도메인/디자인 문서는 실행 입력에서 제외했다.

## PR·머지 단계의 결과 재사용

2026-10-29 PR 생성 전에 `git fetch origin main`으로 다시 확인한 기준은 위 SHA와
동일했다. 실행 입력 2,814개의 지문도 위 값과 일치한다. 구현 이후 소스·의존성·검증
설정·실행 환경이 바뀌지 않아 위 통과 결과를 재사용한다. 검증 기록의 문구 갱신은
실행 입력에 포함되지 않는다. PR head SHA는 PR 본문에 연결한다. 전체 실행에서
관측한 실패를 전체 통과로 재해석하지 않으며, 변경 영향 범위의 통과 결과만 재사용한다.
