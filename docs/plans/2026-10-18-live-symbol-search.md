# 라이브 종목검색 — 승인 시안 구현

2026-10-18 사용자가 승인한 ‘빠른 종목 전환’ 시안을 `/live`의 `/` 검색에 적용했다.

## 변경

- 640px·상단 12vh 비모달 검색 표면, 기존 테마·글꼴·최근 5개 저장 정책을 유지한다.
- 검색어 지우기, 직접 일치한 종목명 강조, 현재 종목 표시, 결과 표시 건수,
  Enter로 열릴 종목명을 추가했다. Escape 안내는 헤더의 닫기 버튼에 있다.
- 최근 검색과 결과에 관심 그룹 하트를 같은 위치로 제공한다. 최근 기록 삭제는
  하트와 분리되며 종목 전환 없이 기록만 지우고 검색 입력으로 포커스를 돌린다.
- 라이브 전용 검색 모델은 종목명·코드·초성·지수 이름/ID를 검색한다. 정확 일치,
  접두사, 부분 일치, 초성 순으로 정렬하며 동률은 이름 길이·원본 순서로 결정한다.
  이름 소문자화·초성 추출은 목록 변경 때만 수행한다. 관심 등록과 최근 기록은
  입력 중 결과 순위에 영향을 주지 않는다. 캡처·히트맵의 공통 검색은 변경하지 않았다.
- 종목/지수 목록 로딩·조회 실패·정상 빈 결과를 구분한다. 실패한 소스만 다시
  조회하며 캐시 결과는 사용할 수 있다. HTTP 200의 `loading` 목록은 검색창이
  열린 동안 다시 조회하고 닫거나 조회에 실패하면 타이머를 정리한다.
- 목록 장애 중 6자리 코드로 직접 여는 기존 경로를 유지한다. 정상 목록에서
  찾지 못한 코드는 Enter로 열지 않는다.
- ADR-0153의 목적지·핀 계약을 유지한다. 전 창 고정 시 검색/관심 편집은 허용하고
  종목 선택만 막는다. 적용되지 않은 선택은 최근 기록에 추가하지 않는다.
- 관심 그룹 팝오버는 Escape를 자체 처리해 부모 검색창과 차트에 전달하지 않고
  하트 앵커로 포커스를 돌려준다. 클릭 영역은 검색의 32px, 터치의 44px에 맞춘다.

## 검증

기준 HEAD와 확인한 origin/main은 모두
`e32054dc40a12f4916f6cc2e9de9bbf8c9734714`다. 아래 검증은 이 기준의 미커밋 변경을
포함한다. API 계약·백엔드 소스·의존성은 변경하지 않았다.

- `npm run typecheck`: 앱·단위·E2E TypeScript 모두 통과.
- 변경한 TypeScript 파일에 `npx eslint ... --max-warnings=0`: 통과.
- `npx vitest run`: 648개 파일, 8,432개 테스트 통과(20:33 KST).
  이후 관심 팝오버 Escape와 로딩 실패 처리를 보완하고 영향을 받는 33개 파일의
  315개 테스트를 재실행해 통과했다(20:36 KST). 나머지 파일은 변경하지 않았다.
- 최종 관련 단위 범위:
  `src/live/LiveSymbolSearch.test.tsx src/live/liveSymbolSearchModel.test.ts
  src/capture/useSymbols.test.tsx src/watchlist src/screener/ResultTable.test.tsx
  src/screener/ScreenerResults.test.tsx`.
- `npx playwright test tests/e2e/live-search-ux.spec.ts
  tests/e2e/watchlist-group-menu.spec.ts --reporter=list`: 최종 15개 통과, 23초.
  검색 12개와 관심 그룹 메뉴 3개를 포함한다. 초성/코드·정렬·키보드·최근 삭제·
  중첩 Escape·실패 재시도·준비 중 자동 재조회·전 창 고정 차단/해제·6개 테마를 확인했다.
- 위 E2E의 서버 준비 단계에서 최종 소스의 Vite 프로덕션 빌드 통과.
- 1280×720 검색 결과와 480×640 긴 최근 종목명 화면의 실제 렌더링을 확인했다.
- `git diff --check`: 통과. 사용자 서버 5173·8000은 변경하지 않았다.

### 추가 진단의 기존 실패

확장 실행에 포함했던 `chart-watchlist-header.spec.ts` 1개는
`titlebar-watchlist-button`을 찾지 못해 실패했다. 기준 HEAD의
`TitleBarSymbolRow.tsx`도 이 버튼을 렌더링하지 않고, 해당 단위 테스트는 버튼이
없어야 한다고 명시한다. 이번 변경과 무관한 오래된 E2E 선택자이므로 수정하지 않았다.
이를 전체 E2E 통과로 보고하지 않는다.

### 환경과 입력 지문

- Node 24.13.1 / npm 11.8.0 / Vitest 4.1.7 / Playwright 1.60.0 /
  시스템 Chrome 155.0.8059.84 / Python 3.14.7.
- E2E는 workers=1, 빈 벤더 자격증명, 전용 포트 20277/21277,
  `/tmp/hoga-e2e-data-277`·`/tmp/hoga-e2e-dist-277`로 실행했다.
- 최종 프론트 입력 1,646개 파일(소스·public·tests·package/lockfile·Vite/Playwright/
  TypeScript/Tailwind 설정·index.html)의 SHA-256:
  `9f6e4f772451e6d7deee81eaa0a212c828fdae0108ac8c72e6dde65056ae5f7b`.
- E2E 백엔드/픽스처/pyproject/uv.lock 276개 파일의 SHA-256:
  `3448c932d587bf753540898685a31bcc52f7afa77769000a0ec814a7d614b061`.
- 지문은 정렬한 상대 경로와 파일 본문을 각각 NUL로 구분해 연결한 SHA-256이다.
  프론트 설정 파일은 소스 디렉터리 뒤에 위 목록 순서로 연결했다.
