# Electron 화면 배율 검증 — 2026-10-26

- 기준 main/구현 시작 HEAD: `b67d8b8ed80de332d287743461c1c85ff4c8bfad`.
- 범위: Electron 업무 창의 단축키·메뉴 배율, 서버별 저장과 복원. 프론트·백엔드 코드 변경 없음.
- 입력: 동봉 `2026-10-26-desktop-zoom-inputs.sha256`의 44개 소스·테스트·스크립트·설정·manifest/lockfile·VERSION.
  입력 목록 자체 SHA-256: `914bffe5cca1c85bc4b7532fdfb0c09a7426650439542ea1822b7598d29d38df`.
  검증 후 문서만 추가하며, PR head에서 입력 지문을 다시 확인해 아래 결과를 연결한다.
- 환경: Linux x64, Node 24.13.1, npm 11.8.0, TypeScript 6.0.2, Playwright 1.64.1, Electron 44.8.0.
- 열린 PR #1927·#1726의 파일 목록 확인: 변경 파일 중복 없음. 최신 origin/main은 위 기준 SHA와 동일.

## 실행 결과

`desktop/`에서 실행:

| 명령 | 결과 |
| --- | --- |
| `npm run typecheck` | 통과 |
| `npm run lint` | 통과 |
| `npm test` | build 및 Node 테스트 19개 통과 |
| `HOGA_DESKTOP_ELECTRON_BINARY=/home/dev/code/hoga-ops/desktop/node_modules/electron/dist/electron HOGA_DESKTOP_TEST_PLATFORM=x11 npm run test:e2e -- tests/e2e/desktop.spec.cjs` | 1 worker, 4개 통과 (4.3초) |

E2E는 임시 userData와 두 GET-only 로컬 fixture 서버를 사용했다. 단축키 확대·축소·복귀,
같은 서버 부모/자식 창 공유, 새 창·reload·재실행 복원, 다른 서버의 기본 100%,
연결 정보 보존, 우클릭 배율 표시/동작과 보기 메뉴 동작을 확인했다.
기존 테스트로 sandbox, 요청 가드, 연결 실패 복구와 이전 프로필 호환도 확인했다.

CDP의 `page.keyboard` 입력은 Electron `before-input-event`를 통과하지 않아 초기 검사가
실패했다. 최종 검사는 `webContents.sendInputEvent`로 실제 Electron 입력 경로를 검사한다.
서버 변경 검사는 연결 창을 띄운 뒤 기존 업무 창의 종료를 기다려 연결한다. 기존 연결
전환의 비동기 창 종료 처리는 이 변경 범위에 포함하지 않는다.

## 실행 경로·적용 범위

사용한 Electron은 기존 고정 경로의 AppArmor 허용 실행 파일이며 sandbox를 유지했다.
실행 파일 SHA-256: `447dc011502a0a5ab4da365d3004646c86aee4eb03aa1643cdf672c7491b64cd`.
`--no-sandbox` 미사용 및 renderer sandbox 활성화를 E2E에서 확인했다.
사용자 연결 설정·기존 업무 창·서버 관리 앱·5173/8000 서버는 검증 대상으로 조작하지 않았다.

머지 후 기본 체크아웃 `/home/dev/code/hoga-ops/desktop`에서 다시 빌드해 기존 실행기가
가리키는 산출물에 반영한다. 바로가기·실행 파일·AppArmor 경로는 바꾸지 않는다.
현재 실행 중인 업무 앱은 메인 코드가 이전 상태이므로 완전 종료 후 기존 바로가기로
재실행해야 적용된다. 격리된 E2E 통과는 일반 데스크톱 바로가기의 재실행 검증을 대신하지
않으며, 사용자 업무 창을 보존하기 위해 그 재실행은 수행하지 않았다. 서버 재시작은 불필요하다.

API 근거: [Electron webContents](https://www.electronjs.org/docs/latest/api/web-contents/).
`setZoomFactor`로 페이지 전체 배율을 적용하고, `before-input-event`에서 단축키 중복 처리를
막는다. 휠 이벤트는 다루지 않아 기존 차트 입력 경로를 유지한다.
