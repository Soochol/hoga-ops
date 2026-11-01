# 조건 설정 모달과 사용자 조합식

2026-11-01 사용자 승인안 구현. 작업 브랜치는 `codex/screener-condition-editor`이며
초기 base는 `f5f24862fda4952281cd2da85278bdc5907e665f`다. 아래 초기 검증은
미커밋 구현에 대한 기록이며, 마지막 절에 PR head와 최신 main 통합 검증을 연결한다.

## 구현

- 메인의 전체 파라미터 카드를 문자·이름·요약·설정 진입·드래그·삭제로 정리했다.
  `조건 추가`는 중앙 `조건 설정`의 카탈로그를 열고 조건 행은 `내 조건`을 연다.
- 보조지표 `SettingsEditor`, `SettingsGroup`, `CompactSettings.css`를 공유한다.
  왼쪽에 모드·검색·그룹별 카탈로그/내 조건, 오른쪽에 선택 조건의 기준·입력·요약을 둔다.
  검색 결과는 방향키/Enter로 선택하고 Escape는 검색어 해제 후 창을 닫는다.
- 카탈로그 값은 등록 전 초안이다. `추가`로 새 ID를 만들어 같은 타입을 중복 등록하고
  계속 설정할 수 있다. 닫으면 미등록 초안은 버린다. 기존 조건은 현재 편집 중인
  조건검색에 즉시 반영하며 기존 메인의 명시적 저장을 유지한다.
- `내 조건` 상단에서 AND/OR·문자·괄호를 직접 편집한다. 괄호 묶기/해제와 자동 감싸기를
  없앴다. 문자 빠른 입력은 선택 영역을 대체하고 괄호도 문자 그대로 삽입한다.
  AND/OR 더블클릭 전환, 전체 AND/OR, 실행 취소·다시 실행은 유지한다.
- `reconcileExpression`은 postfix 재출력으로 괄호를 생성하던 처리를 원문 토큰 보존으로
  바꿨다. 순서 변경은 leaf ID 기준 문자만 바꾸며 공백·기존 괄호·연결어 표기는 유지한다.
  삭제는 사라진 항과 연결어를 정리하고 남은 괄호를 보존한다. 추가는 `AND 문자`를
  괄호 없이 붙이므로 기존 AND 우선순위를 적용한다. 오류 식은 파라미터 변경에도 원문을
  유지하며 구조 변경/조회/저장은 기존 검증으로 차단한다. 미지정 식은 전체 AND다.
- 등록된 파라미터 폼은 선택 변경·창 닫기 때 숨기고 마운트를 유지한다. 필드 내부의 빈칸·
  음수 부호·소수점 초안과 숫자 검증 등록이 사라져 저장 제한을 우회하는 문제를 막는다.
  `ModalShell.open`의 기본은 true이며 닫힐 때 Escape 리스너·포커스 트랩을 해제하고
  이전 포커스를 복원한다. 숨긴 폼은 Tab 순환에서 제외한다. 삭제/저장본 복원은 기존대로
  폼과 검증을 초기화한다. 미등록 초안의 검증은 별도 context여서 메인 저장을 막지 않는다.

서버 코드·API 모델·조회 방식은 변경하지 않았다. 최신 main의 순위 5종과 상승/하락
선택을 포함해 기존 카탈로그 전체를 같은 렌더러로 지원한다.

## 검증

- `npm run typecheck`: 앱·단위·E2E 세 프로젝트 최종 통과.
- `npx vitest run`: 757파일·9,710개 통과, 81.96초. 이후 모달 숨김/재개 단위 검사 1개를
  보강하고 import 위치·미사용 CSS·주석만 정리했다. 최종 영향 범위
  `npx vitest run src/screener/ConditionBuilder.test.tsx src/screener/conditionExpression.test.ts src/screener/useSaveAnchor.test.ts src/pages/Screener.test.tsx src/ui/ModalShell.test.tsx`:
  5파일·137개 통과, 4.19초. 나머지 단위 검사 입력/동작은 동일하므로 전체 통과 결과를 재사용한다.
- Playwright 10개 스펙·14시나리오 범위를 실행했다. 볼린저·기간내 등락률·등락률 순위·
  모달 전체 조건·조합식·이평·시장 순위·주가 비교·거래대금 순위·거래량이 대상이다.
  첫 실행은 13개 통과, 1개 실패였다. 실패는 테스트에 창 닫기/다시 열기를 추가하고도
  blur 전 오류가 없다는 옛 기대를 남긴 부분으로, 실제 blur 후 안내가 맞다.
  blur 전 미표시·닫고 열어도 오류/빈칸 유지로 검사를 수정했다.
  최종 `npx playwright test screener-condition-editor.spec.ts screener-expression.spec.ts --reporter=line`:
  4개 통과, 24.8초. 나머지 10개 시나리오는 통과 입력을 재사용한다. 이후 제품 변경은
  미사용 괄호 강조 CSS 제거·import 위치·주석 정리뿐이며 폼/저장/결과 동작은 동일하다.
- E2E 전 production `vite build`와 `prepare-dist.mjs`가 성공했다. 큰 청크와 Browserslist의
  기존 안내는 유지한다. 전체 카탈로그의 기본값·검색·추가 가능 여부를 단위 검사하고,
  브라우저에서는 20개 기존 편집 폼, 주가·이평·거래량·순위의 편집/저장/복원/조회,
  숫자 오류 유지, 수식 오류와 원문 보존, 조건 순서, 실행 취소, 검색 방향키/Enter/Escape,
  포커스 복원, 어두운/밝은 테마와 768px·글꼴 20px의 입력 경계를 확인했다.
  생성된 모달 스크린샷의 넓은/좁은 레이아웃도 직접 검토했다.
- `uv run --extra dev ruff check .`: 위반 0건.
- `uv run --extra dev pytest -q tests/api/test_screener_expression.py`: 34개 통과, 0.56초.
- `git diff --check`: 통과.

환경: Node 24.13.1, npm 11.8.0, uv 0.11.8, CPython 3.14.7,
Chrome 156.0.8078.79, Playwright 단일 워커, 설정의 빈 벤더 자격증명.
워크트리 전용 포트 20016/21016, 데이터 `/tmp/hoga-e2e-data-16`,
production 사본 `/tmp/hoga-e2e-dist-16`을 사용했다. 사용자 5173/8000 서버를 보존했고
종료 후 검증 포트가 비어 있음을 확인했다. 실벤더 데이터 검증은 포함하지 않는다.

최종 지문은 Git 추적/비무시 신규 파일 중 존재하는 파일을 경로순 정렬해
`path + NUL + SHA256(content)의 32바이트 digest`를 연결한 SHA-256이다.
문서는 제품 지문에서 제외한다. 별도 문서 지문은 이 검증 문서 자체를 제외한다.

- frontend 전체 소스·단위/E2E·픽스처·public·package/lockfile·설정, 2092파일: `a4ecce0e55c5a63a34e51d3e02d59cca1f17ffc8898ff5312c51bda9070a554a`
- backend(hoga·tests·pyproject·uv.lock·Ruff/Python 설정), 872파일: `0a25a46f3be87e393d099e06541b0d0a623c23657957580db505728a56eb53ef`
- CONTEXT.md·DESIGN.md, 2파일: `0a524ba02e3cf9779a1fbd1128c101af162832d27ba01b887cc7397f62e81f0c`

## PR·머지 시 최신 main 통합 검증

구현 커밋 `a20933388`에 main `c25c83abc565716e696025f6aab6f80695372484`
(#2366 그리기 도구)를 반영한 입력은 `bccf2e71fb8f183c693aaa4f3cc039b7f1091095`다.
문서 두 곳의 추가는 자동 병합되었고, 제품 소스 충돌은 없다. main의 AppIcon 추가와
차트/그리기 도구 변경을 포함한 상태에서 다음을 재검증했다. 이후 커밋은 이 기록만
보강하며 제품·검사 입력은 동일하다.

- `npm run typecheck`: 앱·단위·E2E 세 프로젝트 통과.
- `npx vitest run src/screener src/pages/Screener.test.tsx src/ui/ModalShell.test.tsx src/chart/drawing src/chart/DrawingDetails.test.tsx src/chart/DrawingPropertyPanel.test.tsx`:
  78파일·1,318개 통과, 21.00초. 초기 전체 프론트 검증 중 이외의 입력은 변경되지 않아
  나머지 통과 결과를 재사용한다.
- `npx playwright test screener-condition-editor.spec.ts screener-expression.spec.ts drawing-advanced.spec.ts --reporter=line`:
  9개 통과, 1.3분. 기존 조건 편집·수식/숫자 오류·드래그·복원과 main이 추가한
  확장/경로/콜아웃/회귀 채널 및 취소 제스처를 함께 확인했다.
  선행 production build와 dist 사본 준비도 성공했다.
- 기존 E2E 중 추가 main의 영향이 없는 10개 조건 가족 시나리오 통과 기록을 재사용한다.
  backend 코드·테스트·의존성·설정 지문이 초기 검증과 같아 Ruff·조합식 API 34개 결과도
  재사용한다. API 계약과 벤더 조회 흐름은 이번 PR에서 바꾸지 않았다.
- 포트 20016/21016, 새 데이터 `/tmp/hoga-e2e-data-16-condition-editor-pr`,
  새 dist `/tmp/hoga-e2e-dist-16-condition-editor-pr`을 사용했다. 도구 버전·빈 자격증명·
  Chrome 단일 워커는 초기 검증과 같다.
- 열린 PR #2367이 볼륨 E2E와 공통 문서에도 변경을 제안한 것을 확인했다. 이 검증의
  main 기준에는 아직 포함되지 않으며, 머지 직전 main을 다시 대조한다.

최신 main 통합 입력 지문(위와 같은 산식):

- frontend, 2098파일: `43800e4e7b0c45a65adef1276f67fac3d2d4313f03b7b84d2a65757eab0ce687`
- backend, 872파일: `0a25a46f3be87e393d099e06541b0d0a623c23657957580db505728a56eb53ef`
