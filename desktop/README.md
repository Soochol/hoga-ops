# Ticklane Linux desktop

기존 Hoga 서버의 React 화면을 여는 Electron 클라이언트다. 로컬 서버와 Tailscale 서버를 선택할 수 있다. 앱을 닫아도 서버의 수집·저장·주문 처리는 계속된다.

## 빠른 실행

로컬 개발 환경의 앱 목록·바탕화면 바로가기는 다음으로 등록한다. 기존 연결 설정을 보존하고 별도 관리자 권한은 사용하지 않는다.

```sh
cd /home/dev/.codex/worktrees/7c78/hoga-ops/desktop
npm run install:shortcut
```

이후 앱 목록에서 **Ticklane**을 검색하거나 바탕화면 아이콘을 실행한다. 터미널에서는 어느 폴더에서든 `ticklane`으로 실행할 수 있다. 현재 워크트리의 Electron 실행기를 사용하고 `~/.config/hoga-ops-local-dev`의 연결 설정을 불러온다. 워크트리를 다른 경로로 옮기면 그 위치에서 바로가기를 다시 등록한다. 로컬 화면·API 서버는 기존 방식으로 실행해 두어야 한다. Ubuntu 샌드박스 초기 설정이 필요한 경우 아래 `setup:sandbox`를 먼저 적용한다.

이름 변경 전의 `hoga-ops-local` 명령도 `ticklane`으로 연결한다. 바로가기 재등록 시 기존 Hoga Ops 바로가기를 정리한다. 기본 Electron 저장 경로는 기존 `~/.config/Hoga Ops`를 유지하며, 로컬 바로가기는 계속 `~/.config/hoga-ops-local-dev`를 사용한다. 서버 환경변수와 설정 파일 형식도 유지한다.

저장소의 Node 24 환경에서 실행한다.

```sh
cd desktop
npm ci
npm start
```

Ubuntu의 일반 터미널에서 `SUID sandbox helper ... not configured correctly` 오류가 발생하면 다음 설정을 **최초 한 번** 적용한 뒤 다시 실행한다.

```sh
npm run setup:sandbox
HOGA_DESKTOP_USER_DATA="$HOME/.config/hoga-ops-local-dev" npm start
```

`setup:sandbox`는 현재 워크트리의 Electron 실행 파일에만 user namespace를 허용하는 AppArmor 프로필을 `/etc/apparmor.d/`에 설치하고 로드한다. sudo 비밀번호가 필요하다. 전역 AppArmor 설정이나 `chrome-sandbox` 소유권·SUID 권한을 바꾸지 않으며 Chromium sandbox를 유지한다. 적용 전 내용은 `npm run setup:sandbox -- --print`, 제거는 `npm run setup:sandbox -- --remove`로 확인할 수 있다. 실행 파일의 경로가 달라진 워크트리에서는 다시 설정한다.

Codex처럼 별도의 AppArmor 프로필이 적용된 프로세스에서 실행한 결과와 일반 터미널의 결과는 다를 수 있다. `.deb`는 설치 과정에서 root 소유의 SUID sandbox helper를 제공한다. 관리자 설치로 적용된 권한과 일반 사용자로 임시 추출한 파일의 권한은 서로 다르다.

서버 연결 화면에서 이름과 **화면을 제공하는 서버의 origin**을 입력한다. 예를 들어 로컬은 `http://localhost:8000`, 원격은 기존 `http://<MagicDNS 이름>:8000`이다. URL에 `/live`를 붙이지 않는다. 원격 서버는 먼저 Tailscale로 접근 가능해야 한다. 서버 이름이나 IP를 자동 대체하지 않는다.

마지막으로 연결한 서버는 다음 실행 때 다시 연결한다. 연결이 실패하면 앱 안에서 주소 수정·재시도가 가능하다. 업무 화면 우클릭의 **서버 선택** 또는 **Ctrl+Alt+S**에서도 변경할 수 있다. 상단 네이티브 메뉴 행은 표시하지 않으며 복사·붙여넣기·새로고침 등 기존 단축키는 유지한다. 서버를 바꾸면 기존 작업 창이 닫힌다. 이전 서버에 접수된 주문·수집 작업은 계속되며 새 서버로 요청을 재전송하지 않는다.

## 서버 설정

### 로컬 운영

먼저 기존 방식으로 백엔드를 실행한다. 프론트 빌드와 명시적인 origin 허용이 필요하다.

```sh
# 저장소 루트
cd frontend
npm ci
npm run build
cd ..
HOGA_FRONTEND_DIST="$PWD/frontend/dist" \
HOGA_ALLOWED_ORIGINS=http://localhost:8000 \
uv run --frozen hoga serve
```

이미 실행 중인 서버를 이 명령으로 중복 실행하지 않는다. 기존 서버의 실행 설정에 두 환경변수를 반영한 뒤 필요한 시점에 갱신한다. Electron이 서버를 자동으로 실행·재시작하지는 않는다. `localhost`로 접속하기로 했다면 `127.0.0.1`로 바꿔 쓰지 않는다. 둘은 별도 origin이다.

### 원격 운영

서버는 기존 ADR-0134대로 Tailscale 인터페이스에만 바인딩하고, `HOGA_FRONTEND_DIST`와 자신의 고정 MagicDNS origin을 `HOGA_ALLOWED_ORIGINS`에 설정한다. 공개 또는 LAN 바인딩으로 확대하지 않는다. 서버가 제공하는 `/config.json`은 `{"api_url":""}`여야 한다.

데스크톱용 설정 이전과 엄격한 설정 실패 화면을 사용하려면 이 변경의 프론트 빌드도 서버에 배포해야 한다. 이전 프론트 빌드에서도 Electron의 요청 origin 제한은 적용되지만 최신 설정 UI는 추가되지 않는다.

### Vite 개발

소스 실행에서는 연결 모드를 **개발 Vite**로 선택하고 화면 주소와 API 주소를 각각 입력할 수 있다. `E2E_API_URL`을 지정하면 현재 Vite 설정이 해당 `/config.json`을 제공한다.

```sh
cd frontend
E2E_API_URL=http://localhost:8000 npm run dev -- --host 127.0.0.1
```

실제 실행 포트와 backend origin 허용 목록을 맞춘다. 설치본은 개발 모드를 제공하지 않는다. 개발·검증 서버는 워크트리별 데이터 경로와 무자격 환경을 사용한다.

## 창과 화면 설정

- 앱의 기존 Ctrl/Cmd+클릭 새 탭 동작은 별도 OS 창으로 열린다. 업무 화면 우클릭의 **새 작업 창**에서도 열 수 있다.
- 같은 서버 창끼리는 영속 설정을 공유하고 창별 sessionStorage는 분리한다. 다른 서버·개발 프로필은 별도 영속 세션이다.
- 기본 창의 위치·크기·최대화 상태를 복원한다. 여러 자식 창을 앱 시작 때 모두 자동 재개하지는 않는다.
- Wayland에서는 compositor의 위치·포커스 제약을 따른다. 절대 좌표 복원 동작은 X11과 다를 수 있다. 창 배치가 중요한 환경에서는 X11/XWayland 실행도 검증한다. sandbox를 끄는 실행 옵션은 사용하지 않는다.
- 외부 링크는 우클릭의 **링크를 외부 브라우저로 열기**를 사용한다. 외부 콘텐츠의 자동 팝업은 열지 않는다.
- CSV·PNG 다운로드는 네이티브 저장 대화상자를 사용한다. HTTP 환경의 클립보드 제약에는 기존 다운로드 대체 동작을 사용한다.

Chrome과 Electron은 별도 저장 프로필을 쓴다. 기존 브라우저의 **설정 → 앱 정보 → 화면 설정 내보내기**에서 JSON을 저장하고, Electron의 같은 위치에서 가져온다. 이전 대상은 현재 스키마의 창 배치·지표·차트 선호 설정·그리기·테마다. 선택 종목·핀·주문창 주문 설정과 서버 소유 관심종목·저장뷰·계좌·수집 데이터는 옮기지 않는다. 일회성 전달함·캐시·인증정보도 제외한다.

가져올 때는 다른 작업 창을 닫고 현재 설정 백업을 다운로드해 보관한 다음 적용한다. 표시된 원본과 대상 origin을 확인한다. 파일의 항목에 포함된 키를 덮어쓰며, 파일에 없는 설정은 유지한다. 현재 창의 배치 sessionStorage를 비우고 새로고침해 가져온 배치를 읽는다. 저장 실패 시 원래 localStorage 값을 복원한다. 손상 파일은 쓰기 전에 거부한다.

연결 프로필과 세션 데이터는 Electron의 `userData`에 보관한다. 별도 환경이 필요하면 **절대 경로** `HOGA_DESKTOP_USER_DATA`를 지정한다. 해당 경로만 삭제하면 그 환경의 연결·화면 설정이 사라지므로, 평소 복구는 설정 백업·서버 선택을 먼저 사용한다.

## Linux 배포

```sh
cd desktop
npm run make
```

`out/make/zip/linux/x64/`에 압축 배포본, `out/make/deb/x64/`에 Ubuntu 설치본이 생성된다. deb 빌드에는 `fakeroot`, `dpkg`가 필요하다. ZIP을 풀면 `ticklane` 바이너리를 일반 사용자로 실행한다. `.deb`는 다음과 같이 설치한다.

```sh
sudo apt install ./out/make/deb/x64/ticklane_0.16.6-rev.0_amd64.deb
ticklane
```

파일명은 현재 빌드 버전에 맞춘다. 업데이트는 앱 종료 후 새 ZIP 또는 `.deb`를 수동 설치한다. 같은 `userData`의 프로필·화면 설정은 유지된다. 시스템 패키지 제거는 `sudo apt remove ticklane`으로 하며 홈 디렉터리의 사용자 설정은 자동 삭제하지 않는다. 설치에 관리자 인증이 필요할 수 있다.

루트 `VERSION`의 `A.B.C.D`를 패키징용 `A.B.C-rev.D`로 변환한다. 예를 들어 `0.16.6.0`은 `0.16.6-rev.0`이며 네 번째 자리 증가도 구분된다. 앱 정보에는 원래 네 부분 버전과 소스 커밋을 표시한다. 프론트 패키지 버전은 기존 `0.0.0`을 유지한다.

## 검증

```sh
# 저장소 루트: 실제 앱 통합 테스트의 사전 준비
uv sync --frozen --extra dev
cd frontend
npm ci
npm run build
cd ../desktop
npm ci
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run make
npm run verify:deb
```

Electron E2E는 GUI 세션이 필요하다. `verify:deb`는 시스템 설치 대신 임시 디렉터리에 `.deb`를 풀고 그 안의 실제 바이너리로 E2E를 수행한다. 관리자 설치·메뉴 등록·제거 검증을 대체한다고 주장하지 않는다. 다른 패키지 실행 파일은 `HOGA_DESKTOP_EXECUTABLE=/absolute/path/to/ticklane npm run test:e2e`로 확인할 수 있다.

테스트는 실행별 임시 userData·서버 포트·데이터 디렉터리를 사용한다. 실제 FastAPI와 프론트 빌드로 화면·설정 이전을 확인하며 차트 데이터는 기존 무자격 fixture를 사용한다. 서버 자격증명을 비우고 체크아웃·데이터 경로를 검사한다. 사용자의 5173·8000 서버를 종료하거나 데이터를 변경하지 않는다. 테스트에 `--no-sandbox`를 넣지 않는다.
