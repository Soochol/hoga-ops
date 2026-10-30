# 10호가·호가주문 예상 체결/VI 자리 전환 검증

- 검증일: 2026-10-30 KST.
- 반영한 main: `878e81d75905c8b40101c57654f3dda1c171bca5` 위의 작업 소스.
- 예상 체결가·체결량 두 행을 클릭하면 같은 자리에서 상승VI·하강VI로 함께 전환한다.
  VI 행을 누르면 예상 체결 표시로 복귀한다. 정보 2페이지는 상·하한가만 표시한다.
- 선택은 창별이며 인라인 정보와 팝오버가 공유한다. 기존 VI 계산과 발동 표시는 유지한다.

## 검사와 결과

`frontend/`에서 실행:

```sh
npm run typecheck
npx vitest run src/live/workspace/BookPanel.test.tsx src/live/workspace/OrderWindow.test.tsx src/live/workspace/useOrderColumnLayout.test.ts
npx playwright test tests/e2e/live-orders.spec.ts --grep '예상 체결·VI 가격|정보 시고저 함께 전환|예상 체결가·체결량은 두 창|넓은 창은 상세 정보|공통 수량·환산 금액' --reporter=line
```

- 앱·단위 테스트·E2E 타입 검사 통과.
- Vitest 3개 파일 / 299개 통과.
- Playwright 5개 통과. 서버 기동 단계의 Vite production build 통과.
- 양쪽 행·가격 값 클릭, Enter/Space, 미수신 상태 전환, 시세 갱신, VI 예상가·발동·해제,
  페이지 전환 및 팝오버 재개방 후 선택 유지, 시고저 전환과의 독립성을 확인했다.
- 실제 브라우저에서 예상 체결/VI 두 행의 경계 상자와 호가·정보 행 위치가 전환 전후
  동일함을 확인했다. 420px 팝오버와 360~800px 주문창 반응형 검사도 통과했다.
- 두 창의 VI 표시 스크린샷을 확인했다. 첫 행 구분선과 기존 VI 색상·텍스트를 유지한다.
- `git diff --check` 통과.

Node v24.13.1, npm 11.8.0, TypeScript 6.0.3, Vitest 4.1.7, Vite 8.0.16,
Playwright 1.60.0, Python 3.14.7, 저장소 설정의 시스템 Chrome을 사용했다.
workers=1과 빈 벤더 자격증명, 슬롯 291의 전용 포트 20291/21291·데이터·dist를 유지했다.
백엔드·API 계약은 변경하지 않았다.

## 입력 지문

2,358개 경로의 SHA-256:
`30b7eed76a9f99c1ad94f3902d6a78c3f154664b73df3cd737a7b78de7cfa549`.

`git ls-files --cached --others --exclude-standard`의 일반 파일 중 `frontend/`, `hoga/`,
`tests/fixtures/` 아래 및 루트 `pyproject.toml`, `uv.lock`, `.python-version`, `VERSION`을
정렬했다. 각 `UTF-8 경로 + NUL + SHA-256(파일 바이트)`를 이어 붙여 해시를 계산했다.
진단 문서·DESIGN.md는 검사 입력에서 제외했다. 커밋/PR의 검사 입력이 이 값과 같을 때만
이 결과를 재사용하고, 코드·환경 등이 달라지면 영향받는 검사를 다시 실행한다.
