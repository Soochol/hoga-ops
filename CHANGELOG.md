# Changelog

All notable changes to this project are documented here.
The format follows a 4-digit `MAJOR.MINOR.PATCH.MICRO` scheme.

## [0.6.4.0] - 2026-06-08

### Added
- **/live 차트 마우스 휠 인터랙션**: TradingView 방식의 3가지 휠 동작 추가.
  - 휠: 화면 오른쪽 끝을 고정한 줌인/줌아웃 — 라이브 엣지에서는 최신 캔들이
    제자리에 머물고, 과거 구간을 보던 중에도 뷰가 "지금"으로 끌려가지 않음.
  - Ctrl(Cmd)+휠: 마우스 커서 아래 지점을 고정한 줌 — 커서 위치의 캔들이
    화면에서 움직이지 않음.
  - Shift+휠: 줌 없이 x축 좌우 이동 — 오른쪽으로는 마지막 캔들에서 멈춤
    (오른쪽 벽). 차트 위에서 휠을 굴려도 페이지는 스크롤되지 않음.
  - Firefox 같은 라인 단위 휠 브라우저를 위한 deltaMode 정규화 포함 — 모든
    브라우저에서 같은 줌 감도.
  - 트랙패드 가로 스와이프 팬·핀치 줌·드래그 팬은 기존 그대로 동작.
- 용어 정식화: **Live Edge**·**Right Wall**을 CONTEXT.md 용어집에 등재.

## [0.6.3.0] - 2026-06-08

### Fixed
- **관심종목·스크리너 패널이 차트 높이를 흔들던 레이아웃 버그 수정**: 패널
  콘텐츠가 화면보다 길어지면 /live 차트가 화면 밖까지 늘어나고(실측 최대
  4,600px+), 그룹을 접고 펼 때마다 차트 높이가 함께 출렁이던 문제를 앱 셸
  grid 행 계약(`minmax(0, 1fr)`)으로 근본 수정. 이제 차트는 항상 화면에
  맞고, 긴 관심종목/스크리너 목록은 패널 내부 스크롤로 끝까지 볼 수 있음
  (기존에는 화면 아래 항목이 스크롤 불가로 접근 불가였음).
- 실브라우저 레이아웃 회귀 테스트 2종 추가(관심종목 접기/펼치기 불변성,
  스크리너 긴 결과) — jsdom에는 레이아웃 시임이 없어 e2e가 유일한 가드.

## [0.6.2.0] - 2026-06-07

### Fixed
- **/live 차트 x축 날짜 라벨 오류**: 타임프레임 전환(D/W/M)이나 좌측 팬 과거
  데이터 로드 후, 과거 구간의 연도/날짜 라벨이 이전 화면의 날짜로 표시되던
  버그 수정 (예: 2021~2026 주봉에 '07/'08 표시, 작년 구간 날짜가 1년씩 밀림).
  가상 시간축을 첫 세션의 실제 개장 시각에 앵커하고, 종목·타임프레임 전환 시
  차트 인스턴스를 재생성해 차트 라이브러리의 시간값 기반 캐시(틱 가중치·라벨)
  잔존을 차단.
- 전환 직후 새 차트가 초기 뷰포트를 받지 못하던 문제 수정 — 분봉은 최근 300봉
  윈도우가, 일/주/월봉은 전체 맞춤이 새 차트에 정상 적용.

### Changed
- 차트 시간축 변환(`toVirtual`)을 이진 탐색으로 전환하고 틱 가중치 계산을
  단일 패스로 정리 — 분봉 ~5,000봉 갱신 경로의 비용 절감.
- SSE 갱신 시 세그먼트 배열 identity를 내용 기준으로 안정화 — 내용이 같은
  푸시는 축 객체와 라벨 캐시를 보존.

## [0.6.1.0] - 2026-06-05

### Added
- **관심종목 그룹 관리 UI** (로컬 0.5.7.0~0.5.10.1 통합): 그룹 생성/이름 변경/삭제,
  헤더 `⋯` 메뉴, 우측 chevron 접기(상태 localStorage 영속화), 그룹 순서 변경(패널 ▲▼ +
  편집 모달 ⠿ 드래그), 우클릭 → 그룹으로 이동. 체크 표시를 공용 `ui/CheckIcon`으로 통합.

### Fixed
- Escape 이중 닫힘(모달/메뉴 먼저 닫고 다음 Escape가 패널), hover 전용 버튼 키보드
  접근성(Tab opacity 계약), GroupNameModal 거부 시 unhandled rejection 없이 재시도.

### Tests
- 폴더 도입 이후 깨져 있던 watchlist e2e 복구·재편(컨텍스트 메뉴/그룹 메뉴/Escape 레이어링/
  편집 모달 드래그, 총 5스펙).

> 세부 변경 이력은 아래 [0.5.10.1]~[0.5.7.0] 항목 참조. v0.6.0.0(KRX→KIS) 위에 병합.

## [0.6.0.0] - 2026-06-05

### Added
- **ETF·ETN 종목 지원**: 종목 검색에 ETF와 ETN이 함께 나옵니다. KRX의 새 영숫자
  티커(`0000H0` 같은)와 7자리 ETN 코드(`Q500093`)가 관심종목 추가·캘린더·캡처
  전 구간에서 그대로 동작합니다 — 이전에는 검색에만 보이고 클릭하면 거부됐습니다.
- **자격증명 없는 종목 검색**: 종목 목록을 KIS의 무인증 정적 파일(.mst)에서
  받아오므로, 아무 키를 설정하지 않아도 검색이 동작합니다. 목록이 비어 있으면
  부팅 시 백그라운드로 자동 다운로드합니다.

### Changed
- **데이터 소스 KRX → KIS 전환**: 종목 목록과 거래일(휴장일) 조회가 모두
  KIS Open API로 옮겨갔습니다. `KRX_ID`/`KRX_PW`는 더 이상 필요 없고,
  거래일·실시간 기능에는 기존 `KIS_APP_KEY`/`KIS_APP_SECRET`만 사용합니다.
- **에러 안내가 원인을 구분합니다**: "자격증명 미설정"(키를 설정하세요)과
  "KIS 일시 오류"(잠시 후 재시도)를 다른 메시지로 안내합니다 — 멀쩡한 키를
  헛되이 점검하게 만들던 안내를 정리했습니다. `.env`에 키를 추가한 뒤
  재시도하면 서버 재시작 없이 바로 반영됩니다.

### Fixed
- **일부 종목이 검색에서 누락되던 문제**: 종목 마스터 파싱의 1바이트 오프셋
  오류로 이름이 긴 종목(40바이트 풀네임)이 통째로 빠졌습니다. 실제 데이터로
  검증해 수정했습니다.
- **토큰 만료·키 교체 후 멈춤**: KIS가 토큰을 거부하면 최대 24시간 동안
  실시간·시세 기능이 복구되지 않던 문제 — 이제 토큰을 자동 폐기하고 한 번
  재발급해 즉시 복구합니다. 키를 교체해도 옛 토큰을 재사용하지 않습니다.
- **간헐적 UI 멈춤**: 토큰 발급과 거래일 조회(차단형 네트워크 호출)가 서버
  이벤트 루프 위에서 돌아 모든 화면이 최대 10초씩 얼던 문제를 백그라운드
  스레드로 옮겨 해결했습니다. 장애 시에도 60초 간격으로만 재시도합니다.
- **KIS 일시 오류 한 번에 거래일 조회 전체가 실패하던 문제**: 호출당 1회
  재시도를 추가했습니다(실측 ~1/6 호출이 일시 500을 반환).
- **캘린더 장애 중 수동 수집이 "성공"으로 보이던 문제**: 거래일을 가져오지
  못하면 이제 항목별로 실패 사유가 표시됩니다 — 조용히 0건 수집으로 끝나지
  않습니다.
- **업그레이드 직후 종목 검색이 비던 문제**: 이전 버전의 종목 캐시 파일을
  그대로 읽어 쓰고, 백그라운드에서 새 형식으로 갱신합니다.

### Removed
- **pykrx 의존성 제거**: KRX 로그인 기반 조회와 `KRX_ID`/`KRX_PW` 환경변수가
  완전히 사라졌습니다(연쇄 의존성 15개 패키지 포함).

## [0.5.10.1] - 2026-06-05

### Fixed
- **그룹 추가/이름 변경 실패 처리**: 서버가 거부해도 unhandled rejection 없이
  다이얼로그가 열린 채로 남아 재시도할 수 있습니다.

### Internal
- 코드리뷰 후속 정리: 폴더 순서 스왑 로직을 `swapFolderOrder`(grouping.ts)로 승격해
  패널 ⋯ 메뉴와 편집 모달이 공유, 패널의 두 앵커드 메뉴 셸을 `AnchoredMenu`로 통합,
  접기 toggle을 함수형 업데이터 + 반응형 영속화(effect)로 재구성하고 기록 시점에
  삭제된 그룹 키를 정리, 드로어 테스트에 localStorage 격리(beforeEach clear) 추가,
  CheckIcon 기본 크기(18) 회귀 테스트 추가.

## [0.5.10.0] - 2026-06-05

### Added
- **우클릭 → 그룹으로 이동**: 관심종목 패널 종목 우클릭 메뉴에 `그룹으로 이동` 섹션이
  추가됐습니다 — 현재 그룹을 제외한 그룹들과(그룹 소속이면) **미분류**가 나열되고,
  누르면 편집 모달 없이 바로 이동합니다.
- **그룹 접기 상태 영속화**: 패널 그룹의 접힘/펼침이 localStorage에 저장되어 패널을
  닫았다 열어도 유지됩니다.

### Fixed
- **편집 모달 그룹 행 키보드 접근**: hover에서만 보이던 ▲▼✎🗑 버튼이 Tab 포커스로도
  도달·표시됩니다(패널 ⋯과 같은 opacity 계약).

### Tests
- **watchlist e2e 복구·재편**: 폴더 도입(0.5.5.0) 이후 mock 형태가 낡아 깨져 있던
  watchlist e2e를 복구하고(`watchlist-context-menu` + 공용 `liveMocks`), 제거된 패널
  드래그 기능의 `watchlist-reorder.spec.ts`는 폐기 후 **편집 모달 ⠿ 드래그**로
  포팅했습니다(`watchlist-edit-reorder.spec.ts`). 그룹 ⋯ 메뉴·Escape 레이어링·
  그룹으로 이동을 덮는 e2e도 추가됐습니다(총 5건 통과).

## [0.5.9.0] - 2026-06-05

### Added
- **패널에서 그룹 순서 변경**: 그룹 헤더 `⋯` 메뉴에 `▲ 위로 이동` / `▼ 아래로 이동`이
  추가됐습니다(맨 위/맨 아래에서는 비활성). 편집 모달과 같은 전체 순서 계약을 씁니다.

### Fixed
- **Escape 이중 닫힘**: 모달이나 메뉴가 열린 상태에서 Escape를 누르면 관심종목 패널까지
  한번에 닫히던 문제를 수정했습니다 — 이제 Escape는 열린 모달/메뉴를 먼저 닫고,
  다음 Escape가 패널을 닫습니다.
- **그룹 `⋯` 키보드 접근**: hover에서만 나타나던 `⋯` 버튼이 Tab 포커스로도 도달·표시
  됩니다(display 숨김 → opacity 숨김 전환).

### Changed
- **사전필터 체크 아이콘 통합**: 스크리너 사전필터 모달의 체크 표시를 공용 `ui/CheckIcon`
  으로 교체했습니다(미활성 링 안에 희미한 체크가 생기는 미세한 외관 변화).

## [0.5.8.0] - 2026-06-05

### Added
- **그룹 헤더 ⋯ 메뉴**: 관심종목 패널의 그룹 헤더에 마우스를 올리면 `⋯` 버튼이 나타나고,
  누르면 그룹명 헤더와 함께 `✎ 그룹 이름 변경` / `🗑 그룹 삭제` 메뉴가 열립니다.
  이름 변경은 기존 이름이 채워진 다이얼로그로, 삭제는 즉시 실행되며 소속 종목은
  **미분류**로 이동합니다(데이터 비손실). 미분류 헤더에는 메뉴가 없습니다.

### Changed
- **그룹 접기 표시를 우측 chevron으로**: 그룹 헤더 왼쪽의 `▸/▾` 글리프를 행 오른쪽 끝의
  `∧`(펼침)/`∨`(접힘) 화살표 버튼으로 옮겼습니다. 그룹명 클릭과 화살표 클릭 모두
  접기/펼치기를 토글합니다.

## [0.5.7.0] - 2026-06-05

### Added
- **새 그룹 만들기**: 관심종목 패널 `편집` 버튼이 이제 메뉴(`관심 편집` / `새 그룹 만들기`)를
  엽니다. `새 그룹 만들기`는 이름만 입력하는 `그룹 추가하기` 다이얼로그를 띄워 패널에 빈
  그룹을 바로 만듭니다. `관심 편집`은 기존 편집 모달을 엽니다.

### Changed
- **편집 모달 체크박스 통일**: 종목 다중선택 체크박스(전체 선택 + 각 행)를 보조지표 모달과
  같은 원형 체크 아이콘으로 교체했습니다(공용 `ui/CheckIcon`으로 추출해 양쪽이 공유).
- **편집 모달 종목 행 간소화**: 종목코드 컬럼을 숨기고 종목명만 표시합니다.
- **용어 통일**: 관심종목 UI의 `폴더`를 `그룹`으로 통일했습니다(`관심 그룹`, `＋ 그룹 추가`,
  `그룹 이름`). 도메인/API 식별자(folder)는 그대로입니다.

### Fixed
- `/live` 차트에서 **과거 캔들을 불러올 때 화면이 이동하던** 문제를 근본적으로
  고쳤습니다. 과거로 드래그한 뒤 일부만 되돌아와 데이터 중간을 보고 있으면,
  fetch가 끝나는 순간 보던 내용이 통째로 며칠 과거로 밀렸습니다(차트 라이브러리가
  이 위치에서는 화면을 보정하지 않는 것이 실측으로 확인됨). 이제 데이터가
  도착하는 바로 그 프레임에 "직전에 보던 화면"을 기록해 두었다가 같은 봉이
  같은 자리에 오도록 되돌립니다 — 기록과 적용 사이에 시간 차가 없어 어떤
  드래그·줌 조합에서도 낡은 위치로 튀지 않습니다. 최신봉을 보고 있을 때는
  라이브러리가 스스로 화면을 보존하므로 아무것도 하지 않고, 과거로 드래그해
  빈 영역을 보고 있을 때는 보이던 봉은 그대로 둔 채 빈 공간만 새 데이터로
  채워집니다. 줌 배율(봉 폭)은 어떤 경우에도 변하지 않습니다.

## [0.5.6.0] - 2026-06-05

### Changed
- **관심종목 편집 모달 외형 통일**: 차트의 보조지표(지표) 모달과 같은 형태로 정렬했습니다.
  공용 모달 외형(제목·✕·ESC·바깥 클릭 닫기), 하단 `닫기` 버튼, 좌측 `관심 폴더` 섹션 헤더를
  갖춥니다. 폴더 추가·이름변경·삭제·순서변경·이동·드래그 정렬 기능은 그대로입니다.
- **편집 모달 기본 화면 = 미분류**: 편집 모달은 이제 폴더와 **미분류**만 보여주며, 열 때
  기본으로 **미분류**를 표시합니다(기존 `모든 종목` 통합 보기를 대체).

### Removed
- **우측 패널 빠른 추가 제거**: 관심종목 우측 패널 헤더의 `종목 추가` 입력을 제거했습니다.
  종목 추가는 `편집` 모달로 일원화됩니다.
- **편집 모달 `모든 종목` 제거**: 폴더 구분 없이 전체를 보던 `모든 종목` 의사폴더를 제거하고,
  폴더/미분류 단위 관리로 정리했습니다.

## [0.5.5.0] - 2026-06-05

### Added
- **관심종목 폴더**: 오른쪽 관심종목 패널의 종목을 사용자가 만든 폴더로 묶을 수 있습니다.
  드로어는 폴더별로 그룹지어 보여주고(접기/펼치기 + 종목 수, **미분류**는 항상 맨 끝),
  각 행에는 기존처럼 라이브 시세(현재가·등락률·전일대비)가 그대로 표시됩니다.
- **관심종목 편집 모달**: 패널 헤더의 `편집` 버튼으로 2-pane 편집창을 엽니다. 왼쪽은
  폴더 목록(그룹 추가·이름변경·삭제·순서변경), 오른쪽은 선택한 폴더의 종목 목록
  (추가, 체크박스 다중선택, 다른 폴더로 이동, 삭제, 폴더 내 드래그 정렬). 모든 구조 편집은
  이 모달 한 곳으로 일원화됐습니다.
- `watchlist.json`이 폴더를 담는 v2 문서 형식(`{schema_version, folders, entries}`)으로
  확장됐습니다. 기존 v1 파일은 처음 열 때 자동으로 v2로 변환되며(절대 격리/폐기하지 않음),
  폴더는 수집 동작에 전혀 영향을 주지 않습니다(스케줄러는 폴더와 무관하게 전 종목을 수집).

### Changed
- 관심종목 드로어가 평면 목록에서 **폴더 그룹 + 편집 모달** 구조로 바뀌었습니다. 드로어
  자체는 읽기·차트 이동·빠른 해제(우클릭/Delete)만 담당하고, 정렬은 폴더 안에서 모달로 합니다.

### Removed
- 별도의 `/watchlist` 풀페이지를 제거했습니다(편집은 패널 + 편집 모달로 대체).
- 관심종목 평면 드래그 재정렬(`PUT /api/watchlist/order`)을 제거했습니다 — 폴더 내 정렬로 대체.

## [0.5.4.0] - 2026-06-05

### Fixed
- `/live` 차트에서 **과거로 드래그해 캔들을 더 불러온 직후 최근으로 되돌아오면,
  fetch가 끝나는 순간 화면이 과거 위치로 튀던** 문제를 고쳤습니다. 과거 드래그는
  "지금 보던 위치"를 기준점으로 캡처하고 150ms 뒤 데이터를 받아오는데, 그 사이
  사용자가 최근으로 되돌아와도 기준점이 과거 위치에 그대로 남아, 데이터가 도착해
  과거 봉이 앞에 붙는 순간 복원 로직이 그 낡은 기준점으로 화면을 되돌렸습니다.
  이제 사용자가 로드된 봉 영역으로 되돌아오는 즉시 낡은 기준점을 무효화합니다.
  데이터는 그대로 미리 받아오고(원하던 동작), 화면 이동만 사라집니다. 브라우저
  실측 결과 lightweight-charts의 `setData`가 과거 봉 추가 시 화면을 스스로
  보존하므로 복원 로직 없이도 보던 위치가 유지됩니다.

## [0.5.3.0] - 2026-06-05

### Fixed
- `/live` 차트에서 **관심종목을 처음 클릭할 때 캔들이 "두 번 그려지던"** 현상을
  고쳤습니다. 처음 보는 종목은 과거 캔들을 받아오는 데 ~3초가 걸리는데, 그동안
  보조지표가 먼저 도착해 차트가 약 60봉으로 좁게 잡혔다가, 캔들이 도착하면 약
  300봉으로 다시 줌아웃되며 한 프레임 깜빡였습니다(lightweight-charts가 줌 폭
  변경을 항상 한 프레임 늦게 그리는 특성 때문). 이제 줌이 최종 상태로 안정될 때까지
  반투명 덮개로 차트를 가렸다가 부드럽게 드러내, 캔들이 처음부터 올바른 줌으로
  **한 번에** 나타납니다. 종목을 전환할 때도 이전 종목의 캔들이 잠깐 비치지 않습니다.
  뷰포트 계산 로직(과거 데이터 복원·우측 끝 고정)은 그대로 두고 시각적으로만 가립니다.

## [0.5.2.0] - 2026-06-05

### Fixed
- `/live`의 **10호가가 장중 갑자기 사라지던** 문제를 고쳤습니다. KIS·파싱·프론트
  경로는 정상이었고, 라이브 캡처 **poller 태스크가 예외 한 번에 traceback 없이
  조용히 죽은** 뒤 상태는 거짓으로 `running:true`를 보고해 호가 버퍼가 빈 채로
  남았던 것이 원인입니다. (ADR-0064)

### Changed
- 거래일 게이트가 일별 OHLCV(장중엔 오늘 봉이 아직 발행 안 됨) 대신 KRX 거래일
  **달력**(`is_trading_session_today`)을 사용해, 살아있는 거래일이 장 초반에
  거짓으로 닫히지 않습니다. 주말은 KRX 호출 전에 단락 처리합니다. (ADR-0064)
- 라이브 poller가 자가 복원력을 갖습니다: `run_forever` 루프가 일시적 예외를
  로그 후 계속하고(today-promoter 패턴), `/api/live/status`의 `running`이 실제
  태스크 생사를 반영하며, 장중 죽거나 멈춘 poller를 **세션 개장 기준** staleness로
  감지해 자동 재시작하는 watchdog을 추가했습니다. (ADR-0064)

## [0.5.1.0] - 2026-06-05

### Fixed
- `/live` 차트의 **호가비·총잔량 보조지표**에서 장마감 **완전-동시호가 구간**
  (연속매매 호가가 하나도 없는 15:21–15:30 봉)이 이제 **0으로 제외**됩니다.
  예전엔 그 구간의 마지막 동시호가 3호가 값으로 폴백해 지표에 동시호가가
  새어들어갔습니다. 디스플레이의 Auction Mask 토글과 무관하게 계산 자체에서 빼며,
  점은 0으로 남겨 마스크·오버레이 밴드·일자경계 연결선 처리는 그대로 유지합니다.
  과거 날짜 조회와 오늘 라이브 양쪽에 적용했습니다. (ADR-0062)
- 호가비·총잔량 라인이 직전 연속매매 봉(예: 15:18)에서 동시호가 구간으로
  **내려가며 뻗던 연결선**이 사라졌습니다. (ADR-0029 갭)
- 우측 **10호가 사이드바**도 동시호가를 구조적으로 제외해 보조지표와 일치합니다.
  straddle 봉(예: 3분봉 15:18)에서 3호가 동시호가 책 대신 그날 마지막 연속매매
  호가창을 보여줍니다. (ADR-0062)

### Changed
- **1분봉 15:19**처럼 마감 직전 마지막 연속매매 봉에 마우스를 올리면 **총잔량**의
  데이터 점(호버 마커)이 다시 보입니다. 연결선 끊기 처리가 그 점의 마커 색까지
  투명하게 만들어 사라졌던 것을, 마커 색을 분리해 복원했습니다(호가비와 일치).

## [0.4.4.0] - 2026-06-03

### Fixed
- `/live` 차트의 **호가비·총잔량 보조지표**가 장마감 동시호가(15:20–15:30) 데이터를
  더 정확히 제외합니다. 예전엔 "15:20 정각" 고정 시각으로 동시호가를 잘라, 실제 진입이
  15:19:55나 15:20:05처럼 매일·종목마다 흔들리면 동시호가 호가가 봉에 새어들어가 값이
  튀었습니다. 이제 **호가창 구조**(동시호가에 들어가면 노출 호가가 10단계→3단계로 줄어듦)로
  경계를 잡아, 진입 시각과 무관하게 그날 마지막 연속매매 호가를 정확히 반영합니다.
  1분봉에서도 15:19/15:20 봉이 깨끗합니다. 과거 날짜 조회와 오늘 라이브 양쪽에 적용했고,
  반장(12:30 마감)도 과거 날짜는 자동 대응합니다. (ADR-0062)

## [0.4.3.0] - 2026-06-03

### Added
- `/live` **그리기 속성 패널**(수평선 등 도형을 선택하면 뜨는 색·두께·선스타일·삭제
  툴바)이 이제 **드래그한 마지막 위치를 유지**합니다. 이전에는 다른 도형을 클릭할 때마다
  패널이 초기 앵커(가로 중앙·선 위)로 되돌아갔지만, 한 번 그립으로 끌어 옮기면 그 위치를
  세션 동안 고수합니다. 첫 선택은 종전대로 도형 옆에 자동 배치되고, 새로고침하면 다시
  앵커로 리셋됩니다(세션 한정).

### Internal
- 패널은 항상 마운트되어 위치 state가 이미 세션 내내 보존되므로, 버그의 원인은 "위치를
  저장하지 않음"이 아니라 선택이 바뀔 때마다 위치를 앵커로 **덮어쓰던** re-anchor effect
  였습니다. `userMovedRef` 플래그(드래그 `onMove`에서 set)로 그 effect를 게이트 —
  사용자가 한 번 드래그하면 재앵커를 중단합니다. localStorage 영속화는 없습니다(세션 한정).
  설계·근거는 ADR-0062(ADR-0032의 *per-selection 재앵커* 조항을 부분 대체, *no-persistence*
  결정은 유지).

## [0.4.2.0] - 2026-06-03

### Added
- `/live` 캔들 차트에 **현재가 라인**을 추가했습니다. 마지막 캔들 종가(=현재가) 위치에
  **수평 점선**을 그리고 **y축에 현재가 가격 태그**(원화 ko-KR 포맷)를 표시합니다. 라인·태그
  색은 **전일 대비 등락 방향**(상승 빨강 / 하락 파랑 / 보합·장전 중립)으로, 차트 위 Live
  Status Bar의 등락률 색과 항상 일치합니다(색 기준 `change_won ?? change_pct`). 과거로
  스크롤해도 라인은 현재가에 고정되고, 모든 타임프레임(분/일/주/월)에서 표시됩니다.

### Internal
- 현재가 라인은 캔들 시리즈 옵션을 건드리지 않고 별도 `createPriceLine`을 거는 `/live`
  전용 오버레이(`LiveCurrentPriceLine`)로 구현 — 제네릭 candle projector 순수성과 전역
  `priceLineVisible/lastValueVisible=false` 컨벤션을 보존합니다. 가격·색 산출은 순수 함수
  (`deriveCurrentPriceLine`)로 분리해 단위 테스트. 설계·검증 근거는
  `docs/superpowers/specs/2026-06-03-live-current-price-line-design.md`.

## [0.4.1.0] - 2026-06-03

### Added
- `/live` 캔들 호버 툴팁의 **시·고·저·종 각 행에 등락률(%)** 을 가격 옆에 함께
  표시합니다. 각 %는 직전 봉(이전 캔들) 종가 대비이며 상승은 빨강·하락은 파랑으로
  색칠됩니다(분/일/주/월 모두 동일 기준). 직전대비 행은 금액(원)만 남기고, 미세
  변동이 반올림으로 `+0.00%`가 되면 색도 중립으로 맞춥니다.

## [0.4.0.0] - 2026-06-03

### Added
- 스크리너 일봉 수정주가가 이제 KIS 정확 계수로 정합화됩니다(ADR-0057). 수정주가 =
  원주가(SSOT, append-only) × KIS 계수 테이블(`factors.parquet`)로 파생되어, 액면분할
  종목의 과거 봉이 today-basis로 정확히 소급 보정됩니다(거래량은 ÷계수로 거래대금 보존).
- `hoga screener-backfill` CLI — 1회성 백필: KIS 수정주가로 `factors.parquet`를 구축하고
  (resumable), 원주가를 KIS와 대조·결측 보충하며(reconcile), 구·신 수정주가 차이를
  `impact-report.json`으로 요약합니다.

### Fixed
- 액면분할 종목의 약 64%가 미보정이던 수정주가 버그(로컬 ±3% 휴리스틱이 카카오·삼성전자우
  등을 통째로 놓침)를 KIS 정확 계수 적용으로 복구. 절대 가격 레벨을 쓰는
  신고가·신고거래량·이동평균·등락률 스크리너 조건이 이제 올바른 값으로 평가됩니다.
- 가격대별 거래량 프로파일에서 상단 경계 빈이 누락되던 off-by-one과 상한가(폭 0) 종목에서
  발생하던 0-나눗셈 500 오류 수정.

### Changed
- 거래량 프로파일·호가비율·체결강도 SQL을 `tables/{candles,trades,snapshots}` 모듈로
  추출(ADR-0001). `bundle`은 경로·결측 가드·시간 재기준만 담당하는 코디네이터로 축소.

## [0.3.10.0] - 2026-06-03

### Added
- `/live` 차트에서 **캔들에 마우스를 올리면 그 봉의 정보를 툴팁으로 표시**합니다 —
  시·고·저·종, 직전 봉 대비 변동(금액·%), 거래량, 직전봉 거래량비(같으면 100%). 캔들(가격)
  페인 위에서만 뜨고 차트를 벗어나면 사라지며, 라이브 갱신 중에도 호버한 봉의 값이 실시간으로
  바뀝니다. 분/일/주/월 전 구간 동작하고, 설정에서 켜고 끌 수 있습니다(기본 켜짐). 등락 기준은
  앱의 등락률(전일 종가)과 달리 **직전 봉 대비**로 통일했습니다(ADR-0059).

## [0.3.9.0] - 2026-06-03

### Internal
- 종목 검색 코드 정리(동작·결과 불변). 프론트 `filterSymbols()` 정렬이 비교마다
  `toLowerCase()`를 재계산하던 것을 종목명당 1회 사전계산으로 바꿔 백엔드 `search()`의
  `key=` 의미와 일치시켰습니다. 백엔드 `search()` docstring의 'code-prefix' 오기재를
  'name-prefix'로 정정(정렬은 종목명 접두사 기준).

## [0.3.8.0] - 2026-06-03

### Changed
- 종목 검색이 **영문 대소문자를 구분하지 않습니다.** 예전엔 `CJ`·`KTcs`·`S-Oil`처럼
  영문이 섞인 종목명을 찾으려면 케이스를 정확히 맞춰야 했지만(`cj`로는 `CJ`가 안 나옴),
  이제 `cj`/`ktcs`/`s-oil` 어떤 케이스로 입력해도 매칭됩니다. 한글 종목명 검색과 숫자
  코드 검색 동작은 그대로이며, 백엔드 `/api/symbols`와 프론트 클라이언트 필터에 동시
  적용됩니다.

## [0.3.7.0] - 2026-06-03

### Changed
- `/live` 분봉 차트를 **왼쪽으로 끌어 과거 데이터를 부를 때** 빠르고 부드러워졌습니다.
  예전엔 줌과 무관하게 항상 42일치(~28거래일)를 한 번에 새로 받아 **한 번 끌 때마다
  ~32초** 멈췄습니다. 이제 **고정 3거래일씩 점진적으로** 받아 화면이 찰 때까지 채웁니다:
  어떤 줌이든 **첫 그림이 ~3.4초 안에** 보이고(latency cap), 넓은 구간은 3거래일씩
  여러 번에 걸쳐 채워집니다. 한 번 본 범위 재방문은 디스크 캐시로 즉시. 일/주/월봉은
  기존 one-shot 유지. (ADR-0059)

### Internal
- `/live` 좌측 팬 backfill + viewport 보존(prepend-restore shift, 진행 settle-loop,
  lazy-fetch trigger)을 `LiveChartRoot`에서 headless `useViewportBackfill` 훅으로 추출.
  동작 불변, locality 향상. 종료 판정·스텝 크기는 순수 함수(`planFillStep`/`stepChunkDays`)로
  격리 단위 테스트.

## [0.3.6.0] - 2026-06-03

### Fixed
- 차트 데이터 무결성: parser가 archive한 **series-level invariant 위반**(예
  `series.candles_ts_monotonic` — 캔들 `ts_ms` 중복으로 lightweight-charts `setData`가
  터지는 직접 원인)이 read-path에서 무시되던 결함을 고쳤습니다. 이제
  `classify_from_meta`가 `meta.json`의 archived `series.*` error를 INVALID 판정에
  반영해, 해당 Stock-Date를 `build_range_bundle`이 차트에 내보내지 않습니다. meta
  invariant는 여전히 live 재평가, series는 archived만 union(double-count 방지),
  parquet 재로드 없음(ADR-0020 §4.6 amendment). 수정 이전 archive의 false-positive는
  `hoga validate --fix` 1회로 정리.

## [0.3.5.0] - 2026-06-03

### Changed
- (내부 리팩터, 동작 변화 없음) `/api/live/past-daily-candles`(일봉)와
  `/api/live/past-investor-net`(투자자 순매수)의 near-verbatim 중복 핸들러를
  `batched_daily_walkback` 공유 orchestrator로 통합했습니다. 두 핸들러는 fetch
  클로저 + output key만 제공하는 얇은 adapter가 되고, gap/cache/today/dedupe 조립은
  한 곳에서 격리 단위 테스트됩니다. KIS 일별 walk-back의 커서 감산은
  `_prev_day_yyyymmdd` 공유 헬퍼로 추출(ADR-0060).

### Notes
- ADR-0061: source resolver 4개는 서로 다른 질문(데이터 읽기·inventory 표시·완성도
  state·존재 여부)에 답하므로 통합 거부 — 통합은 shallow abstraction이 된다는 근거 기록.

## [0.3.4.0] - 2026-06-03

### Fixed
- `/live` 보조지표 중 **호가비·호가총합·체결강도**가 마감 직전 종가 동시호가
  (15:20~15:30) 데이터를 계산에 끌어들이던 문제를 고쳤습니다. 15:20이 버킷 경계가
  아닌 타임프레임(3·15·30분봉)에서, 15:20을 가로지르는 버킷(예: 3분봉 15:18 봉)이
  대표값으로 15:20 동시호가 호가창을 집어 마감 직전 값이 튀었습니다. 이제 그런
  버킷은 **15:20 직전 마지막 호가 스냅샷**으로 계산되어 정확한 값으로 표시됩니다.
  과거 날짜(`/api/range`)와 당일 실시간(SSE) 양쪽 모두 적용되며, 반장일은 백엔드가
  그날의 실제 마감 시각을 기준으로 처리합니다. (ADR-0029 개정)

## [0.3.3.0] - 2026-06-03

### Changed
- 인벤토리 상세 테이블의 `Captures`(평생 누적 캡처 횟수 `×N`) 컬럼을 `재시도`
  (`fail_streak`) 컬럼으로 교체했습니다. 이제 각 종목·날짜가 차단(5회 연속 실패)까지
  얼마나 남았는지 한눈에 보입니다 — 정상은 `—`, 1~4회는 `N/5`, 차단되면 `차단됨`.
  평생 누적 `×N` 표시는 캡처 큐 화면에 그대로 유지됩니다.

## [0.3.2.0] - 2026-06-03

### Changed
- 스크리너 결과의 현재가·등락률을 전 종목 실시간(라이브)으로 표시합니다. 이전에는
  우측 패널이 상위 30종목만 라이브였고 `/screener` 전체 페이지는 전부 어제 종가
  기준이었는데, 이제 관심종목과 동일하게 모든 행이 현재가 기준으로 갱신됩니다.

### Fixed
- 장 시작 전·시세 파싱 실패 시 스크리너 등락률이 "어제 종가 기준값"으로 잘못
  표시되던 문제를 고쳤습니다. 이제 관심종목과 동일하게 "—"로 표시됩니다.

## [0.3.1.0] - 2026-06-03

### Fixed
- 완성 불가능한 종목-날짜의 무한 재캡처를 차단합니다. hogaplay 데이터가 장중에
  끊겨 매번 불완전하게 끝나는 (종목, 날짜)는 이제 5회 연속 실패로 집계되어 차단되고,
  인벤토리에 "차단됨 (5/5)" 배지와 "잠금 해제" 버튼이 표시됩니다. 이전에는 이런
  캡처가 매번 "성공(done)"으로 처리돼 재시도 카운터(fail_streak)가 리셋됐고,
  "모두 재캡처" 버튼을 누를 때마다 외부 서버에 무한히 요청이 나갔습니다
  (한진칼 2026-06-01에서 ×16 관측). 판정 기준은 인벤토리의 ✓(완전) 여부와 동일합니다.
- 데일리/캐치업 스케줄러가 차단된 관심종목 날짜를 조용히 건너뛰지 않고 경고 로그로
  알립니다 — 무인 캡처에서 빠진 날짜를 운영자가 바로 인지할 수 있습니다.

## [0.3.0.0] - 2026-06-02

### Added
- 관심종목 패널 드래그 재정렬. 우측 레일의 관심종목을 마우스로 끌어 순서를 바꿀 수 있습니다.
  행을 8px 이상 끌면 재정렬, 그 미만은 기존처럼 클릭(차트 점프)으로 처리돼 두 동작이
  충돌하지 않습니다. 드롭 즉시 화면이 새 순서로 바뀌고(낙관적 갱신, 실패 시 롤백)
  `PUT /api/watchlist/order`로 서버에 영속됩니다 — 순서는 전역이라 전체 페이지 목록과
  `catchup_all` 순회에도 반영됩니다. 서버 재정렬은 stale 코드에 관용적입니다(모르는 코드는
  무시, 언급 안 된 항목은 기존 순서로 뒤에 보존). 공유 `QuoteRow`는 선택적 drag props만
  받아 스크리너 패널은 영향이 없으며, 실제 포인터 드래그는 Playwright e2e로 검증합니다
  (ADR-0057 · ADR-0058).

## [0.2.0.0] - 2026-05-31

### Added
- 외국인·기관 순매수량 일봉 지표. `/live`의 일봉(D) 차트에 외국인/기관 순매수 수량을
  별도 패널로 그립니다 — 순매수(양수)·순매도(음수)를 부호 색으로 구분하고, 장기 구간은
  KIS 종목별 일별동향(FHPTJ04160001)의 date-cursor walk-back으로 채웁니다 (ADR-0055).
- Pane Legend 오버레이. 각 패널(캔들 이동평균, 거래량, 투자자 순매수) 위에 커서 시점의
  값을 실시간으로 표시합니다. 행의 ✕ 버튼으로 해당 지표를 끄고, eye 버튼으로 선을 숨길
  수 있으며, 지표 팝오버에서 각 지표의 상세 패널로 바로 이동합니다.
- 거래량 패널 on/off 토글과 이동평균 숨김(hide) 기능. 끈 패널은 차트에서 제거되어
  세로 공간을 돌려줍니다.

### Fixed
- 일/주/월봉에서 캔들을 호버할 때 `/api/brokers/series`로 불필요한 조회가 나가던 문제.
  커서 기반 브로커 조회를 분봉에서만 동작하도록 게이트했습니다 (ADR-0044 — 분봉 외에는
  per-cursor parquet가 없음). 사이드바의 spot 표시 게이트는 화면 표시만 막았을 뿐
  조회 자체는 막지 못했습니다.
- 거래량을 끄면 패널 자체가 사라지도록 수정 (투자자 패널과 동작 일치).
- 패널 인덱스가 밀려 series가 재생성될 때 데이터가 다시 채워지지 않던 문제.

## [0.1.1.0] - 2026-05-31

### Removed
- The off-hours `/live` banner ("장 외 시간 — 09:00 KST에 폴링이 시작됩니다"). Live
  polling is gated server-side by the trading-hours window (`poller.py:_should_poll_now`),
  so the banner never affected capture — it was only an always-on row outside market
  hours. The chart reclaims that vertical space when the market is closed. The status
  bar `LIVE●` reflects socket liveness, not market phase, so it stays green off-hours.

### Fixed
- Capture queue detail rows rendered an invalid clock (e.g. "31:13:21") for timestamps
  in the KST 00:00–08:59 window. The detail formatter now reuses the shared
  `unixMsToKSTClock` helper, which wraps the hour correctly.

### Changed
- Retired the now-dead minute-tick machinery behind the live banner state (the
  per-minute re-render timer and the KST-hour computation); no remaining banner cause
  depends on the wall clock.

## [0.1.0.0] - 2026-05-31

First versioned release. Captures the `feat+frontend5` work since the previous
merge to `main` (120 commits): the real-time `/live` experience, the watchlist
and Right Rail shell, and a pass of architecture-review refactors.

### Added
- **Single multiplexed WebSocket** for the frontend (ADR-0053): one `/api/ws`
  endpoint fans out both events and live snapshots, code-filtered, with
  automatic reconnect and a liveness watchdog that force-reconnects a silently
  dead socket. Honest connection-state surface (LIVE / stale chip + status dot).
- **Live chart**: adaptive KST x-axis via `createChartEx`, and viewport scale +
  position preserved across historical-prepend (no jump when older bars load).
- **Watchlist + Right Rail**: global rail chrome and Watchlist Panel mounted in
  the shell grid; active-symbol heart toggle; the live poller re-syncs to the
  watchlist immediately on add/remove (stops on empty, preserves the buffer).
- **Symbol search**: header inline search (`/` to focus) and a headless
  `useSymbolCombobox` hook (keyboard nav, highlight, dismiss-on-outside-click).
- **Page shell**: thin `PageContainer` frame with tokenized page padding;
  `--tint-success-border` / `--tint-error-border` design tokens.

### Changed
- Typed the live SSE/WebSocket payload contract end-to-end and the poller's
  `LiveSnapshot` builders; narrowed chart `SeriesSpec`/projector return types off
  `any` to the lightweight-charts vocabulary.
- Single-sourced duplicated domain rules: the Unix-ms → YYYYMMDD KST calendar-day
  conversion (`util/time`), the `first_*.tsv` page-layout contract
  (`collector/orchestrator`), and the Closing Auction Window length.
- Lifted inventory grouping + default-to-first policy to the page (`selectGroup`);
  extracted a single `FullCaptureCountBadge`; replaced the Optional timing
  collector with a `NullTimingCollector`.
- Adopted `PageContainer` across the capture, inventory, and watchlist pages;
  consolidated the capture-queue push subscription to a single owner.

### Fixed
- `candles.write_parquet` now writes atomically like its sibling tables (closes a
  torn-write window on the hot read-path parquet).
- `disk_state.classify_stock_date` returns the full `Classification`, dropping a
  second `meta.json` read on the hot decide-capture path.
- Corrected the Daily Scheduler fire-time docs (18:00 → 17:00 KST) and the false
  "drift caught by TypeScript" claim on the by-hand BE↔FE wire mirror (added a
  schema-diff guard test instead).
