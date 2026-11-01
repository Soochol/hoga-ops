# 조건 설정 모달과 사용자 조합식

2026-11-01 사용자 승인안 구현. 작업 브랜치는 `codex/screener-condition-editor`이며
base/head는 `f5f24862fda4952281cd2da85278bdc5907e665f`다. 최종 검증 시
`git fetch origin main`으로 같은 기준임을 확인했다. 이 문서는 미커밋 구현의 검증 기록이다.

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
