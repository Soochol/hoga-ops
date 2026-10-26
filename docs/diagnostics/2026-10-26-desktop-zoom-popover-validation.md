# Electron 중앙 배율 팝오버 검증 — 2026-10-26

- 기준 main/구현 시작 HEAD: `de24f11b1bb70abcd31b66e47828a5ff610956e3`.
- 변경: 배율을 직접 조절한 창에만 현재 비율을 표시한다. 중앙 위치, 테마 표면 35%,
  8px 블러, 1.8초 유지와 150ms 숨김. 포커스·포인터 입력을 가져가지 않는다.
- 프론트·백엔드·주문 API·설정 저장 계약 변경 없음. 새 renderer 권한이나 IPC 호출 API를
  노출하지 않고 기존 sandbox/contextIsolation을 유지한다.
- 입력 지문: 동봉 `2026-10-26-desktop-zoom-popover-inputs.sha256`의 44개 소스·테스트·
  스크립트·설정·manifest/lockfile·VERSION. 목록 SHA-256:
  `be34f74fa71da5ea8fbb8cb630faa2d6fd95e7121bc0fe222166c05bbefcfc27`.
  검증 뒤 문서만 추가하며 PR head에서 지문을 다시 확인해 아래 결과를 연결한다.
- 환경: Linux x64, Node 24.13.1, npm 11.8.0, TypeScript 6.0.2,
  Playwright 1.64.1, Electron 44.8.0. E2E workers=1, x11.
- 최신 origin/main은 위 기준과 동일. 열린 PR #1927·#1726의 파일 목록과 중복 없음.

## 최종 검사

`desktop/`에서 실행했다.

| 명령 | 결과 |
| --- | --- |
| `npm run typecheck` | 통과 |
| `npm run lint` | 통과 |
| `npm test` | build 및 Node 테스트 19개 통과 |
| `HOGA_DESKTOP_ELECTRON_BINARY=/home/dev/code/hoga-ops/desktop/node_modules/electron/dist/electron HOGA_DESKTOP_TEST_PLATFORM=x11 npm run test:e2e -- tests/e2e/desktop.spec.cjs` | 4개 통과, 8.5초 |

확대한 E2E는 실제 `webContents.sendInputEvent` 단축키와 메뉴를 통해 표시·숫자 갱신,
1.8초 타이머 재시작·자동 숨김, 중앙 위치, 테마 색 상속과 35% 배경·블러를 확인한다.
팝오버 아래 중앙 버튼 클릭 및 기존 키보드 포커스 유지도 확인한다. 같은 서버의 다른 창은
배율만 바뀌고, 새 창·reload·복원 시 팝오버가 생기지 않는다. 기존 연결·저장·요청 가드·
sandbox 회귀 검사도 통과했다. 480×360 창의 50%·300%에서 표시와 글자가 화면 안에
들어오고 usable viewport 중앙에 위치하며 reduced-motion에서는 전환이 없는 것을 확인했다.

초기 극단 배율 위치 검사는 `innerWidth`가 포함하는 스크롤바 때문에 중앙 판정이 실패했다.
최종 검사는 고정 레이어의 실제 사용 영역인 `documentElement.clientWidth/clientHeight`를
기준으로 판정한다. 구현의 중앙 정렬을 완화하거나 허용 오차를 늘리지 않았다.

## 설치 및 실행 범위

E2E는 임시 userData와 로컬 GET-only fixture를 사용했다. 실행 파일은 기존 AppArmor 허용
고정 경로이며 SHA-256은 `447dc011502a0a5ab4da365d3004646c86aee4eb03aa1643cdf672c7491b64cd`.
`--no-sandbox`를 사용하지 않았다. 사용자 연결 정보·업무 창·서버 관리 앱·5173/8000 서버는
검증 과정에서 변경하거나 재시작하지 않았다.

머지 후 기본 체크아웃 `/home/dev/code/hoga-ops/desktop`에서 빌드해 기존 실행기의
산출물을 갱신한다. 바로가기·AppArmor·실행 파일 경로는 보존한다. 메인/preload 코드
반영은 업무 앱의 완전 종료와 기존 바로가기 재실행이 필요하다. 사용자 업무 창 보존을 위해
그 재실행은 수행하지 않으므로 일반 데스크톱 실행 검증은 남아 있다. 서버 재시작은 필요 없다.

구현 근거: [Electron preload](https://www.electronjs.org/docs/latest/tutorial/tutorial-preload),
[ipcRenderer](https://www.electronjs.org/docs/latest/api/ipc-renderer).
메인에서 받은 단방향 배율 알림은 isolated preload에서 처리하며 Electron 이벤트 객체를
웹 페이지에 전달하지 않는다.
