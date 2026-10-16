# Electron 프론트엔드 도입 계획

작성일: 2026-10-16 KST

상태: Linux 구현 및 자동 검증 완료, 운영 환경 수동 검증 대기

검토 기준: `c6d80a5c9`

기존 React 화면을 서버 URL에서 불러오는 Electron 앱을 추가한다. 같은 앱에서 로컬 서버와 별도 PC의 Tailscale 서버를 선택할 수 있게 하며, 수집·저장·주문 처리는 지금처럼 접속한 Python 서버가 담당한다. 첫 배포 목표는 기존 기능을 데스크톱 창에서 안정적으로 사용하는 것이다.

## 범위와 선택한 방식

| 항목 | 첫 배포 범위 |
| --- | --- |
| 운영 화면 | 서버가 제공하는 기존 React 빌드를 로드 |
| 로컬 연결 | `http://localhost:8000`을 기본 제안하고 저장된 주소로 접속 |
| 원격 연결 | 현재 사용하는 Tailscale MagicDNS origin으로 접속 |
| 개발 연결 | 개발 전용 프로필로 Vite origin과 API origin을 각각 명시 |
| 창 | 기본 창, 기존 새 탭 동작에 대응하는 별도 OS 창, 위치·크기 복원 |
| 저장 상태 | Electron 전용 영속 세션, 브라우저 설정 이전 기능 |
| 배포 | 별도 `desktop/` 패키지, Electron Forge로 패키징 |
| 우선 플랫폼 | Linux, 현재 검증 환경인 Ubuntu 26.04 x86_64를 첫 기준으로 사용 |
| 서버 운영 | 기존 실행 명령·systemd·워치독을 계속 사용 |

Python 실행·동봉·자동 재시작, API 프록시, 새로운 인증 체계, 앱 내부 차트 창의 개별 OS 창 분리, 트레이 상주·자동 실행·전역 단축키·푸시 알림·자동 업데이트는 후속 범위로 둔다. 로컬 백엔드는 사용자가 기존 방식으로 먼저 실행한다. 마지막 Electron 창을 닫으면 앱은 종료하고 서버는 계속 동작한다.

사용자 선택에 따라 Linux를 우선 지원한다. 현재 검증 호스트는 Ubuntu 26.04.1 LTS x86_64이며, 이를 첫 빌드·설치 검증 기준으로 제안한다. 실제 사용 PC의 배포판·CPU 아키텍처·디스플레이 세션을 확인해 검증 대상을 조정한다. 다른 Linux 배포판·ARM64·Windows·macOS 배포는 후속으로 두고 공통 코드는 플랫폼 확장을 고려해 작성한다.

## 현재 코드와의 연결

| 현재 구성 | 적용 방법 |
| --- | --- |
| `hoga/api/frontend_static.py`의 정적 파일·SPA fallback·`/config.json` | 서버 URL을 그대로 로드하고 `api_url: ""`로 같은 origin을 사용 |
| `frontend/src/main.tsx`의 `BrowserRouter` | `/live`, `/live?code=`, `/live?view=` 경로 유지 |
| `frontend/src/config.ts`의 HTTP·WS URL 해석 | 정상 경로는 재사용하고 데스크톱의 설정 실패 처리는 보완 |
| `frontend/src/live/openWorkspaceInNewTab.ts` | `window.open`을 Electron main에서 받아 OS 창으로 연결 |
| `frontend/src/state/workspaceTransfer.ts` | 전달 쿼리와 일회성 localStorage 전달함 유지 |
| `frontend/src/state/workspace.ts`의 탭별 배치 | 같은 origin의 저장소 공유와 창별 sessionStorage 격리 유지 |
| `frontend/src/state/persistencePolicy.ts` | 설정 이전 대상과 창 사이 동기화 검토 기준으로 사용 |
| `hoga/api/origin_guard.py` | CORS·WS·상태변경 요청의 명시적 origin 허용 정책 유지 |
| 루트 `VERSION` | 앱 배포 버전의 기준으로 사용 |

ADR-0134의 Tailscale 접근 경계, 고정 origin, 서버의 프론트 직접 서빙을 유지한다. 원격 주소를 LAN IP나 다른 별칭으로 자동 대체하지 않는다. 로컬 URL과 원격 URL은 서로 다른 화면 설정을 가진다. 기존 Chrome과 Electron 역시 별도 프로필이므로 저장 상태를 자동 공유하지 않는다.

로컬 운영 주소 `http://localhost:8000`은 현재 dev 기본 허용 목록의 `:5173`·`:5174`와 다르다. 로컬 서버에서 프론트도 제공할 때는 `HOGA_FRONTEND_DIST`와 함께 **실제 접속 origin을 `HOGA_ALLOWED_ORIGINS`에 명시**해야 한다. `localhost`와 `127.0.0.1`은 서로 다른 origin이므로 자동 치환하지 않는다.

## 앱 구조와 연결 프로필

```text
Electron main
  ├─ 로컬 연결 설정 화면과 제한된 설정 IPC
  ├─ 연결 프로필·영속 세션·창 관리
  └─ 서버 화면 BrowserWindow
       └─ 기존 React → 같은 서버의 REST·WebSocket
```

연결 설정·접속 실패 화면은 앱에 포함해 서버가 꺼져 있어도 표시한다. 기존 차트와 업무 화면은 서버에서 제공한다. 앱 네이티브 메뉴에서 서버 선택 화면을 열 수 있게 해 원격 화면이 실패해도 주소를 수정할 수 있게 한다. 로컬 화면은 `app://desktop` 같은 전용 프로토콜로 제공하며 경로를 패키지 내부 파일에 제한한다.

프로필은 `id`, 표시 이름, 모드(`server` 또는 `development`), 정규화한 화면 origin, 개발 모드의 명시적 API origin을 저장한다. URL은 `URL`로 해석하고 경로·query·fragment·사용자명·비밀번호가 있는 입력은 저장 전에 정리 또는 거부한다. 운영 시작 경로는 `/live`로 고정하고 새 창의 딥링크는 별도로 보존한다. 쿠키·벤더 키·토큰을 프로필에 넣지 않는다.

설정은 Electron `userData` 아래에 스키마 버전과 함께 원자적으로 저장한다. 손상 시 원본을 보존하고 서버 선택 화면으로 복구한다. 운영 세션은 canonical origin에서 파생한 고정 `persist:` partition을 사용한다. 같은 origin의 창들은 같은 partition을 쓰고, 다른 서버 및 개발 프로필은 분리한다. 프로필 이름을 바꿔도 저장소 경로가 바뀌지 않게 한다.

첫 배포는 한 앱 인스턴스에 하나의 활성 서버를 둔다. 다른 서버로 바꿀 때 기존 업무 창을 정리한 다음 새 origin으로 이동한다. 이전 서버로 보낸 요청을 새 서버로 전달하거나 재시도하지 않는다. 연결 전환은 기존 서버에 이미 접수된 주문이나 수집 작업을 취소하지 않는다. 프로필 변경은 사용자가 적용할 때만 일어나며, 이전 실패 응답이 새 프로필 화면을 덮지 않도록 연결 시도별 식별자를 둔다. 창 제목에 서버 이름을 표시한다.

## 연결과 장애 처리

1. 앱 실행 시 저장한 프로필로 연결하고, 설정이 없으면 서버 선택 화면을 연다.
2. 제한 시간과 취소 처리가 있는 GET으로 `/health`와 `/config.json`을 확인한다. health 응답의 필수 필드, JSON 설정, 허용 API origin을 검사한다. 운영 모드는 `api_url: ""`만 허용하고 개발 모드는 지정한 API origin만 허용한다.
3. 서버는 응답하지만 화면이 없는 경우를 구분한다. `/live`의 문서 응답과 실제 페이지 로드도 확인해 `HOGA_FRONTEND_DIST` 누락을 안내한다. `/health`의 200만으로 화면 사용 가능 또는 수집 정상으로 판정하지 않는다.
4. `/health?deep=1`의 기능 이상은 진단 정보로 표시하고 화면 접근 자체를 막지 않는다. 일시적인 수집 이상 때문에 설정·복구 화면에 접근할 수 없어서는 안 된다.
5. 최초 문서 로드 실패는 앱 내부 실패 화면에서 재시도·주소 수정을 제공한다. subframe 실패나 탐색 취소를 전체 접속 실패로 처리하지 않는다.
6. 로드 이후 REST·WS 끊김은 기존 앱의 연결 상태·재연결 정책을 우선 사용한다. heartbeat 실패마다 업무 창을 reload하지 않는다. 절전 복귀 시 기존 WS 재연결과 데이터 신선도 표시가 회복되는지 확인한다.
7. 자동 재접속은 GET 진단과 연결 재시도만 수행한다. 주문·정정·취소 등 상태변경 요청을 Electron 계층에서 재전송하지 않는다.

현재 `loadConfig()`는 `/config.json` 실패 시 `http://localhost:8000`으로 폴백한다. 원격 서버를 선택한 Electron에서 이 동작이 발생하면 다른 서버에 요청할 수 있으므로 **데스크톱 모드는 설정 실패 시 요청을 중단**해야 한다. 최소 preload에서 권한 없는 읽기 전용 데스크톱 표시값만 제공하고, 프론트의 설정 로더가 명시적인 엄격 모드를 선택하도록 한다. 원격 페이지에는 IPC·Node·파일·shell API를 제공하지 않는다.

엄격 모드에서는 설정 로딩 실패·잘못된 API origin을 사용자에게 표시하고 재시도로 복구한다. `api/client.ts`의 설정 promise 캐시와 `AppInfoSections.tsx`의 별도 설정 읽기 모두 이 정책을 따르게 한다. 거부된 promise가 영구 캐시되어 재시도까지 막지 않도록 한다. 일반 브라우저 개발의 기존 폴백 동작은 유지한다. 새 모드의 플래그는 권한 부여나 서버 인증에 사용하지 않는다.

업무 세션의 HTTP·HTTPS·WS·WSS 요청도 main에서 허용 origin으로 제한한다. 운영 모드는 선택한 서버와 그에 대응하는 WS origin, 개발 모드는 지정한 화면·API 및 HMR WS origin만 허용한다. 이 제한으로 이전 서버 빌드가 엄격 모드를 지원하지 않거나 잘못된 설정이 캐시에 남았더라도 원격 창에서 localhost나 제3의 서버에 요청하지 못하게 한다. `blob:` 다운로드 등 기존 로컬 기능은 필요한 범위를 따로 검증한다. 새 서버 세션에는 정책을 적용한 뒤 문서를 로드한다.

## 창과 입력 동작

- `setWindowOpenHandler`에서 현재 origin의 허용된 앱 경로만 새 업무 창으로 연다. `code`, `index`, `view`, `workspaceTransfer` 등 기존 query를 그대로 전달한다. 모든 자식 창에도 같은 탐색·권한·새 창 정책을 적용한다.
- 메인 origin 밖으로의 문서 탐색·리다이렉트는 차단한다. 외부 HTTP(S) 링크는 검증된 사용자 링크 동작에 한해 OS 브라우저로 열고 `file:`, `javascript:`, 임의 커스텀 스킴은 거부한다.
- 같은 origin 창의 localStorage는 공유하되, 창별 sessionStorage·종목·현재 배치 격리를 유지한다. 원래 창의 종목과 배치를 새 창이 덮지 않는지 검사한다.
- 창 위치·크기·최대화 상태를 저장한다. 모니터 제거·DPI 변경으로 화면 밖에 남으면 현재 work area 안으로 보정한다. 프론트의 창 배치 데이터와 OS 창 좌표를 구분한다.
- 앱 중복 실행은 기존 앱 창을 활성화한다. 자식 창이 남아 있는 동안 기본 창 종료가 전체 앱 종료로 번지지 않게 한다. 마지막 창 종료 시에만 앱을 끝낸다.
- 첫 배포에서 앱 재실행 시 기본 창 위치를 복원한다. 자식 창의 종목·저장뷰·주문 화면 전체를 자동 재개하는 기능은 후속으로 둔다.
- 메뉴 단축키가 기존 Ctrl/Cmd 휠·차트 도구·검색·텍스트 편집을 가로채지 않도록 한다. 기본 배율은 100%로 유지하고 기존 디자인 토큰을 재사용한다.
- `backgroundThrottling`은 기본값을 유지하고 최소화·복귀 결과를 측정한다. 필요한 경우에만 창별 정책을 조정한다. Electron 전환을 성능 개선으로 간주하지 않는다.
- CSV·PNG 다운로드와 클립보드를 실제 설치본에서 확인한다. 원격 HTTP에서 사용할 수 없는 클립보드 기능은 기존 다운로드 대체 경로를 유지하며 `webSecurity` 해제로 우회하지 않는다.

## 브라우저 설정 이전

브라우저의 전체 프로필 디렉터리를 복사하지 않고, 기존 설정 드로어에 사용자 설정 JSON 내보내기·가져오기를 추가한다. 양쪽 환경에서 같은 도구를 사용한다. 신규 설정 화면 사본은 만들지 않는다.

이전 대상은 워크스페이스 배치, 지표 설정, 차트 선호 설정, 그리기 데이터 등 브라우저 소유 사용자 설정이다. 구현 전에 실제 키와 스키마를 조사해 허용 목록을 확정한다. 동적 그리기 키도 소유 모듈에서 검증한다. `persistencePolicy.ts`는 예외 정책만 다루므로 전체 키 목록으로 취급하지 않는다.

전달 파일에 포맷 버전·소스 origin·앱 버전을 포함한다. localStorage 전체, sessionStorage, 일회성 `workspaceTransfer` 항목, 캐시·진단 플래그, 주문 실행 상태·인증정보는 제외한다. 서버 소유 관심종목·저장뷰·계좌·수집 데이터는 파일에 복제하지 않는다.

가져오기는 파일 크기·허용 키·버전·필드 구조를 모두 검사한 후 적용한다. 적용 전 현재 설정 백업을 제공하고 실패 시 복구할 수 있게 한다. 다른 origin에서 온 설정은 대상 서버를 명시해 사용자가 적용하도록 한다. 대상 origin의 다른 업무 창을 닫은 상태에서 적용하고 재시작해 창들의 인메모리 상태와 저장소가 어긋나지 않도록 한다. 원본 Chrome 설정은 보존한다.

## 보안과 배포

원격·로컬 renderer 모두 `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity: true`를 사용한다. 연결 설정 IPC는 패키지에 포함한 로컬 설정 화면의 main frame에서만 허용하며 URL과 payload를 검증한다. 원격 창의 읽기 전용 표시값 외에는 Electron API를 노출하지 않는다. 다운로드는 사용자 저장 동작에 맞춰 처리하고 파일의 자동 실행은 하지 않는다.

세션 권한은 기본 거부로 두고 검증한 기존 기능에 필요한 범위만 허용한다. 로컬 설정 화면에는 제한적인 CSP를 적용한다. 원격 업무 화면의 CSP는 기존 동작과의 호환을 확인한 뒤 별도 변경으로 다룬다. 요청과 오류 로그에는 query·쿠키·주문 payload를 기록하지 않는다.

Electron 공식 지침은 원격 콘텐츠에 HTTPS를 권장한다. 이 계획은 기존 ADR-0134의 Tailscale 암호화 네트워크 안에서 고정 HTTP origin을 유지하는 프로젝트별 선택을 따른다. 이를 일반 공인·LAN HTTP 서버 허용으로 확대하지 않는다. 서버 선택 화면에서 신뢰할 서버 origin을 명시적으로 등록하며, 문자열이 MagicDNS처럼 보인다는 이유만으로 tailnet 연결을 검증했다고 간주하지 않는다. TLS 인증서 오류 무시 옵션도 추가하지 않는다.

패키징은 별도 `desktop/package-lock.json`으로 고정한 Electron·Forge를 사용한다. 구현 시점의 지원 중인 안정 버전을 선택하고 업데이트 절차를 문서화한다. `desktop`의 실행 환경은 기존 Node 24와 선택한 도구의 지원 범위를 함께 확인한다.

버전은 루트 `VERSION`에서 생성한다. `frontend/package.json`의 `0.0.0`은 유지한다. 현재 네 부분 버전 `0.16.6.0`을 Electron·Forge·대상 설치 형식에 그대로 사용할 수 있다고 가정하지 않는다. 패키징 단계에서 허용 버전으로의 결정적 매핑을 정의하고, 원래 버전·커밋을 앱 정보에 함께 표시하며 다음 네 번째 자리 증가도 구분되는지 검사한다.

초기 배포는 설치 파일 또는 압축본의 수동 업데이트를 지원한다. OS별 빌드·서명 요구를 확인하고 실제 대상 OS에서 설치·실행·제거를 검증한다. 압축본 실행만 확인한 결과를 설치본 검증으로 대체하지 않는다. 패키지에 `.env`, `.cookie`, 데이터 디렉터리, 실제 서버 프로필이 포함되지 않도록 포함 파일을 명시한다. 서버 프론트 배포와 Electron 런타임 배포를 구분해 안내한다.

### Linux 우선 배포

- 개발 실행 → Linux x64 패키지 실행 → ZIP 압축 배포본 → Ubuntu용 `.deb` 설치본 순서로 확인한다. Forge의 ZIP·deb maker를 사용하며 `.deb` 빌드에 필요한 `fakeroot`·`dpkg`를 확인한다. AppImage·RPM은 첫 배포에 추가하지 않는다.
- `.deb`의 앱 아이콘·메뉴 등록·일반 사용자 실행·버전 업그레이드·제거를 검증한다. 재설치·업데이트 후 `userData`의 프로필·설정이 유지되는지 확인하고 제거 시 사용자 데이터 처리 방식을 안내한다.
- X11과 Wayland 세션을 구분해 기록한다. 창 위치·포커스·크기·여러 모니터·DPI·한글 입력·클립보드를 확인하고, 실제 실행한 세션만 검증 완료로 표시한다. compositor가 절대 창 위치를 제어하는 환경에서는 정확한 좌표 복원을 보장하지 않고 지원 범위와 대체 동작을 기록한다.
- sandbox를 활성화한 일반 사용자 실행을 배포 기준으로 삼는다. 샌드박스·배포판 의존성 문제를 `--no-sandbox` 또는 root 실행으로 우회해 통과 처리하지 않는다.

## 구현 단계와 산출물

| 단계 | 주요 작업 | 완료 기준 |
| --- | --- | --- |
| 1 기본 실행 | `desktop/` 패키지, main·로컬 설정 화면, 보안 기본값, 개발 실행·패키징 초안 | 격리된 서버의 `/live`를 열고 종료 후 서버가 계속 동작 |
| 2 연결 프로필 | 로컬·원격·개발 모드, 저장·복구, 연결 진단, 엄격 설정 로딩, 서버 전환 | 원격 실패 시 localhost 요청 0건, 잘못된 설정에서 요청 중단·재시도 가능 |
| 3 여러 창 | 기존 새 탭 연결, 배치 전달·저장소 격리, 창 위치·DPI 보정, 중복 실행 | 새 창이 기존 창의 종목·배치를 바꾸지 않고 화면 밖 복원 방지 |
| 4 설정 이전 | 허용 목록·스키마 검사, 내보내기·가져오기·백업, 기존 설정 드로어 통합 | 브라우저에서 Electron으로 대표 배치·지표·그리기를 이전하고 실패 시 복원 |
| 5 배포 검증 | Linux x64 ZIP·Ubuntu `.deb`, 버전 매핑, 다운로드·한글 입력·절전·서버 장애 검증, 사용 안내 | Linux 설치본에서 핵심 시나리오 통과, 디스플레이 세션별 검증 기록과 수동 업데이트 절차 제공 |

1·2 단계 완료 시 로컬·원격 서버를 선택하는 시제품을 검토할 수 있다. 일상 사용을 위한 첫 배포는 3~5 단계까지 완료한 뒤 판단한다. 프론트 변경이 서버 화면에 반영되어야 하므로 Electron 시제품과 검증 대상 서버 빌드의 커밋을 함께 관리한다.

예상 파일 구성은 다음과 같다. 구현 중 파일 분리는 복잡도에 맞춰 조정한다.

```text
desktop/
  package.json
  package-lock.json
  forge.config.ts
  tsconfig.json
  src/main.ts
  src/profiles.ts
  src/connection.ts
  src/windows.ts
  src/navigation.ts
  src/preload/launcher.cjs
  src/preload/content.cjs
  src/launcher/
  tests/
  README.md
frontend/src/config.ts
frontend/src/api/client.ts
frontend/src/live/settings/
frontend/src/state/                 # 설정 이전 데이터 검증과 적용 모듈
```

`desktop`의 빌드 결과·설치 결과·테스트 userData 경로를 ignore한다. `README.md`에 로컬 운영 설정, 원격 Tailscale 연결, 개발 Vite 연결, 설정 이전, 수동 업데이트·복구 절차를 추가한다. 기존 웹 앱 실행 명령은 유지한다.

## 검증 계획

### 자동 검증

- URL·프로필 검증: 허용 origin, 개발 API origin, 잘못된 스킴·인증정보·리다이렉트 거부, 설정 손상 복구.
- 연결 경계: 원격 config 실패 시 localhost로의 GET·POST·WS가 모두 발생하지 않음. 연결 timeout·취소·프로필 전환 후 늦은 응답 무시.
- 창 경계: 원래 창의 종목·배치 보존, 일회성 전달함 소비, sessionStorage 격리, 창 전역 정책 상속.
- 설정 이전: 유효 데이터 왕복, 동적 그리기 키, 알 수 없는 버전·금지 키·손상 파일 거부, quota/write 실패 후 복원.
- Electron E2E: 로컬 설정 화면부터 서버 접속·새 창·서버 전환·재실행 후 저장 복원까지 확인. Playwright의 Electron 지원은 experimental이므로 개발 실행 E2E와 실제 패키지 수동 검증을 함께 사용한다.
- 브라우저 회귀: 일반 웹 모드의 설정 로딩, 기존 새 탭·배치 전달, 차트 주요 입력, 설정 드로어·내보내기 동작을 관련 기존 E2E로 확인한다.

Electron 테스트의 `userData`·세션·다운로드·서버 포트·데이터 경로는 워크트리 및 실행별 임시 경로를 사용한다. 기존 E2E의 무자격 환경변수와 `workers: 1` 원칙을 유지하고 테스트 대상 체크아웃을 식별한다. 개발 서버 5173·8000과 사용자의 prod 서버를 테스트가 종료·재시작하지 않는다.

프론트 변경에는 `npm run typecheck`, 관련 Vitest, lint, production build 및 영향받는 브라우저 E2E를 수행한다. `desktop/`에는 타입·lint·단위·Electron E2E·패키징 검사를 추가한다. 백엔드 코드를 변경하지 않으면 전체 백엔드 테스트를 일괄 재실행하지 않되, 격리 백엔드의 HTTP·WS·OriginGuard 통합 동작은 확인한다.

### 설치본 확인 행렬

| 상황 | 확인할 결과 |
| --- | --- |
| 로컬 서버 + 정적 프론트 서빙 | 화면·REST·WS·설정 저장이 같은 origin에서 정상 동작 |
| 로컬 서버 origin 설정 누락 | 원인 안내, 허용 목록 자동 완화 없음 |
| 원격 Tailscale 서버 | 기존 MagicDNS origin과 화면 설정 유지 |
| 원격 불통 + localhost에 다른 서버 실행 | 로컬 서버로의 폴백 요청 0건 |
| health 정상 + 프론트 서빙 없음 | 프론트 배포 설정 안내 |
| 네트워크 단절·서버 재시작·절전 복귀 | 화면 보존·연결 회복·오래된 데이터 표시, 상태변경 요청 재전송 없음 |
| 새 창·창 종료·앱 중복 실행 | 독립 배치, 기존 창 활성화, 서버 수명 유지 |
| 여러 모니터·배율 변경·모니터 제거 | 창이 화면 안에 복원되고 휠·드래그 좌표 정상 |
| CSV·PNG·클립보드 | 저장 경로 선택·취소·기존 대체 동작 정상 |
| 설치·업데이트·제거 | 버전 식별 가능, 업데이트 후 프로필·설정 보존 |
| Linux X11·Wayland | 한글 입력·클립보드·창 동작 확인, 세션별 위치 복원 지원 범위 기록 |

주문 UI의 검증은 모의 모드 또는 fixture로 수행한다. 실서버 연결 확인은 읽기 동작으로 제한하고 실주문을 검증 명목으로 보내지 않는다. 여러 창의 장시간 CPU·메모리·WS 연결 수와 최소화 복귀 시 갱신을 동일 조건의 Chrome 기준과 비교해 기록한다.

## 검토 결론과 구현 시 결정할 사항

기존 서버 URL을 로드하면 현재 라우팅·REST·WS·서버 배포 구조를 유지하면서 Electron을 추가할 수 있다. 첫 구현의 주요 위험은 원격 설정 실패의 localhost 폴백, 잘못된 세션 분리, 새 창의 상태 덮어쓰기, OS 설치본 검증 누락이다. 위 단계와 완료 기준은 이 네 가지를 직접 확인하도록 구성했다.

우선 OS는 Linux로 확정했다. 구현 시 실제 사용 PC의 배포판·아키텍처·X11 또는 Wayland 세션과 원격 MagicDNS 주소를 확인한다. 주소가 없어도 격리된 두 테스트 origin으로 공통 구현·검증을 진행할 수 있다. 초기 구현은 현재 Ubuntu x86_64 검증 환경에서 진행하고, 검증하지 않은 배포판·아키텍처·다른 OS의 지원 완료를 주장하지 않는다. Electron 도입을 확정해 ADR을 추가할 때는 저장소와 열린 PR의 번호를 함께 확인한다.

## 공식 참고 문서

- [Electron 보안 지침](https://www.electronjs.org/docs/latest/tutorial/security): renderer 격리, 권한·탐색·IPC 제한, 원격 HTTPS 권고.
- [Electron webContents](https://www.electronjs.org/docs/latest/api/web-contents): 문서 로드 실패 이벤트와 새 창 처리.
- [Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window): Wayland의 위치·크기·포커스 제약.
- [Electron WebPreferences](https://www.electronjs.org/docs/latest/api/structures/web-preferences): 영속 partition과 backgroundThrottling.
- [Electron app](https://www.electronjs.org/docs/latest/api/app): userData와 단일 앱 인스턴스.
- [Electron Forge](https://www.electronforge.io/): 별도 데스크톱 패키징 도구.
- [Forge ZIP maker](https://www.electronforge.io/config/makers/zip), [deb maker](https://www.electronforge.io/config/makers/deb): Linux 압축 배포와 Ubuntu 설치 패키지.
- [Playwright Electron](https://playwright.dev/docs/api/class-electron): experimental Electron 자동화.

## 구현 결과

2026-10-16에 `desktop/` Electron 클라이언트와 프론트의 엄격한 연결 설정 처리·설정 이전 기능을 구현했다. Linux x64 ZIP과 Ubuntu `.deb`를 생성했다. 서버 실행·감독·저장 경로를 바꾸지 않았으며 기존 ADR-0134를 유지한다.

- 서버 선택·취소·재시도, 원격 localhost 폴백 차단, 영속 세션 분리, 새 작업 창·기존 새 탭의 OS 창 연결, 기본 창 복원을 구현했다.
- 실제 FastAPI와 production React를 연결한 Electron E2E에서 설정 내보내기·가져오기·재로딩·새 창과 fixture 캔들 차트 표시를 확인했다.
- 패키징 바이너리의 핵심 E2E 3개를 5회 반복해 15개 모두 통과했다. `.deb`에서 추출한 바이너리도 기본 실행 및 명시적인 Wayland·X11 모드에서 검증했다.
- 브라우저 화면·정적 배포 E2E 5개, 관련 프론트 단위 테스트 166개, desktop 단위 테스트 7개, 프론트·desktop 타입·lint·빌드 검사를 통과했다. 명령과 입력 지문은 `docs/diagnostics/2026-10-16-electron/verification.json`에 기록한다.
- 외부 링크는 사용자 우클릭 메뉴에서 OS 브라우저로 열도록 구체화했다. 자동 외부 팝업은 차단한다.
- 첫 설정 이전은 현재 스키마의 창 배치·지표·차트 선호 설정·그리기·테마에 한정했다. 선택 종목·핀·주문창 주문 설정, 서버 데이터, 레거시 그리기 v1 및 도구 기본 스타일은 내보내지 않는다. 파일에 없는 대상 설정은 유지한다.

시스템 `.deb` 설치는 이 호스트의 관리자 인증이 필요해 실제 메뉴 등록·업그레이드·제거 검증을 수행하지 않았다. `verify:deb`는 임시 경로에 패키지를 추출해 일반 사용자·sandbox 활성 상태로 실행한다. 실제 원격 PC의 Tailscale 연결, 여러 물리 모니터·DPI 변경, 한글 IME 조합 입력, OS 절전·네트워크 장애 후 장중 장시간 안정성은 운영 환경 수동 확인 항목으로 남긴다. 자동 업데이트·트레이·푸시 알림은 첫 배포 범위에 추가하지 않았다.

실행·서버 설정·설정 이전·설치·검증 절차는 [desktop 안내](../../desktop/README.md)에 정리했다.
