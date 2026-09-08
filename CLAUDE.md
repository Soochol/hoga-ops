# CLAUDE.md

이 저장소에서 작업하는 에이전트의 공통 지침. 상세 절차는 해당 작업을 할 때 읽는다.

## 작업 맥락

- 코드 탐색 전 [CONTEXT.md](CONTEXT.md)와 관련 [ADR](docs/adr/)을 읽고 도메인 용어를 따른다.
  문서 소비 규칙은 [domain.md](docs/agents/domain.md)에 있다.
- 이슈는 GitHub `Soochol/hoga-ops`에서 `gh` CLI로 관리한다.
  이슈 작성·조회 시 [issue-tracker.md](docs/agents/issue-tracker.md)를 읽는다.
- 이슈 분류·라벨 변경 시 [triage-labels.md](docs/agents/triage-labels.md)를 읽는다.

### ADR 작성

- 새 번호는 기존 ADR과 **열린 PR의 추가 파일을 모두 확인**해 고른다.
  디렉터리의 마지막 번호만 보고 정하면 병행 작업과 충돌한다.
- `tests/unit/test_adr_numbering.py`가 충돌을 보고하면 새 문서 번호와 참조를 바꾼다.
  통과시키려고 충돌 동결 목록을 늘리지 않는다.
- 기존 ADR과 다른 결정을 제안하면 충돌하는 ADR을 명시한다.

## 브라우저·차트 검증

- 페이지 탐색, 클릭, DOM·네트워크·콘솔 조사, 스크린샷은 `/browse` 스킬을 사용한다.
  지속 세션을 유지하기 위한 규칙이며, Playwright MCP 대신 이 경로를 쓴다.
  저장소의 Playwright E2E 테스트 실행은 별개다.
- 스킬과 명령 설명: `~/.claude/skills/gstack/browse/SKILL.md`.
  실행 파일: `~/.claude/skills/gstack/browse/dist/browse`.
- 차트 배율·봉 위치·몸통 두께·초기 화면 문제를 조사할 때는
  [chart-viewport-qa.md](docs/agents/chart-viewport-qa.md)를 읽는다.
- 창 간 크로스헤어·기간·줌 동기화 또는 겹친 창의 입력을 검증할 때는
  [chart-sync-qa.md](docs/agents/chart-sync-qa.md)의 드라이버와 절차를 따른다.
- 차트는 `window.__liveCharts`의 **창 id별 핸들**로 고른다.
  `window.__liveChart`는 마지막 생성 차트라 조사 대상과 다를 수 있다.
- 브라우저별 차이를 확인할 때 기존 창 배치·설정을 보존한다.
  전체 저장소 삭제를 기본 진단 단계로 사용하지 않는다.

## 디자인

- 프론트엔드의 시각·UI 결정 전 [DESIGN.md](DESIGN.md)를 읽는다.
  폰트·색·간격·모서리·모션의 기준이며, 기준 변경은 사용자의 명시적 승인을 따른다.
- 리뷰에서도 토큰 밖의 색·간격·폰트와 승인되지 않은 장식을 확인한다.
- [초기 목업](docs/superpowers/designs/2026-05-20-replay-viewer.html)은 당시 방향을 보여주는
  참고 자료다. 이후 바뀐 폰트·테마·레이아웃은 현재 `DESIGN.md`와 구현을 기준으로 한다.

## 개발 환경과 서버 보호

- 서버가 필요한 작업에서만 기동한다. 먼저 실행 중인 서버의 포트와 체크아웃을 확인한다.
  사용자 개발 서버(5173·8000)와 다른 작업의 프로세스를 종료·재시작하지 않는다.
- 워크트리는 자기 포트·데이터 경로를 사용한다. 새 환경 설치, 서버 기동,
  `.env` 상속 또는 Vite 캐시 문제를 다룰 때
  [local-development.md](docs/agents/local-development.md)를 읽는다.
- **개발·E2E는 무자격이 기본**이다. 실자격증명은 prod에만 둔다.
  `.env`가 없는 워크트리는 메인 체크아웃 것을 상속하므로, 의도하지 않은 상속을 막는다.
- E2E의 `frontend/playwright.config.ts`에 있는 **빈 자격증명 환경변수를 유지**한다.
  새 벤더 자격증명을 추가하면 E2E의 차단 목록에도 추가한다.
- **백엔드는 단일 워커**로 실행한다. 프로세스 내 싱글턴이 WS·스케줄러·DuckDB를
  소유하므로 `--workers`를 추가하면 중복 구독·실행이 생긴다.
- 의존성은 워크트리별로 설치한다. `frontend/node_modules`를 메인 체크아웃에 링크하지 않는다.
- 같은 체크아웃에서 Vite 두 개를 같은 `cacheDir`로 실행하지 않는다.
  현재 캐시 경로는 `frontend/vite.config.ts`의 `cacheDir` 설정으로 확인한다.

## 로컬 검증

CI와 required status checks가 제거되어 **PR 전 검증은 로컬에서 직접 실행**한다.

프론트엔드:

```bash
cd frontend && npm run typecheck && npx vitest run && npx vite build
```

백엔드(저장소 루트):

```bash
uv run --extra dev ruff check . && uv run --extra dev pytest -q -m 'not wallclock'
```

프론트엔드를 변경했다면 Playwright E2E도 실행한다:

```bash
cd frontend && npx playwright test
```

- `typecheck`는 앱·단위 테스트·E2E의 세 TypeScript 프로젝트를 검사한다.
  `tsc -b`만 실행한 결과로 대체하지 않는다.
- Vitest는 `frontend/`에서 실행한다. 저장소 루트에서는 jsdom 설정이 적용되지 않을 수 있다.
- `wallclock` 테스트는 시간·스케줄링 지터에 의존한다. 위 필수 검증에서 제외하며,
  새 테스트는 가능하면 호출 횟수 등 결정적인 조건으로 표현한다.
- Ruff 위반 0건을 유지한다. `ruff format`은 필수 검증에 포함하지 않는다.
- E2E는 `workers: 1`을 유지한다. 포트·데이터 경로 확인, 재실행 정리,
  서버 재사용 오류를 다룰 때 [local-verification.md](docs/agents/local-verification.md)를 읽는다.
- Ruff 설정·`noqa`·검증 가드를 수정할 때도 위 문서의 해당 절을 읽는다.

### 머지 직전

1. 같은 파일을 수정하는 열린 PR을 확인한다.
2. `git fetch origin main`으로 기준을 갱신한다.
3. main이 앞서갔다면 그 변경을 작업 브랜치에 반영하고 합쳐진 코드로 재검증한다.
   fetch만 실행해도 작업 트리에 main의 변경이 반영되는 것은 아니다.
4. 검증한 커밋과 PR head가 같은지 확인하고 머지한다.
   검증 이후 코드나 base가 바뀌었다면 영향받는 검증을 다시 실행한다.

## API 계약

- 백엔드 wire 모델과 `frontend/src/api/`의 TypeScript 미러는 같은 PR에서 갱신한다.
- 라우트·응답 모델·enum·JSONResponse 또는 계약 검사를 변경할 때는
  [api-wire-contract.md](docs/agents/api-wire-contract.md)를 읽고
  `tests/unit/api/test_rest_wire_schema_contract.py`를 함께 확인한다.
- 새 JSON 라우트는 Pydantic 모델로 계약을 선언한다.
  모델 누락으로 응답 필드가 조용히 사라질 수 있으므로 실제 wire 형태를 검증한다.

## 버전

- 릴리스 버전은 루트 [VERSION](VERSION)이 기준이며 변경 내역은 [CHANGELOG.md](CHANGELOG.md)에 기록한다.
- `frontend/package.json`과 `frontend/package-lock.json`의 버전은 `0.0.0`으로 유지한다.
  lockfile의 최상위와 `packages[""]` 모두 해당한다. 릴리스 버전을 이곳에 쓰지 않는다.
- `npm ci` 성공은 위 버전 필드의 일치를 보장하지 않는다.
