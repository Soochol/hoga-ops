# 10호가·호가주문 정보란 전환 검증

- 검증일: 2026-10-30 KST.
- Base / 반영한 main: `1d485b5e15f6c559f109a17024b1c037b3074958`.
- 해당 base 위의 작업 파일을 검증했다. 시고저 행 클릭은 세 값의 가격/등락률을 함께
  전환하고, 정보 페이지 전환은 상단 점 두 개 버튼에만 연결했다. 최저와 KRX종가
  사이에 기존 border 토큰의 1px 구분선을 추가했다.
- 등락률은 사다리 기준가·당일 KRX 종가와 독립적인 전일 KRX 종가를 사용한다.
  창별 메모리 상태를 인라인 정보와 팝오버가 공유한다.

## 검사와 결과

`frontend/`에서 실행:

```sh
npm run typecheck
npx vitest run src/live/workspace/BookPanel.test.tsx src/live/workspace/OrderWindow.test.tsx src/live/workspace/useOrderColumnLayout.test.ts
npx playwright test tests/e2e/live-orders.spec.ts --grep '정보 시고저 함께 전환|시고저 칩·상세 가격|예상 체결가·체결량은 두 창|가격·잔량 호버' --reporter=line
```

- 앱·단위 테스트·E2E TypeScript 검사 통과.
- Vitest 3개 파일 / 295개 통과.
- Playwright 4개 통과. 서버 기동 단계의 Vite production build 통과.
- 두 창에서 라벨/값 클릭·Enter/Space 전환, 점 버튼 전용 페이지 전환, 정보의 다른
  값·제목·빈 영역 클릭 시 페이지 유지, 전환 전후 호가·정보 행 위치 유지를 확인했다.
- 전일 종가 미수신·0·음수·비유한 값, 가격 미수신, 반올림된 보합, 실시간 값 갱신을
  단위 검사했다. 420px 창의 팝오버 전환과 닫기/다시 열기의 표시 방식 유지도 확인했다.
- 두 창의 등락률 표시 스크린샷을 직접 확인했다. 구분선·행 높이·가격 숫자 정렬과
  기존 시고저 및 금액 툴팁을 확인했다.
- `git diff --check` 통과.

실행 환경: Node v24.13.1, npm 11.8.0, TypeScript 6.0.3, Vitest 4.1.7,
Vite 8.0.16, Playwright 1.60.0, Python 3.14.7. 저장소 설정의 시스템 Chrome,
workers=1, 슬롯 291의 전용 포트 20291/21291과 데이터·dist 경로를 사용했다.
빈 벤더 자격증명과 모의 시세·주문을 사용했다. 백엔드 소스·API 계약은 변경하지 않았다.

## 입력 지문

SHA-256: `9e54cc4e25dd97451b62de5e46c821a4e0ae37c1a6e413bddcb63de2f46a3b5d`
(2,354개 경로).

`git ls-files --cached --others --exclude-standard`의 일반 파일 중 `frontend/`, `hoga/`,
`tests/fixtures/` 아래와 루트 `pyproject.toml`, `uv.lock`, `.python-version`, `VERSION`을
정렬했다. 각 `UTF-8 경로 + NUL + SHA-256(파일 바이트)`를 이어 붙여 SHA-256을
계산했다. 이 문서와 DESIGN.md는 실행 입력에서 제외했다. 코드·테스트·환경 등 검사
입력이 달라지면 영향받는 검사를 다시 실행한다.
