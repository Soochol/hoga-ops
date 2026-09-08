# 로컬 검증 환경

E2E 실행·재실행, 서버 재사용 오류, Ruff 설정·`noqa`·검증 가드 변경 때 읽는다.
PR 전 필수 명령과 머지 전 검증 순서는 [CLAUDE.md](../../CLAUDE.md)에 있다.

## Playwright E2E

설정은 [playwright.config.ts](../../frontend/playwright.config.ts), 자원 할당은
[worktreeEnv.ts](../../frontend/tests/e2e/worktreeEnv.ts)가 기준이다.
포트·데이터·dist 경로는 워크트리별로 파생된다. 실행 첫 줄에 출력되며 다음으로도 확인한다.

```bash
cd frontend && npx playwright test --list
```

- `workers: 1`을 유지한다. 캡처 큐·페이크 실패 카운터·디스크 픽스처를 한 백엔드가 공유한다.
- 로컬 실행은 설정의 시스템 Chrome을 사용한다. 브라우저를 임의로 바꿔 실패를 우회하지 않는다.
- `webServer.env`의 빈 벤더 자격증명을 유지한다. 새 자격증명 키도 이 목록에 추가한다.
  자격증명 격리 이유는 [local-development.md](local-development.md)의 해당 절을 참고한다.

### 재실행·슬롯 충돌

1. 출력된 포트와 데이터 경로, 점유 프로세스의 체크아웃을 확인한다.
2. 남은 서버가 **자기 이전 테스트 실행**이면 종료하고 포트가 실제로 비워졌는지 확인한다.
   다른 작업의 프로세스라면 종료하지 말고 기다리거나 별도 E2E 자원을 지정한다.
3. 초기화할 때는 해당 실행이 출력한 테스트 데이터 디렉터리만 정리한다.
   남은 큐 행이 다음 실행의 개수 단언을 바꿀 수 있다.
4. 새 코드로 서버를 다시 기동하고 테스트를 실행한다.

[global-setup.ts](../../frontend/tests/e2e/global-setup.ts)는 `/api/test/whoami`로
체크아웃·데이터 경로·커밋·기동 시점을 대조하고, 맞지 않으면 **테스트 실행을 실패시킨다**.
다른 서버 프로세스를 자동 종료하는 기능은 아니다. 오류 메시지에 나온 소유권·시점부터 확인한다.

## Ruff와 검증 가드

- 규칙·예외·외부 코드 목록은 [ruff.toml](../../ruff.toml)이 기준이다.
  `lint.external`은 검사 대상 밖 코드의 `noqa`와 사유 주석을 RUF100 자동 삭제로부터 보존한다.
  해당 코드에 새 `noqa`를 도입할 때 목록을 함께 확인한다.
- 예외를 다시 던지거나 `logging.exception()` / `exc_info=True`로 기록하는 핸들러에
  불필요한 `noqa: BLE001`을 붙이지 않는다.
- 가드를 변경하면 의도적 불일치로 실패를 확인하고 되돌린 뒤 통과시킨다.
  실패를 없애려고 허용 목록을 넓히기 전에 검사기와 실제 입력 중 어느 쪽이 잘못됐는지 확인한다.
- API wire 가드는 [api-wire-contract.md](api-wire-contract.md)의 등록·직렬화 검증을 따른다.
