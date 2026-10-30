# hoga-ops

호가 정보 거래량 비교(2026-10-30): 10호가·호가주문 정보의 `어제보다`는 오늘 누적
거래량/전일 전체 거래량×100, 클릭으로 전환하는 `동시간비`는 공급자의 같은 시장·
전일 동시간 누적 거래량 대비 비율이다. 둘 다 100%가 동일하며 증감률이 아니다.
동시간비는 키움 0B FID 851의 0.01% 정수를 서버에서 정규화해 전달한다.
ka10095에는 해당 필드가 없으므로 REST 일일 비율로 대체하지 않는다. 미제공은 대시다.

장전 시간외 종가 주문(2026-10-30): 호가주문창 맨 아래 좌우 총잔량 숫자의
더블클릭은 키움 실전 계좌와 당일 NXT 미지원이 확인된 종목의 장전 종가 주문을 접수한다. 주문 유형은 `PREOPEN_CLOSE`,
경로는 KRX, 키움 신규 주문 코드는 61이다. 적용 가격은 ka10001의 당일 기준가이며
ka10100의 종목·NXT 여부·전일종가를 확인한다. 실제 호가 신선도 대신 서버의 당일
가격·시간·계좌·주문 여력 검증을 사용한다. 기준가가 바뀌면 기존 입력 가격을 거절한다.
유형을 영속 보존해 지정가 가격정정·사다리 합계에 섞지 않으며, 총잔량 우클릭에서 장전
미체결 개별 취소를 제공한다. 사다리·기존 수량·프리셋은 유지하고 별도 모드 화면은 없다.
토스 OpenAPI는 해당 유형의 신규·조회가 미지원이다. 지원 여부를 지정가나 OPG로 대체하지 않는다.
거래일 미확인은 신규 주문을 차단하며, 특별 개장일은 `calendar/preopen_sessions.json`에
확인한 날짜별 시작·종료를 설정한다. 상세 운영 조건은 docs/kiwoom-trading.md 참조.

Single-user local tool that captures Korean stock orderbook + trade replay data from `hogaplay.com` and exposes it for analysis.

## Language

**내 매매 표시 (Account Executions)**:
차트 설정의 `매매내역 표시`를 켜면 국내 종목 일봉·분봉의 상단 도구줄에 `매매 계좌`가
나타난다. 차트별로 고른 계좌의 현재 Code에 대한 매매 위치를 B(매수)·S(매도)로 표시한다.
2026-10-30 후속 요청: `매매 계좌` 왼쪽의 `최근 매매`를 열면 선택 계좌의 최근 1년 매매
Code를 중복 없이 최신 매매일·체결시각 순으로 보여준다. 종목명·코드·마지막 매매일·체결시각을 표시하고
현재 Code만 강조한다. 시각 미제공은 빈칸·목록 뒤쪽이며 주문시각으로 대신하지 않는다.
목록을 연 동안 오늘 쿼리만 주기 갱신하고, 과거는 기간 쿼리의 추가 페이지를 하나씩 자동으로
읽는다. 계좌 전환·OFF에는 목록을 닫고, 종목 선택은 해당 창의 링크 그룹을 바꾸면서
선택 계좌·B/S 설정을 유지한다. 종목 고정 창은 고정 해제 안내와 함께 선택을 막는다.
1년 전 같은 날짜부터 오늘까지를 요청하며 윤년 2월 29일은 전년 2월 말일로 보정한다.
키움은 `kt00015`의 국내주식·매매·KRW·전체 거래소 기간 조회를 사용하고 `cntr_dt`를
매매일로 쓴다. `trde_dt`·`proc_tm`을 체결일·체결시각으로 대신하지 않는다. 토스는
OPEN/CLOSED 주문 페이지를 한 번씩 읽고 실제 마지막 체결일로 기간을 분류한다.
시각/매매일 확인 실패·조회 실패·조회 중을 매매 없음으로 처리하지 않는다. 팝업을 닫으면
진행 중 조회를 취소하고 완료 페이지는 탭 메모리에 유지해 다시 열 때 이어 읽는다.
완료된 1년 범위는 자동 재조회하지 않고 `새로 조회`로 초기화한다. 서버는 계좌·기간·
커서별 응답을 첫 페이지 3초·추가 페이지 300초 동안 메모리에 보관한다. 요청마다 계좌
권한을 확인하고 서명 커서는 계좌·기간을 묶는다. 증권사가 제공하지 않는 과거를 복원하거나
1년 전량 보유를 보장하지 않으며 이 목록을 개별 체결 원장으로 저장하지 않는다.
키움은 개별 체결 가격·시각, 토스는 아래의 주문 평균가·마지막 체결 시각 기준이다.
2026-10-29 후속 승인: 체결가 눈금을 제거하고 B/S 중심을 해당 봉의 가로 중심과 각
체결가의 실제 시리즈 가격 좌표에 둔다. 13px·500을 유지하고 캔들 폭 밖으로 글자가
나와도 압축·몸통 열 클리핑을 하지 않는다. 겹침을 허용하며 가까운 가격을 평균 높이로
묶거나 좌우/상하 이동·생략하지 않는다. 같은 봉·정확히 같은 가격·방향은 기존처럼 한
글자로 묶는다. 사용자 선택 2번의 20×20px·모서리 5px·선 두께 1.25px 둥근 사각형으로
감싸고 내부는 차트 배경색, 글자·테두리는 테마 매수/매도색을 쓴다. 사각형도 확대·축소에
크기를 유지한다. 글자·사각형 클릭은 그 봉의 모든 매매내역과 가격·시각 기준을 보여준다.
화살표·연결선·건수 접미사는 없다. 토글은 창별 표시 설정·되돌리기·
프리셋을 공유하지만 계좌 참조는 `hoga.chart.trade.accounts.v1`에 별도 보관해 새 창이나
프리셋으로 복사하지 않는다. 종목·일봉/분봉 변경과 OFF/ON에는 같은 창의 계좌를 유지한다.
키움 `kt00009`의 날짜별 개별 체결번호·체결 시각·가격·수량을 쓰며 주문 시간이나 주문 평균가로
체결을 추정하지 않는다. 당일은 15초, 과거는 화면 거래일별로 최근부터 순차 조회하고 128페이지
뒤에는 명시적 추가 조회를 제공한다. 토글 OFF·계좌 미선택에는 이력 요청을 하지 않는다.
2026-10-29: 과거 조회는 계좌·Code·가격 시장·거래일·커서별 페이지를 탭의 메모리에 유지한다.
완료된 빈 결과도 재사용하며 차트 이동·일봉/분봉 전환·계좌 복귀·OFF/ON에는 미조회 페이지만
최근 날짜부터 하나씩 추가 조회한다. 날짜 묶음 변경이나 5분 경과만으로 완료 페이지를 다시
읽지 않는다. 이동 시 진행 중 페이지만 취소하며 완료 페이지는 유지한다. 자동 조회는 보이는
범위에서 새로 받는 128페이지를 한도로 하고 `더 조회`로 이어간다. 같은 범위를 동시에 보는
창도 완료 페이지를 공유해 중복 호출을 막으며, 만료된 서명 커서는 실패한 날짜의 첫 페이지를 갱신해 복구한다.
오늘이 화면에 있는 동안만 기존 15초 갱신을 유지한다. 과거 메모리 캐시는 새로고침 시 사라진다.
계좌·Code·날짜·시장에 묶인 서명 커서는 서버 재시작 시 다시 조회해 복구한다. 확인된 체결은
서버 `trading/executions.sqlite3`에 계좌별로 보존하며 증권사의 과거 제공 범위 전체를 보장하지 않는다.
일봉은 표시 봉 종가/같은 날짜·시장의 원주가 종가로, 분봉은 캔들 응답의 수정계수로 좌표만
변환한다. 상세 목록은 실제 가격·수량·KST 시각이다. 대응 봉·계수가 없는 건은 따로 안내한다.
토스는 사용자 승인(2026-10-28)에 따라 주문별 평균 체결가·마지막 체결 시각에 B/S를 표시한다.
`basis=order_average`로 구분하고 상세에 `주문 평균가 기준`·마지막 체결 시각·평균 체결가·총 체결 수량을
명시한다. OPEN/CLOSED를 함께 조회해 부분 체결 후 취소도 포함하며 체결 없는 주문은 제외한다.
주문 생성일과 마지막 체결일이 다를 수 있어 주문일 필터 없이 페이지를 읽고 마지막 체결일로 분류한다.
같은 계좌·Code의 원본 주문 페이지를 거래일·시장 간 공유한다. 변하는 요약은 개별 체결 보존소에 저장하지
않으며 같은 주문의 누적 수량·평균가·마지막 시각은 ID를 유지한 채 갱신한다. 소수점 평균가도 보존한다.
_Avoid_: 시장 전체 체결창과 혼용; 평균가·주문 접수를 개별 체결로 표시; 미조회·조회 실패를 매매 없음으로 해석.

**복기 노트 (Daily Review Note)**:
상단 「복기 노트 작성」의 `/whiteboard`에서 날짜별로 글·차트·이미지·메모·도형·자유
그리기를 배치하는 사용자 문서다. 연필 선의 색·굵기와 선 전용 지우개·실행 취소를 제공한다.
하루 결론·잘한 판단·바꿀 행동·다음 원칙은 선택 템플릿이다. 기존 구조의 글·기록은
페이지 1에 한 번 펼치며 review 원문도 보존한다. 이후 캔버스 글은 원문에 역동기화하지 않는다.
페이지는 같은 캔버스의 프레임이며 변환 표시는 삭제된 프레임에도 남아 중복 변환을 막는다.
「오늘 작성」은 KST 날짜의 활성 노트를 이어 열고, 목록은 수정 시각과 무관하게 대상일
내림차순이다. 간단히/자세히는 마지막 선택을 기억한다. 사본·충돌 복구본은 별도 보존한다.
서버 `<data_dir>/whiteboards/` schema 2·revision·IndexedDB 초안 복구 계약을 유지한다.
읽기/수정·작성 완료·서버 저장은 별개다. 기존 schema 1 보드는 「기존 보드」에서 유지한다.
저장 학습뷰와 별개이며 과거 기간 재분석은 ADR-0157의 `/live?view=` 계약을 따른다.
_Avoid_: 복기 노트의 이미지가 시세에 따라 갱신된다는 표현; 캡처 시각과 복기 대상일의 동일시.

**화이트보드 (Whiteboard)**:
`/whiteboard`에서 이미지·메모·텍스트·도형·선·화살표·자유 그리기를 자유 좌표로
배치하는 사용자 문서다. 「복기 노트 작성 → 기존 보드」에서 열며 좌측 목록으로 여러 보드를
관리한다. 접속한 서버의 `<data_dir>/whiteboards/`가 정본이며 정수 revision으로
다른 창의 조용한 덮어쓰기를 막는다. 브라우저 IndexedDB에는 서버·보드·편집 창별
미저장 초안을 보관하고 성공한 저장 응답에 해당하는 초안만 정리한다.
이미지는 별도 불변 파일로 저장하고 보드 복제·휴지통에서도 보존한다.
차트의 「보드에 추가」는 실제 PNG와 Code·봉 주기·캡처 시각·종목 복귀 링크를
추가하며, 당시 화면을 보존한다. 종목 복귀 링크는 저장 기간 복원을 약속하지 않는다.
보드의 scene은 Excalidraw 소유이고 기존 종목별 Drawing과 별도로 저장한다.
_Avoid_: 보드를 Full Capture/저장 학습뷰로 부르기; 보드 이미지가 실시간 갱신된다고
표현하기; 서버 저장 전 브라우저의 마지막 입력까지 보존을 보장하기.

**Regular Session**:
The continuous-trading window of the KRX day, 09:00:00–15:30:00 (includes the closing single-price auction 15:20–15:30).
_Avoid_: "session" alone, "market hours"

**Data Window**:
The full span of data hogaplay returns for a stock-date, broader than the Regular Session. Includes pre-market single-price activity from ~08:40 and any closing-auction residuals. Outer bounds are the earliest and latest event timestamps in the captured TSV.
_Avoid_: "session" alone, "trading day"

**Code**:
A 6-character KRX ticker using ASCII uppercase letters and digits, e.g. `005930`,
`00088K`, `0000D0`. Strings, not integers — leading zeros and letters matter.
_Avoid_: "symbol", "ticker"

**Window Pin (창 종목 고정)**:
`/live` 워크스페이스 창 하나를 **링크 그룹에서 뗀** 상태. 핀이 걸린 창은 `groupSymbols[group]` 을 보지 않고 자기 슬롯(`WorkspaceWindow.pinned`)의 종목을 그리므로, 관심종목·히트맵·스크리너·검색 **클릭**으로는 바뀌지 않는다 — 클릭의 목적지(`activationTarget`)가 z순서 위에서부터 **핀 아닌** 첫 창을 고르고 그 창을 포커스로 올리기 때문이다. 바꾸는 문은 **그 창에 직접 드롭**하는 경로 하나뿐(`setWindowSymbol`). 창→종목 해석은 전부 `windowSymbolOf` 를 지나야 한다(직독하면 핀 창만 조용히 갈린다 — 구독 코드 집합 `liveOpenCodesKey` 가 그 사고의 최단 경로). 핀 슬롯은 종목이므로 `groupSymbols` 와 같은 규칙으로 **레이아웃 프리셋에 담기지 않고**, 딥링크 탭(`?code=`)은 하이드레이션에서 핀을 지운다(안 그러면 그 URL 이 죽는다). 전 창이 핀이면 클릭은 착지할 곳이 없어 토스트 + 「전체 고정 해제」로 알린다. ADR-0153.
_Avoid_: "창 잠금"/"boolean 자물쇠" (핀은 값을 든다 — 잠금으로 구현하면 같은 그룹의 형제 창 교체가 잠긴 창까지 바꾼다); "그룹 고정" (스코프는 창이다); 핀 창이 그룹 종목을 "무시하고 얼려 둔다"는 설명 (해제하면 그룹으로 되돌아온다 — 얼리기가 아니라 분리다).

**주요 지수 비교 창**:
`market-indices`는 코스피·코스닥·K200 등락률과 같은 링크 그룹 국내 종목의 당일
1분봉 종가를 함께 표시한다. 지수는 공통 등락률 축, 종목은 별도 숨긴 자동 가격 배율이다.
그룹·포커스·검색·드롭에 참여하며 종목 핀은 제공하지 않는다. 거래일·시간축을 공유하고
종목 가격은 지수 Y축 범위에 포함하지 않는다. 휴장·장전의 이전 거래일에는 그 날짜 종가를
조회하며 현재 틱은 제외한다. 국내 종목이 아니면 종목선만 숨긴다.

**Stock News Window (종목 뉴스 창)**:
`/live`의 독립 데이터 창(`kind='news'`). `windowSymbolOf`로 결정한 종목의 한국투자 뉴스
제목을 `/api/news/stock`으로 조회한다. 최신 또는 선택일 최대 40건이며 원문 URL·본문은
없다. 제공 종목코드 연결·제목의 종목명·그 밖의 조회 결과를 구분한다. 최신은 60초마다
확인하고, 새 기사가 있어도 사용자가 수용하기 전에는 읽던 목록을 바꾸지 않는다.
같은 종목·날짜 조회는 FE query와 BE 60초 메모리 캐시로 공유한다. 설정 누락·조회 실패·
정상 빈 결과를 구분하며 DART는 제외한다. ADR-0136의 사용자 승인 뉴스 예외(2026-10-11).
2026-10-28: 「종목 연결만」은 창별로 저장하고 종목·날짜 변경에도 유지한다. 새 창은
마지막 필터를 복사하지만 최신 조회·오늘 날짜로 시작하며 과거 날짜나 읽던 목록은
복원하지 않는다. 기존 창과 프리셋은 각자의 필터를 유지한다.
_Avoid_: 종목별 전체 기사/완결된 아카이브; 제공 코드만으로 기사 내용의 관련성을 확정하는 표현.

**LiveInstrument**:
The canonical subject model for the `/live` page: either a stock instrument (`{ kind: 'stock', code, label }`) or a representative index instrument (`{ kind: 'index', id, label }`). `activeInstrument` is the full subject; `activeCode` is only the stock-code projection used by older stock-only hooks. The stable subject key is `stock:005930` or `index:KOSPI`.
_Avoid_: overloading **Code** for indices; representing an index as a fake 6-digit ticker.
미국 일봉 확장(2026-10-18): `kind='us_stock'`, 거래소(`NASDAQ`/`NYSE`/`AMEX`)와
티커를 별도로 보존한다. 정본 키는 `us-stock:NASDAQ:AAPL`, 국내 `Code` 투영은
`null`이다. URL은 `?market=US&exchange=NASDAQ&symbol=AAPL`이다.
`NASDAQ_COMPOSITE`·`SP500`·`SOX`는 대표지수 ID이며 한투 REST 일봉을 사용한다.
미국 개별 종목은 키움 REST 일봉(USD·수정 전 가격)을 사용한다. D/W/M을 지원하며,
W/M은 실제 미국 거래일의 검증된 일봉을 집계한다. ISO 월요일·달력 월로 묶고 첫
거래일을 표시 앵커로 쓴다. 미조회 구간이 걸친 주·월은 완전한 봉으로 표시하지 않는다.
완료된 일봉까지만 반영하므로 현재 주·월은 진행 중 집계다.
가격 지표·드로잉·검색·관심목록·그룹/핀 복원을 공유한다. 미국 관심목록 키는
국내 자동 수집·WS 구독·히트맵 시드에 포함하지 않는다. `trading_date`가 정본이며
09:00 KST 타임스탬프는 일봉 표시용 가상 앵커다. 실제 미국 장시간을 뜻하지 않는다.
미국 지수 분봉 확장(2026-10-19): 세 지수는 한투 `FHKST03030200`의 최근 응답을
60초 REST 폴링으로 공유한다. 1/3/5/10/15/30/60분 및 기존 D/W/M을 지원하며,
미국 개별 종목 분봉은 아래 별도 키움 경로를 사용한다. 지수 분봉은 뉴욕 시각을 DST 적용 실제 epoch로
변환한다. 축·툴팁은 KST, `trading_date`·제공 범위는 뉴욕 기준이다. 국내 장시간·
동시호가 필터를 적용하지 않고 장후 보정도 보존한다. 다분 집계는 09:30 뉴욕 기준으로
정렬하고 잘린 시작·내부 시각 공백이 있는 버킷은 제외한다. 마지막 연속 버킷은 변경
가능하다. `minute_metadata`는 최근 원본 범위·확인 시각·지연 미확인·갱신 상태를
전달한다. 임의 과거 날짜 조회·좌팬 백필·기간 점프는 제공하지 않는다. 응답 날짜는
실제 표시 거래일이며 요청 범위 전체 조회 완료를 뜻하지 않는다. 메모리 최근 창만
유지하고 TTL/실패 재시도는 60초, 실패 시 마지막 정상 창을 보존한다. 영속 분봉
아카이브나 실시간/고정 지연 보장은 없다.
미국 개별 종목 분봉 확장(2026-10-19): 키움 REST `usa06011`의 원본
1/3/5/10/15/30/60분봉을 `/api/live/us-stock-minute-candles`로 조회한다. 거래소와
대소문자·밑줄 티커를 유지하고 USD·수정 전 가격·원본 거래량을 보존한다.
`cntr_tm`은 뉴욕 시각으로 해석하며 24~47시는 다음 달력일로 넘긴 뒤 DST를 적용한다.
원본 `bus_dt`가 `trading_date`이며 자정 이후의 실제 달력일과 다를 수 있다.
실조회에서 26:10 표기와 두 공급자의 60개 OHLC·거래량/KST 시각 일치를 확인했다.
공급자 원본 집계를 사용하므로 1분봉을 재집계하지 않는다. 정규장 밖의 원본도 보존하며
정확한 전체 세션·시세 지연은 미확인이다. 미국 종목·지수 차트는 분봉·일/주/월봉 모두
정상 상태의 상시 안내 배너를 표시하지 않고, 조회 실패·설정 누락·일부/빈 데이터처럼
대응이 필요한 상태만 안내한다. 앱은 요청당 최대 8페이지/800봉을
표시하는 최근 창이며 60초마다 갱신한다. `more_available`은 공급자의 연속조회 신호다.
사용자 후속 요청으로 좌팬·휠 과거 조회를 지원한다. 최초 최대 800봉 이후 서버가 발급한
종목/주기별 커서로 800봉씩 이어 붙이고, 최신 폴링은 과거 이력을 보존한다.
요청당 8페이지/12초·조작당 자동 3청크·브라우저 최대 51,200봉/과거 63청크로 제한한다.
과거는 자동 폴링하지 않고, 실패 시 기존 데이터를 유지하며 명시적 재시도를 제공한다.
서명 커서는 프로세스 수명 동안 유효하고 서버 재시작 시 새로고침 안내로 복구한다.
미국 지수 분봉은 기존 최근 스냅샷 범위를 유지한다. 임의 날짜 점프는 제공하지 않는다. 과거 보유 하한을 800봉으로 표현하지 않는다. 캐시는 거래소·티커·주기별
메모리 LRU 64개와 single-flight로 제한하며 실패 시 마지막 정상 창을 유지한다.
인접 영업일 세션은 서로 겹치지 않게 구성한다. 국내 API·WS·거래대금·호가 지표는
차단하고 기존 D/W/M은 별도 일봉 경로를 유지한다.




미국 지수 빠른 갱신(2026-10-23): 위 지수의 분봉·헤더·진행 중 D/W/M은 한투 최근
스냅샷을 공유한다. 당일 자료가 있는 뉴욕 평일 09:30~17:20은 2초, 그 밖은 60초이며
조회 예산 시간대이지 실제 장 상태/휴장일 판정이 아니다. 가려진 브라우저는 빠른
폴링을 멈춘다. 실패는 최대 60초 백오프하고 마지막 정상 창을 보존한다. 진행 중 당일
OHLC는 같은 응답의 검증된 전체 일중 값을 쓰며 완료 일봉 캐시/검증 구간에는 넣지
않는다. 같은 날짜의 완료 일봉이 우선하고 과거 전용 조회에는 최신 시세를 섞지 않는다.
WS 지수 틱과 거래소 대비 무지연은 확인하지 못했다. ADR-0136 개정 및 관련 설계/실측 참조.

미국 지수 일봉 전송 최적화(2026-10-24): D 조회는 첫 응답을 전부 받고, 이후 같은
조회 범위의 `daily_history_revision`을 보내 마지막 봉을 제외한 이력의 내용 해시를
대조한다. 같으면 `daily_history_unchanged=true`와 마지막 봉만 전송하고 FE의 전체
조회 캐시에 복원한다. 과거 정정·백필·날짜 전환으로 이력이 달라지면 전체 응답으로
바꾼다. 불일치 응답은 전체 조회 한 번으로 복구한다. 메타데이터와 기존 2초/60초
정책·KIS 캐시·국내 수집·미국 종목·다른 봉 주기는 유지한다. 영속 이력 캐시는 추가하지 않는다.

VIX 확장(2026-10-25): 사용자 요청으로 대표지수 `VIX`(VIX 지수)를 추가한다.
KIS `VIX` 코드의 실제 일봉 60개(날짜 커서 3페이지)와 최근 1분봉 102개를 확인했다.
기존 미국 지수의 D/W/M·1/3/5/10/15/30/60분봉·헤더·2초/60초 수요 기반 캐시와
일봉 이력 전송 최적화를 그대로 사용한다. 뉴욕 시간과 지수 포인트 소수점을 유지하고
국내 수집·구독·투자자 조회에서는 제외한다. 최근 분봉 창만 제공하며 VIX의 WS 틱,
장중 갱신 지연과 전체 거래시간은 이번 주말 실조회로 검증하지 않았다.

미국 개별주식 정규장 실시간 표시(2026-10-24): 일봉·분봉은 미국 전용 키움 FE
관측을 원본 REST 위에 반영한다. 같은 공급자 분 라벨에도 여러 가격이 오므로 수신
순번으로 고저종을 누적하고 초당 변경분을 공유한다. 일봉은 검증된 일중 시고저를
사용하며 오늘 REST 일봉은 완료 구간과 분리한 60초 캐시다. W/M은 기존 완료 일봉
집계를 유지한다. 분봉은 원본 시가·거래량을 보존하며 최신 정상 보정은 1페이지/60초,
긴 공백은 기존 최대 800봉 예산으로 보정한다. 과거 커서·현재 읽는 범위는 유지한다.
여섯 개 이상의 서로 다른 키 중 마지막 하나를 미국에 예약할 수 있지만 국내 저장·
열람·계좌 이벤트와 지수 예약 슬롯이 우선한다. 국내 수요를 줄여 미국을 허용하지 않고
실행 중인 국내 연결도 빼앗지 않는다. 장외 FE·AMEX 실수신·전체 거래소 대비 지연은
미확인 범위를 유지하고, 미국 관측은 메모리 표시용으로만 사용한다. ADR-0136 개정.

**Representative Index**:
A fixed `/live` index instrument backed by KIS domestic index APIs. The enabled set is KOSPI, KOSDAQ, KOSPI200, KOSDAQ150, and KRX100; KRX300 stays disabled until a usable KIS index code is confirmed. Representative indices can show candle and volume data but cannot show orderbook-derived panes. KOSPI/KOSDAQ may additionally show market-level foreign/institution net-buy data; narrower indices must not borrow broader-market investor data.
_Avoid_: "index stock", "synthetic Code", or applying hoga/quote-derived indicators to indices.

지수 차트 제목줄(2026-10-22): `index-header-quote`는 차트 커서·봉 주기와 독립된
최신 지수값·전일 대비 등락률·전일 종가를 제공한다. 국내는 시장지표 바의 키움
TTL 캐시와 WS 표시 캐시를 공유하며, 거래일은 마지막 정상 조회 시점의 국내 달력
기준이다. 달력 범위 밖에서는 거래일을 추정하지 않는다. 미국은 기존 KIS 최근
1분봉과 완료 일봉 캐시를 공유하며 뉴욕 거래일을 보존한다. 같은 날짜의 완료 일봉
종가가 우선이고, 전일 종가는 검증된 직전 구간에서만 고른다. 일봉의 가상 표시
앵커를 시세 시각으로 표시하지 않는다. 실패는 마지막 정상값과 분리해 재시도를
제공하며, 지수 전환 시 이전 지수의 값은 표시하지 않는다.

국내 지수 캔들 실시간 표시(2026-10-22): 기존 `market_sector_tick`의 지수값·관측
시각을 KOSPI·KOSDAQ·KOSPI200·KOSDAQ150별로 모아 마지막 분봉과 진행 중인
D/W/M 봉에 표시한다. 기존 1초 묶음 전송을 재사용하며 새 WS 구독을 만들지 않는다.
관측한 가격만으로 고가·저가·종가와 새 분봉을 만들고, 미관측 분의 봉이나 거래량을
추정하지 않는다. REST의 시가·거래량·거래대금은 보존하며 새 관측 봉의 거래량은
REST 도착 전까지 0이다. 60초 REST 조회·캐시는 유지해 누락 구간과 완결된 봉을
보정한다. 조회 도중 들어온 최신 관측은 응답 위에 다시 반영하고, 실패 시 기존
관측을 유지한다. 관측은 지수별 당일 정규장 최대 391분·초당 한 표본으로 제한하며
다음 관측 거래일에 초기화한다. KRX100은 확인된 실시간 코드가 없어 기존 REST
방식을 유지하고, 미국 지수와 과거 전용 조회 범위에는 이 관측을 섞지 않는다.

**activeCode**:
The stock-only **Code** projection of the current **LiveInstrument**. `useLivePageStore.activeInstrument` is the canonical `/live` subject; `activeCode` is a compatibility field for stock-only hooks and is `null` for **Representative Index** charts. `/live` is a **single-view** page (ADR-0113 removed the multi-tab strip): `useLivePageStore.projectActiveView` is the single writer of the subject (surfaced through `live/liveNavigate.ts`'s `activateLiveInstrument`/`activateLiveCode`): selecting a stock or index in the header search, clicking a row in the **Watchlist Panel** / **Screener Panel** / **Heatmap** (which also navigates to `/live` if elsewhere), or **dragging a Watchlist or Screener Panel row onto the `/live` chart** all **replace the current view's subject in place** (`timeframe` kept, pan reset). A `/live?code=` or `/live?index=` deep link seeds the subject one-shot on first load; with no deep link the restored subject (`live.page.v1`) is normalized to a fresh view (store writes thereafter always win). Distinct from the **Watchlist** (a set of Codes) — activeCode is one selected stock projection, not a saved list.
_Avoid_: "selected ticker", "current symbol" (use **Code** vocabulary); conflating with **Watchlist** (list vs single active view).

**저장 학습뷰**:
A user-named saved entry for one **Code**, recording a period rather than a picture — see **복기뷰** for the fields. It is opened from the Right Rail's 저장뷰 panel **into a `/live` chart window** (ADR-0157): the click sets that window's symbol and then its **saved-range slot**, and the chart is seated at the saved period. There is **one open saved view at a time** (`livePage.savedRangeFocus`, non-persisted); opening another replaces it in place. Ctrl/⌘-clicking a row opens the same view in a **browser** tab via the `/live?view=` deep link and leaves this tab untouched. The Right Rail 저장뷰 panel organizes entries into **저장뷰 그룹**, chosen by the user. Memo and name are edited inline in that panel.
_Avoid_: "캡처" (this saves study context, not a market-data collection job), "study tab" / "저장뷰 탭" (tabs mean browser tabs), or wording implying a separate `/study` page.

**저장뷰 그룹**:
A user-named collection of saved study views. One saved view belongs to one group; a group may contain different Codes and multiple independently saved periods of the same Code, including identical periods with different notes. Empty groups remain available. Moving a view changes its group while preserving its saved period. Group counts count saved views, not unique Codes.
_Avoid_: automatic grouping by Code; conflating these groups with Watchlist groups or chart link groups; deduplicating saved views by Code or period.

**복기뷰 (Reference Study View)**:
The **only kind** of **저장 학습뷰** (`schema_version: 2` — the sole value on both sides of the wire). It stores one **Code**, **Timeframe**, saved period, viewport zoom/scroll, memo, and tags so the chart can reload that period and analyze it with the current **공용 지표 셋업 (Shared Indicator Setup)**. Reproducibility means "the same saved period", not "the same indicator output" (ADR-0077, upheld by ADR-0157). The window it opens in is **pinned to KRX** regardless of the global venue selector (ADR-0144), and shows a 「KRX 기준」 chip because that differs from the global choice.
_Avoid_: "snapshot", "fixed view", "captured chart"; saying it restores saved indicator state; calling it "v2" as if a v1 still existed.

저장뷰 분봉 부분 보충(2026-10-27 사용자 승인): KRX 저장 구간은 로컬 봉의 실제
시각과 날짜별 세션 경계를 비교해, 빈 날짜뿐 아니라 날짜 안의 선행·내부·후행 공백도
키움 분봉으로 확인한다. 공백은 조회 후보이며 무체결이나 수집 실패를 확정하지 않는다.
기존 로컬 봉의 OHLCV를 보존하고 없는 표시 버킷에 공급자가 제공한 봉만 추가한다.
거래량 0인 원본 봉도 유지하며 가격·거래량을 추정하지 않는다. 수정계수 불일치·미확인
날짜는 기존과 같이 제외한다. 같은 날 부분 보충은 저장뷰 칩으로 알리고, 기존 호가
지표는 보존하되 보충 봉에 호가 지표를 생성하지 않는다. 조회 예산·메모리 캐시·당일 제외·
HogaPlay 전용 모드의 디스크 전용 계약은 유지한다. 과거 하루짜리 저장뷰의 보충 기준일은
저장 끝일이 아니라 실제 KST 오늘이며 최초 구간 배치는 보충 후 한 번 적용한다.

**신고가 음봉 시가선**:
국내 종목 일봉에서 당일 고가가 직전 N거래일 고가를 초과한 다음 날부터 조건 음봉을
찾는 가격 오버레이다. 음봉(close < open), 저가의 전일 종가 대비 설정 하락률 이상,
종가의 SMA5 미만을 같은 봉에서 모두 만족해야 한다. 동일 고가는 갱신이 아니며
신고가 당일은 제외한다. 새 신고가는 탐색 개수를 초기화하고 이전 선은 보존한다.
기본 N=200, 하락률=7%, 음봉=1개(1/2), 우측 확장=6개월이다. 선은 발생 봉의 시가에서
설정 개월 뒤의 같은 날짜까지 표시하며 월말은 도착 월 말일로 보정한다. 실제 이력은
종료일 이전 마지막 봉까지, 이후 여백은 기존 그리기의 FutureBand 좌표 규칙으로 투영한다.
마감 판정은 KRX 15:30·NXT/통합 20:00이며 진행 중인 일봉을 포함하지 않는다.
창별·일봉 버킷·반복 인스턴스·프리셋의 기존 지표 저장을 공유한다.
_Avoid_: 거래일 6개월 환산; 저가 대신 종가 하락률 적용; 이전 선을 새 신고가에서 삭제;
신고가 발생 봉에 선 표시; SMA5에서 당일 종가 제외; 조회 전 전체 이력을 보장하는 표현.

**공용 지표 셋업 (Shared Indicator Setup)**:
The current analysis indicator setup. It is **not owned by a saved study view**: opening a 복기뷰 reloads the saved period and re-analyzes it with whatever this setup currently is. Since #699 (PR-A/PR-B) the **entire** setup — every drawer-visible toggle, parameter, and color — is profiled per **LiveTimeframe** group (초봉 / 분봉 / 일봉 / 주봉 / 월봉, 5 sparse buckets over factory defaults), and since ADR-0152 each chart window carries its own set. Storage is split across two blobs: indicator fields in `live.indicators.v2`, and drawer-visible chartPrefs sub-options (indicator-modal keys) in `hoga.chart.prefs.v1` under `indicatorModalByTimeframe`; chart-wide chartPrefs stay flat/global. The chart's current timeframe is the lookup key. The **page axis** (`IndicatorPageScope`) still exists in those blobs but has only one inhabitant since ADR-0157 — the `study` buckets are legacy data no surface writes to.
같은 종류를 여러 개 추가한 항목은 `indicatorInstances`에서 각자의 설정·표시 상태·지표 전용 prefs를 소유한다. 기존 flat 필드는 첫 항목이며, 원본 시세 수요는 활성 항목들의 합집합이다.
_Avoid_: saying a **복기뷰** restores or stores indicator state; treating the `study` bucket of `IndicatorPageScope` as a live axis.

초봉 공통 분석 도구 확장(2026-10-25): 국내 주식 1·5·10·30초는 `seconds` 지표
버킷을 공유하며 `minute`과 독립적으로 저장한다. 창별 지표 설정·추가 항목·스타일·
숨김·삭제·초기화와 드로잉·캡처·레전드·패널 조절을 분봉과 같은 표시 경로로 사용한다.
지원 지표는 관측 OHLCV 기반 이동평균선·볼린저·엔벨로프·슈퍼트렌드·거래량이며
분봉·일별 원천을 초 단위로 보간하지 않는다. 초기 최근 관측 240봉·별도 원천·
과거 탐색과 호가·매물대 커서 연결은 유지한다. 패널 높이는 `seconds` 프로필로
분리하고 순서·병합·축 모드는 공용이다.

초봉 구간 분석 확장(2026-10-25 후속): 분봉 화면 오른쪽 봉 또는 측정 도구의 선택
구간을 같은 그룹·Code의 초봉 창으로 연다. 일치하는 창을 재사용하고 다른 고정
종목은 교체하지 않는다. 선택 기간을 직접 조회하고 관측이 없는 초를 만들지 않는다.
초봉도 현재 가시 기간·주기·뷰포트를 저장 학습뷰로 저장하며, 드로어와 `/live?view=`는
저장된 초 주기로 복원한다. KRX 고정·현재 지표 설정 재분석 계약은 동일하다.
원본의 방향별 1초 가격 셀이 있을 때만 매수·매도 체결량을 초봉 체결강도로 집계한다.
방향 미확인·단일가 체결은 제외하며 당일 누적선은 제공하지 않는다. 초 단위 호가·
프로그램은 추정하지 않는다. 초봉 저장은 hogaplay 누락 수집을 요청하지 않는다.

초봉 주기 전환(2026-10-25 후속): 과거 화면에서 1·5·10·30초를 바꿔도 가시 구간의
실제 양 끝 시각을 새 봉 경계로 옮겨 읽던 기간을 유지한다. 봉 개수는 새 주기에 맞춰
바뀌며 밤·휴일 공백은 관측 인덱스로 처리한다. 전환 위치는 창별 일회성 런타임이고
저장 설정·레이아웃에 포함하지 않는다. 종목·시장 변경에는 승계하지 않으며 새 구간
명령이 우선한다. 범위를 제한해 읽은 과거의 마지막 봉을 실시간 최신 봉으로 간주하지 않는다.

초봉 날짜 구분선(2026-10-25): 분봉과 같은 거래일 경계 점선을 사용한다. 새 거래일의
첫 관측 봉에 서며 캔들·거래량·보조지표 패널에 이어진다. 색·1px 두께와 팬·줌 중
캔버스 렌더링은 공통이고 D/W/M은 제외한다.

초봉 연속 자동 채움(2026-10-25 후속): 팬·축소 후 왼쪽 부족분과 기존 50봉 여유를
한 번의 목표로 고정해 이전 구간·저장 거래일을 순차 조회한다. 실제 prepend한 축 슬롯만
목표에서 차감하며 빈 페이지·폴링·복원 이벤트가 목표를 늘리지 않는다. 데이터 끝·64페이지·
조회 오류·선택/저장 구간 시작에서 중단하고 수동 추가 조회·실패 페이지 재시도를 유지한다.
응답 직전의 읽던 시각·픽셀 위치·배율을 보존하므로 대기 중 팬·줌도 유지한다. 최초 240봉은 그대로다.


**엔벨로프 (Envelope)**:
가격 차트 위의 보조지표. 선택한 기준가의 후행 N봉 단순이동평균을 중심선으로,
상단은 중심선 × (1 + 이격률/100), 하단은 중심선 × (1 − 이격률/100)로 표시한다.
기본값은 종가·20봉·±2%이며 완전한 N봉이 쌓인 시점부터 그린다. 기간 1~400봉,
이격률 0.1~100%, 기준가·선 색상·공통 두께·개별 선 표시를 설정한다.
분봉·일봉·주봉·월봉과 가격 전용 차트에서 공용 지표 셋업의 창·봉별 저장 및
독립 항목 반복 추가·숨김·삭제 취소·커서 레전드를 공유한다.
_Avoid_: 표준편차 밴드(볼린저 밴드와 계산식이 다르다); 이격률을 가격의 절대 차이로 해석.

**Pane 크기 가중치 (Pane Stretch)**:
The user-owned relative height weight of each chart pane kind (candle, volume, 호가비, …) inside the `/live` chart, adjusted by dragging the pane separator. It has five **LiveTimeframe** profiles (`seconds` / `minute` / D / W / M): all seconds intervals share one profile and all minute intervals share another, while daily, weekly, and monthly charts retain independent proportions. The profile is global across chart windows — it is not window-owned. It lives beside pane order in the persisted indicator slice and travels with layout presets; applying a legacy flat preset seeds all five profiles equally. Like pane order (layout, not indicator config), it is treated as user-owned layout: the indicator drawer's "기본값 복원" **preserves** it, and only the preset menu's "기본 레이아웃으로 초기화" restores the spec defaults. A pane kind the user never dragged keeps its spec default weight. ADR-0172.
_Avoid_: "pane height" in pixels (weights are relative; pixel height is derived), "per-window pane sizes" (profiles are shared by timeframe family), "separator position" as the stored state (the separator is chrome; the stored state is the adjacent panes' weights).

**Stock-Date**:
The unit of capture and storage: one (Code, YYYYMMDD) pair. All paths and queries are scoped to a Stock-Date.

**Page**:
One `first.php` HTTP response. Bounded in size (~500–1000 events). Multiple Pages cover one Stock-Date's Data Window.
_Avoid_: "chunk", "batch", "section" (overloaded — see TSV Section below)

**Full Capture**:
The union of all Pages for one Stock-Date, deduplicated. The artifact the collector must produce before the parser runs.

**Full Capture Count**:
The number of times a **Full Capture** has been successfully written to meta.json for one **Stock-Date**. Persisted as `full_capture_count` in the meta.json file and surfaced on the wire as `StockDate.full_capture_count`. Counts every successful (re-)write — including those reached through one or more **Retry** attempts — but never failed or skipped runs. Initial capture = 1; each subsequent successful Retry = prior + 1; legacy meta files without the field report `null`. The **Capture Queue** UI renders `null` as `×1` (visually identical to a real `×1`) on the basis that any Stock-Date on disk has been captured at least once — the lower bound is honest, and the tooltip reveals the legacy distinction. (The inventory detail table no longer shows this `×N` column; it surfaces **fail_streak** in a **재시도** column instead.) Distinct from `attempt` (ADR-0031), which counts Retry operations within a single capture run and lives only in the **Capture Queue**.
_Avoid_: "capture count" alone (ambiguous with `attempt`); "retry count" (every count includes the initial capture, not a retry).

**TSV Section**:
The first field of every row in a Page's TSV (`1` = events that occurred before the requested `time`, `2` = events from the requested `time` onward). A presentation marker dependent on the call's `time` parameter — *not* an intrinsic property of an event. The same event can appear as TSV Section 1 in one Page and TSV Section 2 in another with all other fields identical (verified 2026-05-19). Dropped during parsing.
_Avoid_: "section" alone (ambiguous with Regular Session, Page)

**Global Sequence (global_seq)**:
Field 4 of every event row. Strictly increasing per-Stock-Date counter across all event types. The dedup key when merging Pages into a Full Capture: verified unique-within-Page and stable-across-Pages.

**Page Step**:
The increment applied to the `time` query parameter between successive collector calls. Variable, not fixed. Default 60000ms (1 minute) matching hogaplay's UI step; collector halves the step (30s, 15s, ...) when a response fails to cover the requested window — indicating the response cap was hit before reaching `time + step`. A stagnation guard (ADR-0017) terminates the loop if `max_event_time` and `new_seqs` both fail to advance for `MAX_STAGNANT_PAGES` (200) consecutive iterations — protecting against hogaplay response freezes that would otherwise loop forever in the cap-hit branch.

**Auction Cross**:
A trade matched via a call auction (단일가 매매), not continuous trading. Occurs at the open (~09:00:00.000), the close (~15:30:00.000), and pre-market single-price periods. Recognizable in the trade schema by **absence of `+`/`-` sign** on the qty field (event type 1) OR by being an event type 3 row (single-price summary, used for both opening and closing auctions — confirmed in production 2026-05-20). Stored as `side = 0` (distinct from continuous-trading `+1` buy-aggressor / `-1` sell-aggressor). Excluded from CVD, aggressor-based metrics, and `cum_vol` monotonicity validation (`side=0` rows carry `cum_vol=0`).
_Avoid_: "auction trade" alone, "opening trade", "closing trade"

Multi-**Stock-Date** generalisation: each **Stock-Date** in a **Stock-Date Range** has its own opening Auction Cross (~09:00:00) and its own closing **Auction Window** + closing Auction Cross. Frontend consumers must compute the closing-auction threshold per segment from the observed **Single-Price Book Signature**, not from a single global `session_open_ms`, a fixed 15:20 wall clock, or a fixed "10 minutes before close" rule. The wire surfaces session bounds implicitly: each `RangeBundle.segments[i]` carries its own `session_open_ms` / `session_close_ms`.

**연속체결 매물대 분포 (Continuous Trade Volume Distribution)**:
A per-**Stock-Date** sidebar readout that bins continuous-trading trade quantity by price range. Its price grid comes from the Stock-Date's candle low-high range; its quantity comes only from continuous-trading trade ticks (`side = ±1`) from session open until just before the first trailing **Single-Price Book Signature** of the closing **Auction Window**; **Auction Cross** rows (`side = 0`), single-price auction summaries, and any `side = ±1` ticks after that structural boundary are excluded. In the default mode, hover time only positions a visual cursor marker; in **호버 시점 누적 매물대**, hover time also caps which pre-structural-boundary trades are counted in the bars. Distinct from **Volume Profile**, whose existing query intentionally includes `side = 0` rows. For the `kis_live` Source, the required quantity artifact is `trades.parquet` generated from 10-second price-grouped `kind="trade"` Live Snapshots; `fills.parquet` does not contain price and cannot reconstruct this readout.
_Avoid_: "regular-session volume profile" (Regular Session includes auction phases), "volume_profile_by_day" (existing all-side field), "cursor cumulative volume" without saying whether it means **호버 시점 누적 매물대**.

**호버 시점 누적 매물대 (Hover-Cutoff Volume Distribution)**:
An optional **연속체결 매물대 분포** mode where each bar counts only continuous-trading trade quantity at or before the current candle hover time.
_Avoid_: using this term for the default full-Stock-Date distribution.

**보이는 최신 시각 기준 (Visible Time Cutoff)**:
A viewport-relative indicator basis where a daily readout is recalculated only from market-data candidates observed at or before the rightmost visible candle's timestamp, so scrolling into history answers "what was known by the end of what I am looking at."
_Avoid_: hover-based cutoff, full-day peak, latest live tick.

**Auction Window**:
The period leading up to an **Auction Cross** during which limit orders accumulate but no continuous price discovery happens. KRX has two within the Regular Session: the closing **Auction Window** resolves with a cross at the session close, and its observed start is identified by the first trailing **Single-Price Book Signature** rather than a fixed wall-clock time. The opening Auction Window (pre-market, part of the Data Window) is symmetric. **Snapshots are present and meaningful during an Auction Window** — bid/ask quantities at each level accumulate visibly. Trade ticks during or after the structural closing-auction boundary are not continuous-trading signal for hoga-derived readouts such as **연속체결 매물대 분포**. By default (global `auctionWindowMask` toggle, on), **all chart indicator panes other than CandlePane and VolumePane are visually suppressed during the closing Auction Window** — RatioPane (호가비), QuoteTotalsPane, FillStrength (histograms + Cumulative Net Fill) all hide their data points and break their lines at the closing-auction boundary (see ADR-0029). Earlier behaviour masked **호가비** values to 0 and rendered Quote Totals as raw accumulating levels; the unified "hide" semantics replaced both because the value-0 plateau and the one-sided accumulation curve both read as misleading signal to typical analysts. CandlePane and VolumePane are deliberately untouched — see ADR-0018 (candle) and the candle/volume carve-out in ADR-0029.
_Avoid_: "auction period", "auction phase", "auction time" (all overloaded)

**Single-Price Book Signature (단일가 호가창 구조)**:
A KRX market-microstructure fact: during any **single-price auction** phase — the opening auction, the closing **Auction Window**, and an intraday **Volatility Interruption (VI, 변동성완화장치 단일가)** — the published orderbook collapses from 10 visible levels to **exactly 3 per side**; levels 4–10 read `0` (snapshot columns `ask_q4..ask_q10` / `bid_q4..bid_q10` all zero). Continuous trading shows the full 10-level book. This signature marks single-price phases **independently of wall-clock time**: the continuous→auction transition is *not* pinned to 15:20:00.000 (observed 15:20:01.xx, varying ±seconds per Stock-Date and code), which is why a fixed-time boundary mis-slices the tail bucket and leaks 3-level totals into the last continuous bucket. Empirically (captured corpus): every intraday 3-level *run* is a sustained VI single-price period — never a thin continuous book (cross-stock: all runs length ≥10, zero singleton flickers). The closing single-price cross trades `side = 0` (excluded from **FillStrength**, so it is immune). The closing **Auction Window** boundary for hoga-derived readouts is detected as the first trailing single-price book after the final continuous-book snapshot at/before the day's close, rather than the 15:20 clock or `session_close - 10min`; see `docs/superpowers/specs/2026-06-03-auction-structural-boundary-design.md`.
_Avoid_: "3호가" alone (ambiguous with a 3-tick price spread); say "3-level book" / "단일가 호가창 구조" for the collapse, "VI" for the intraday single-price case.

**Auction Mask**:
The composite UI state that gates whether an indicator visualization should be suppressed at a given moment. Active iff (1) the global `auctionWindowMask` toggle is `true` AND (2) the current **Cursor** (or per-point `t`) falls inside the closing **Auction Window** (per `VirtualAxis.inClosingAuctionWindow`). The toggle alone is _intent_ ("mask when applicable"); the mask is the _activated decision_ for a specific moment. **The rendering action varies by consumer**, not by the predicate: chart pane projectors (RatioPane, QuoteTotalsPane, FillStrength) emit each in-window point as `WhitespaceData` (no `value` field) — the line breaks naturally at the first whitespace AND the bar-index time scale keeps a mappable position at every in-window minute, which is load-bearing for the `AuctionWindowOverlay` band's `timeToCoordinate` lookups at `auctionStart` and `sessionClose`. Dropping in-window points entirely would shrink the chart's visible range past the auction window, hiding the highlight band as a side effect. Spot views (`BookPanel`'s 총잔량 스트립, fed by `DataWindow`'s `maskRatio`) replace the bar fill with a flat masked strip instead. The spot-view decision does **not** go through the axis: `DataWindow` evaluates `isClosingAuction(toSessionSegments(link.bundle.segments), cursorMs)` against the linked chart window's bundle, because a global axis singleton is last-writer-wins across multiple windows and therefore wrong (the old `useLiveAxisStore` / `useAuctionMaskActive` pair lost its consumers this way and was deleted 2026-07-29). Series projectors inline the 2-line check `mask && axis.inClosingAuctionWindow(p.t)` per point instead — there is no shared helper module, because the inline check is shorter than any abstraction's contract. CandlePane's "muted color from 15:20 onward" rule and VolumePane both deliberately do _not_ participate in the Auction Mask — see ADR-0018 (candle) and ADR-0029 (the candle/volume carve-out for the unified hide semantics). They share only the predicate with the Auction Mask; the action is different.
_Avoid_: "mask" alone (overloaded with any UI hide rule); "auctionWindowMask" used to mean the activated state (that name belongs to the underlying toggle, not the derived decision); "mask to 0" (legacy phrasing — chart panes now hide, not zero).

**라이브 호가 보조지표 — 과거/당일 분리 캐시 (Past/Today Split Cache)**:
The per-SSE-tick projection strategy that keeps `/live`'s hoga indicator panes (호가비 / RatioPane, 총잔량 / QuoteTotalsPane, 체결강도 / FillStrength) cheap during deep historical scroll. A live tick (150ms throttle) only mutates *today*'s last bucket, but the naive projector re-projected the WHOLE past+today `points` array every tick — measured at 36ms/tick (244ms/sec) at the 90-day minute clamp, a deep-scroll render regression. The split freezes the past projection (intraday-immutable — past points change only on the 5-min `/api/range` refetch or a leftward pan) and re-projects ONLY today's segment per tick, then concatenates, making per-tick cost independent of history depth (~33×, #56 P0). The correctness contract is **byte-identity**: `cachedPast ++ project(today) === project(all)`, enforced per projector by `pastCachedProjector.test.ts` (incl. masking, day-boundary, zero-anchor, ctx-invalidation cases). The five **point-independent** projectors (호가비, 총잔량 bid/ask, 체결강도 buy/sell histograms) share one factory `makePastCachedProjector` (`chart/projectors/pastCachedProjector.ts`); the **Cumulative Net Fill** line cannot — its runningSum depends on every later emit in its segment, and the closing-**Auction Window** anchors interleave temporally with live points — so it has a deliberate segment-granular twin `makeCumulativeCachedProjector` (`chart/projectors/fillStrength.ts`). That fork is **essential, not a leak**: separate cache shells also CONTAIN a per-tick bug to one indicator instead of all six. The split boundary is a *day* boundary, so the **Auction Mask** (ADR-0029, 15:20 sits inside today) is untouched by it. The cache's reference stability is load-bearing downstream: `seriesDataDiff`'s `a === b` fast-path short-circuits precisely because the cached past array keeps the same reference across ticks. The backend has a structural twin — the `kis-past-indicators` disk cache keyed by (**Code**, **Stock-Date**, source) — applying the same "past is immutable" principle to `/api/range` so a re-pan reads cached 1-minute 호가비/체결강도 rows and re-aggregates up, instead of re-bucketing the raw snapshots parquet (ADR-0040 candle/indicator-cache symmetry).
_Avoid_: "memoization" alone (it is a domain-specific past/today split, not generic memo); conflating the frontend per-tick projection cache with the backend `kis-past-indicators` disk cache (same principle, different layer — name the layer); "the projector cache" as if one mechanism (point-independent and cumulative are two factories, by design).

**일봉 이동평균선 (Daily MA)**:
일봉 종가로 계산한 `SMA(close, period)`를 **분봉(intraday) Virtual Axis에 거래일 단위로 계단 투영**한 가격선 차트 오버레이(`DailyMovingAverageOverlay`). 각 분봉 캔들은 자기 소속 **Stock-Date**의 일봉 MA값을 받아 하루 내 평평하고 **Day Boundary**에서 점프한다 — 이 모양이 **거래일 계단 (day-anchored step)**. 진행 중인 오늘은 마지막 분봉 close를 그날 종가 프록시로 써 장중 갱신(과거일은 확정값). 일봉 데이터는 `/api/live/past-daily-candles`(ADR-0048)를 분봉 프레임에서도 독립 fetch하되 `useLiveBundle` 밖 self-contained 오버레이로 격리해 **Past/Today Split Cache**·번들 split invariant를 보존한다(분봉↔calendar 데이터경로 split을 가로지르는 근거는 ADR-0073). **세 MA 개념을 구분**: ① **일봉 이동평균선**(이 항목 — 상위TF→하위TF 투영 가격선) ② **이동평균선**(현재 **Timeframe** 봉 기준 SMA 오버레이, ADR-0046 `MovingAverageOverlay`) ③ Screener **이동평균(`ma`)**(백엔드 스캔 조건 — 최신일 close vs SMA, 차트 아님). 분봉 전용(D/W/M 미표시, v1).
_Avoid_: bare "이동평균선" 으로 ①을 지칭(②와 충돌 — ①은 항상 "일봉" 한정); "일봉 MA"를 Screener `ma` 조건과 혼동(③은 필터, ①은 오버레이); 투영을 "환산/리샘플" 로(값 재계산 아님 — 거래일→분봉 좌표 매핑일 뿐).

**Half-Day Session**:
A KRX trading day whose **Regular Session** is materially shorter than the typical 6h30m — year-end (12월 30일), 추석 / 설 전 영업일, etc. — and closes earlier than 15:30. Session bounds are always read per-Stock-Date from the parsed TSV (`hoga/parser/__init__.py` parses `regular_session_open_ms` / `regular_session_close_ms`), never assumed; the closing **Auction Window** for hoga-derived readouts is still identified from the observed **Single-Price Book Signature**, not from `sessionOpenMs + 6h20m` or a fixed pre-close duration.
_Avoid_: "short day", "early close" alone (ambiguous with intraday halts).

**SessionTime**:
The frontend module (`frontend/src/util/sessionTime.ts`) that owns KRX session-phase classification — pre-open auction, regular trading, closing auction, gap, pre-axis, post-axis. New chart and sidebar code consumes the named predicates (`isRegularSession`, `isClosingAuction`, `isPreOpen`, `sessionPhaseAt`) rather than re-deriving inequalities locally. Legacy `VirtualAxis.contains` and `VirtualAxis.inClosingAuctionWindow` delegate here for backward compatibility, so the bug class where pre-open auction closes leaked into MA windows or where half-day sessions disabled all auction masking cannot recur.
_Avoid_: hand-rolled `realMs >= sessionOpenMs && realMs <= sessionCloseMs` checks; new domain timing rules belong in `sessionTime.ts`.

**After-Hours Trading**:
The KRX 장후 시간외 종가매매 window that runs from the closing Auction Cross at 15:30:00 to 16:00:00. All trades during this window match at the closing price (the cross price from 15:30:00) — so the price stays flat while volume continues to accumulate. Both snapshots and trades are present in hogaplay's capture across this window. Trades have continuous-trading `side = ±1` (not `side = 0`) — they are aggressor-matched at a fixed price, not auction crosses. Outside `CONTEXT.md`'s strict Regular Session definition (09:00–15:30) but inside hogaplay's Data Window and inside the v1 frontend display range.
_Avoid_: "after-hours" alone (ambiguous with overnight or block-trade markets), "post-market"

**Price Tick**:
A 3-field `section=3 type=5 price` heartbeat broadcast emitted by hogaplay throughout the session. Carries only the current price — no qty, side, or seq. Discovered during E2E validation 2026-05-20. Parser drops these rows entirely; the same information is already present in trade events.

**Entity**:
The in-memory frozen-dataclass representation of one row of table data inside hoga-ops. Carries every field including **forensic** ones — fields whose meaning is partially or fully undecoded (`unknown_14`, `unknown_16`, `unknown_17`, `unknown_18`) kept to enable later decoding without re-collection. Used by the parser on the write path. Internal — never returned by the API. Examples: `Trade`, `Orderbook`, `BrokerRow`, `Candle` in `hoga/tables/*`.
_Avoid_: "model", "domain object", "record"

**Cursor**:
A single Unix-ms (UTC) point on the API contract — the value of the `?t=`
query parameter on spot endpoints (`/api/orderbook`, `/api/brokers`,
`/api/trades`), the `/live` page's `useLiveCursorStore.cursorMs` (set on
chart hover, cleared on mouse-leave; per ADR-0044), and the right edge of
the viewport published by `LiveChartRoot`. Always a real Unix-ms per ADR 0003 — never the native
HHMMSSmmm or ms-from-midnight encodings the Parquet tables use.
Conversion to native happens once at the route boundary via
`hoga.api.cursor::cursor_to_native`, which raises HTTPException(400) when
the Cursor falls outside the requested **Stock-Date**.
_Avoid_: "timestamp" alone (ambiguous with Entity ts_ms and Wire Model
ts_ms which may differ in encoding), "t param".

**체결 창 (Trade Tape)**:
2026-10-30: 10호가·호가주문의 최근 체결 목록(가격·수량·빈 공간)을 더블클릭하면
같은 링크 그룹·Code의 체결창을 앞으로 가져오거나 새로 연다. 창의 실제 고정 종목을
따르고 다른 창·그룹의 종목은 바꾸지 않는다. 기존 시장·커서 연동과 금액 설정을 유지하며,
체결강도는 제외한다. 추가 호버 안내는 없고 키보드 Enter/Space도 지원한다.
같은 날 후속 요청: 두 호가창의 목록은 9행 높이의 내부 세로 스크롤로 현재 받은 최근
최대 200건을 보여준다. 초기 조회를 공유하며 스크롤에 추가 API 페이지를 요청하지 않는다.
과거 행을 읽는 동안 목록을 유지하고 맨 위에서 최신으로 복귀한다. 종목·날짜·시장·
표시 세션 변경은 읽던 목록을 초기화하며 사다리·주문 영역은 독립적으로 유지한다.
선택 종목·거래소·당일의 체결을 `시각 / 체결가 / 체결량`으로 표시하는 독립 창.
과거는 키움 `ka10003`의 체결정보 연속조회이며 10초 집계 저장분으로 재구성하지 않는다.
가격색은 전일 종가 대비, 체결량 색은 공급사 체결수량 부호의 매수·매도 방향이다.
같은 초의 체결은 누적거래량으로 구분하고, 최신 REST 누적거래량 이후 WS 체결만
이어 붙인다. 누적거래량 미제공 시 완료된 초까지는 REST를 사용한다. 하단 휠·스크롤은
이전 페이지를 읽고 조회 중 중복 요청을 막으며 읽던 행의 위치를 유지한다.
`ka10003`에는 날짜 입력이 없어 과거 날짜 요청은 허용하지 않는다.

분봉·초봉 커서 연동 시 같은 그룹·Code의 선택 봉 구간을 별도 `/api/trades/spot`으로
조회하며 일반 호버 해제 시 최신 모드로 돌아간다. 상단 `KRX에서 hogaplay 우선`을 따르고,
거래일별 가용 원천 하나를 선택한다. hogaplay는 개별 틱, 프로젝트 WS의
`second_trades`는 1초·가격·방향별 합산량과 관측 건수다. WS 집계에서는 개별 체결금액
필터·대량 체결 강조를 일시 중지하고 설정값은 보존한다. 기존 10초 집계로 봉 내부
체결을 복원하지 않는다. 선택 봉 미리보기는 최근 200행이며 원주가와 실제 원천·시장을
표시한다. 발행 차트의 유효 시장과 봉 시작을 사용해 저장 학습뷰의 KRX 고정도 따른다.
차트에서 체결창으로 이동하면 마지막 선택 봉을 유지한다. 첫 스크롤 후 `체결 탐색`이
시간을 소유하고 포인터 이탈에도 유지한다. 같은 봉의 페이지를 소진한 뒤 API의
`previous_observed_ms`로 같은 거래일의 이전 관측 봉을 이어 붙인다. 고정 표 헤더 아래
첫 온전한 행의 봉에 같은 그룹·Code·시장의 차트와 10호가가 함께 이동한다. 조회만으로
시간이 이동하지 않으며 차트는 배율을 보존하고 필요한 만큼만 팬한다. 아직 없는 초봉은
해당 시각의 제한된 구간을 읽는다. 실제 차트 호버·`최신으로`·연동 OFF와 종목/그룹/
시장/주기/정규장/금액 필터/원천 설정 변경은 탐색을 종료한다. 상태는 영속화하지 않는다.

**프로그램 체결 창 (Program Trade Tape)**:
키움 `0w`의 수신분 순매수수량 증감(FID 211)과 `ka90008`의 과거 순매수수량 증감을
`시간 / 현재가 / 순매수 증감(주)`
3열로 보여주는 독립 데이터 창(`kind='program-trade'`). 누적 프로그램 그래프와 별개이며
차트 연결·커서 없이 선택 Code·거래소의 최신 수신순으로 처음 200행을 표시하고,
하단 스크롤에서 키움 연속조회 키로 이전 시간대 내역을 이어 조회한다. 양수는
순매수, 음수는 순매도이며 개별 프로그램 매수·매도 체결 건이라는 뜻은 아니다.
`event_delta_qty`는 공급사 수신값이고, 저장 collector가 30초 누적 차이로 만드는
`delta_qty`와 구분한다. 미제공·불량·0 값은 행으로 만들지 않는다.
과거는 키움의 `prm_netprps_qty_irds`를 직접 사용한다. 최신 REST 시각의 초까지는
과거 내역이 담당하고 이후 수신분만 WS tail로 붙여 중첩을 피한다. 과거의 시간은
키움 제공 시각이며 로컬 수신 시각으로 가장하지 않는다. 원본 저장 시작 이전도
조회할 수 있고, 30초 누적 차이로 과거 증감을 계산하지 않는다. 별도
`program_trade_ticks` 저장·조회 경로는 수신 원본 보관용으로 유지한다.
_Avoid_: 개별 프로그램 체결량/체결가; 누적 순매수량을 이번 수신분으로 표시; 저장 delta와 혼용.

**Cursor Sidebar**:
The right-side panel of `/live`'s `LiveWorkarea` that hosts two Cursor-aware cards — **10호가** (cursor-anchored orderbook snapshot) and **거래원** (day-anchored broker list with per-row cursor-projected net; see **Broker Day-Trajectory** and ADR-0023). The 10호가 card is *cursor-keyed* — its list identity changes as the Cursor moves; the 거래원 card is *day-keyed* in identity but *cursor-projected* in its per-row net value. Both consume the **Cursor**; the asymmetry is in what the cursor controls. A third card — **체결** (cursor-anchored recent fills, `FillTape`) — was part of the panel until 2026-05-28; it was removed along with its data path per the 2026-05-28 remove-fills-sidebar-card spec. ADR-0023 and ADR-0044's references to "three cards" reflect that earlier state. The shared shell lives in `frontend/src/sidebar/CursorSidebar.tsx` (originally factored for the Replay Viewer and Live Sidebar to share); after the 2026-05-29 `/replay` removal, `/live`'s `LiveSidebar` (`frontend/src/live/LiveSidebar.tsx`) is the sole consumer — it wires `useLiveSeries` for latest mode and the `useLiveCursor` hooks for spot mode (entered on chart hover per ADR-0044; header swaps `LIVE●` for `SPOT @ HH:MM:SS` on hover, reverts on mouse-leave). Cursor-aware card state is normalized by `frontend/src/sidebar/cursorDetailResolver.ts`: it owns `cursorMs`/loading/no-data semantics (it was factored to be shared with the retired `/study` page; `/live` is now the sole consumer). The Cursor Sidebar **does not own** workarea width; when width becomes user-adjustable, the containing **Live Detail Panel** owns that layout state. The Cursor Sidebar **consumes** **Cursor**; it is not a synonym for Cursor — Cursor is the time-point on the API/UI contract, the Cursor Sidebar is the panel that renders Cursor-derived information (mixed point-in-time and day-aggregate readings).
_Avoid_: "sidebar" alone (the codebase has other panels that could be called sidebars — Inventory's left list, Capture's queue), "cursor panel" (loses the multi-card structure), "spot sidebar" (the prior internal name; superseded, and now also misleading since the 거래원 card is no longer spot-only), "Cursor-keyed cards" as a description of both (the 거래원 card is day-keyed in identity per ADR-0023), "three cards" (the 체결 card was removed 2026-05-28), "resizable Cursor Sidebar" / "collapsible Cursor Sidebar" (the Cursor-aware card shell itself does not own layout width/collapse), treating the **Live Investor Estimate Card** as a Cursor Sidebar card (it is an activeCode auxiliary card rendered by LiveSidebar, outside the CursorSidebar shell).

**Live Detail Panel**:
The `/live` workarea's right-side detail panel for the current **LiveInstrument**, containing the Cursor-aware **Cursor Sidebar** cards (10호가 and 거래원), the **프로그램 순매수** summary, and the **Live Investor Estimate Card** when the active subject is a stock **Code**. It is page-scoped workarea content, distinct from the global **Right Rail**, and it may have user-adjusted width and per-card heights without making the Right Rail or `--sidebar-w` runtime-owned.
_Avoid_: "right rail" (global App shell chrome), "right sidebar" or "sidebar" alone (collides with **Cursor Sidebar** and other page sidebars), "Cursor Sidebar" for the whole four-card panel (the investor estimate card is not Cursor-aware).

**프로그램 순매수 (Program Trade Net Buy)**:
The Kiwoom `0w` stock-level intraday cumulative program-trade net-buy series for one stock **Code**, surfaced as a chart pane and as a compact summary in the **Live Detail Panel**. Each KRX tick fans out to two consumers: the display-only **Live Buffer** publishes it immediately through `/api/live/series` and the shared live WebSocket, while `program_trade_latch` retains the latest value for `ProgramTradeCollector`'s 30-second durable sidecar flush under the frozen `kis-program-trade` identifier. `/live` merges the persisted `/api/range` history with the strict-after-seam 15-minute WS tail; the chart pane and `ProgramWindow` consume that same merged **Stock-Date Range** bundle.
2026-10-28: 프로그램 데이터 창은 같은 이력 쿼리·WS 병합 결과를 별도로 전달받아
캔들 pane의 날짜/축 준비를 기다리지 않는다. 그룹 링크는 프로그램 이력 조회와 캔들
조회의 준비/실패 상태도 전달한다. 종가선과 순매수선은 독립 표시하며 로딩·조회 실패·
데이터 없음·관측 1점 대기를 구분한다. 기존 쿼리의 동일 종목 캐시를 사용하고 종목
교체 시 이전 종목의 선은 남기지 않는다. 캔들 pane의 날짜 필터는 그대로 유지한다.
_Avoid_: "program" alone (too vague outside a UI card label), treating it as KIS REST data, saying that the WS tick is written to JSONL/parquet (only the 30-second sidecar path is durable), or adding a second `ProgramWindow` subscription.

**Live Investor Estimate Card**:
The `/live` **activeCode** auxiliary card rendered by `LiveSidebar` below the **Cursor Sidebar** shell, showing the full KIS intraday estimated foreign/institution net-quantity row history for the current **Code**; it is not Cursor-aware and does not participate in spot/latest mode.
_Avoid_: "Cursor Sidebar card" (does not consume **Cursor**), "investor net" (reserved for **Live Investor Net** daily confirmed/estimated rows), "수급 차트" (history table, not a chart pane), "거래원 확장" (different KIS endpoint, cadence, and provenance from **Broker Day-Trajectory**).

**Live Investor Estimate**:
The KIS `investor-trend-estimate` intraday estimated foreign/institution net-quantity row history for one **activeCode** and KST trading day, surfaced as the **Live Investor Estimate Card** and refreshed by 60-second regular-session polling; KIS owns the history when it returns multiple slots, while hoga-ops only accumulates same-day observed rows if KIS returns latest-only data. Each wire row carries the KIS slot label plus `observed_at_ms`, the Unix-ms time hoga-ops first observed that row's quantities. The card renders this as an aggregation round with actual observation time (`1차(09:20)`), preserving the earlier observation time when later full-history responses repeat unchanged quantities.

The current source is Kiwoom `ka10064` (ADR-0136); `source: 'kis'` remains a legacy wire value. Quantity and amount calls each use the capacity scheduler with `user_visible` priority and distinct axis keys. The independent axes overlap their HTTP waits, then merge in the original axis order so completion order cannot change slot order or units; a failed/cancelled pair drains its sibling and never publishes half rows. HTTP waits up to five seconds; `request_pending` means the shared task continues, not a vendor rate limit. The frontend keeps the query loading (or retains prior same-code rows) and makes at most two follow-up reads, after one then two seconds, joining that task or reading its completed cache. Symbol changes/unmount cancel the follow-up waiter; actual errors and permanent conditions retain the normal polling policy.
_Avoid_: "Live Investor Net" (that is the D-only daily chart pane from `investor-trade-by-stock-daily`), "confirmed investor flow" (KIS describes this as 장중 가집계), "amount" / "대금" (this endpoint is quantity-only).

**Right Rail**:
The fixed thin vertical chrome strip docked at the far right of the **App shell**, present on every route (always `--rail-w` — it does not collapse). Holds icon entries for 관심 (**Watchlist Panel**), 스크리너 (**Screener Panel**), and 저장뷰 (**저장 학습뷰**) — each toggling its own panel open to the rail's left; the panels are **mutually exclusive**. Which panel is open is owned by the `state/rightRail.ts` store (ADR-0052) as `activePanel`, not any page store. Distinct from the **Cursor Sidebar** (a `/live`-only data panel) and **LeftNav** (the left page-navigation column): the Right Rail is global chrome whose job is toggling app-wide auxiliary panels.
_Avoid_: "right sidebar" (collides with **Cursor Sidebar**), "rail" alone, "collapse the rail" (the rail is fixed; the chevron toggles the *panel*, not the rail).

**Broker Day-Trajectory**:
The per-broker signed-net time series across one **Stock-Date** that the **Cursor Sidebar**'s 거래원 card renders as inline sparklines (per ADR-0023). One row per recorded broker; "recorded" means present in the stored top-5 buy plus top-5 sell broker snapshots, not every exchange participant. The row's sparkline plots `net(ts_ms)` = `SUM(qty_today * sign(side))` aggregated per (broker, ts_ms) — same sign convention as the legacy `BrokerNetTable.computeNet` (`buy = +`, `sell = −`), so a broker on both top-5 lists at the same snapshot (rare market-maker case) shows as one signed line rather than two. Wire-shipped via `BrokerSeriesResponse.brokers[*].points` from `GET /api/brokers/series?code=&date=`; the response is sorted by `abs(final_net)` desc (the sort key the sidebar list uses) and returns every recorded broker. **Data gaps** in the trajectory — spans where the broker was outside both top-5 lists and therefore has no snapshot row — are rendered as **dashed, dim** segments connecting the last observed point to the next observed point, deliberately distinguishable from solid (observed-continuous) segments. The gap-vs-continuous decision uses a single threshold `GAP_THRESHOLD_MS` (initially 30s); the convention is intentional honesty about the brokers parquet's top-5 truncation rather than forward-fill that would fabricate continuity. The Cursor Sidebar projects the per-row net-at-cursor value by binary-searching the row's `points` for the last `ts_ms <= cursorMs`. **Crossing a Day Boundary** in a multi-day **Stock-Date Range** swaps the entire trajectory — `useCursor().date` changes, the react-query key changes, the series reloads. **Broker names are canonicalized** at the API/ingest boundary via `hoga.broker_names.canonical`: hogaplay TSV and KIS REST emit the same KRX member firm under different short forms (e.g. KIS `신한증권` vs hogaplay `신한투자증권`, KIS `삼성증권` vs hogaplay `삼  성`), and without normalization a single broker splits into two entries — split nets and split sparklines. The canonical form is the official KRX member-firm name (`신한투자증권`, `삼성증권`, `JP모간`); unknown aliases pass through unchanged and are logged at DEBUG once per spelling per process. No discovery database or counters are maintained, and normalization performs no disk I/O. **Runbook**: enable DEBUG for `hoga.broker_names` when investigating a spelling, then add only verified `raw → canonical` entries to `hoga/broker_names.py:_CANONICAL` (identity entries are allowed for observed spellings). See ADR-0044’s 2026-10-23 amendment. The frontend sidebar's compact label is derived automatically by `brokerDisplayShort` (strip `증권` suffix, cap at 4 chars), so no frontend change is needed for the common case; add a `frontend/src/sidebar/brokerDisplayNames.ts:DISPLAY_OVERRIDES` entry only when the automatic rule produces an awkward label (no `증권` suffix and >4 chars, or stripped form still needs further abbreviation). Both the hot KIS path (live REST) and the cold hogaplay path (parser → parquet) emit broker rows in the **long-format `BrokerRow` schema** (`ts_ms, seq, side, rank, broker, qty_today, qty_delta`), so `query_day_series` reads both sources uniformly — KIS-promoted parquets synthesize `seq` as a monotonic counter per stock-date and leave `qty_delta=0` since KIS doesn't expose intra-snapshot deltas. **Provenance note (ADR-0111)**: the live path's broker feed switched from WS `H0STMBC0` (raw names, `.strip()` only) to `BrokerRestPoller`'s REST `fetch_brokers` (names canonicalized at fetch) — so stored rows from 2026-07-15 onward carry canonical names while the WS-era history carries raw ones; query-time canonicalization in `hoga/tables/brokers.py` stays load-bearing for that historical data. **Provenance note (ADR-0118 PR-D)**: the synthetic broker Live Tick is now broadcast to the **키움(Kiwoom)** session manager's streams (`_dispatch_broker_tick` → `KiwoomSessionManager.broker_dispatch_streams()`; the stream active-set absorbs ownership) rather than the KIS streams, so `kind="broker"` rows land under the **`kiwoom_live`** source subfolder, not `kis_live`. The *source* is still KIS REST (`BrokerRestPoller`) during the transition — the eventual replacement is Kiwoom `0F` push (정규장 스모크 검증 후, PR-F). Update this note when `0F` lands.
_Avoid_: "broker trajectory" alone (loses the Stock-Date scope — could be read as a multi-day cumulative), "broker history" (overloaded with capture history / SSE history), "sparkline" alone (the rendering, not the underlying series concept), "broker net" alone (collapses with the legacy cursor-snapshot reading — use "Broker Day-Trajectory" or "net at cursor" depending on which value is meant).

**기록상 신규 거래원 (Recorded Broker Late Entry)**:
A recorded broker-side pair, `(broker, buy)` or `(broker, sell)`, whose first relevant **Broker Day-Trajectory** point in one **Stock-Date** is at or after a user-selected HHMM threshold (default `09:30`) and who has no recorded broker snapshot on that same side before that threshold. The indicator is intentionally one concept, not separate time cohorts: from the threshold onward, each broker-side pair that was absent from the pre-threshold recorded feed is marked once at its first observed point. This is a statement about the stored top-5/top-5 broker feed only: the broker may have existed outside the recorded ranks earlier, or may have been recorded on the opposite side earlier. The `/live` UI labels the indicator compactly as `신규 거래원 등장`; the chart renders it as a dot plus broker label on the existing **호가비** pane at that first observed time, using separate buy/sell marker colors.
_Avoid_: "new market participant" (not knowable from this data), "first trade broker" (broker rows are member-rank snapshots, not trade prints), "신규 거래원" in technical docs without the "기록상" qualifier.

**Capture Frontier**:
The collector's next-request position for an in-flight **Full Capture** — the `t` value the next `first.php` call will use, equivalently the upper bound of the Data Window range already processed. Internally tracked as HHMMSSmmm (matches hogaplay's `first.php` `time` parameter and the `last_time_ms` field written to `_progress.json`, sourced from `PageStepController.next_t`); surfaced through the capture API as `frontier_ms` in Unix-ms per ADR-0003. Distinct from **Cursor** (which is an API/UI contract concept on the read path).
_Avoid_: "cursor" (overloaded with the API/UI **Cursor**), "current position", "progress timestamp", "last_time_ms" (the internal HHMMSSmmm field name — don't use on the API surface)

**Timing Phase**:
One of seven labels — `http_fetch`, `parse`, `disk_write`, `rate_limit`, `backoff`, `cookie_pause`, `other` — that the capture timing collector uses to attribute wall-clock time per **Page** during a **Full Capture**. Distinct from a **Capture Queue** item's `phase` field (`queued`/`active`/`done`/`failed`/`cancelled`/`skipped`, which labels lifecycle state). A Timing Phase describes *what kind of work* a worker is doing **inside** the `active` lifecycle phase, measured per Page via `time.perf_counter` context managers and aggregated per **Stock-Date**. `rate_limit` covers the per-page `time.sleep(rate_limit_s)` including any **ADR-0017 throttle auto-backoff doubling** of `rate_limit_s` (since the sleep itself is what's doubled and held for 10 pages); `backoff` is reserved for higher-level retry sleeps inside `_run_capture_and_parse` (e.g. the 5/10/30 s waits between full retry attempts), not the rate-limit doubling. Surfaced on the wire as the `capture.timing` SSE event payload and persisted to `<data_dir>/timing/<date>/<code>.json` for offline analysis. Introduced to enable data-driven decisions about future capture optimisations (worker concurrency floor, rate-limit floor, capture-mode variants); the measurement infrastructure is intentionally orthogonal to the Phase 1/2 measurement campaign that produced ADR-0017 (one was a time-boxed experiment, this is a permanent observability surface).
_Avoid_: bare "phase" in any code or doc related to capture timing (collides with **Capture Queue** lifecycle phase — qualify as Timing Phase or queue phase), "stage" (overloaded with CI/CD pipeline stages), "step" alone (collides with **Page Step**).

**Capture Queue**:
The FIFO ordering of (Code, **Stock-Date**) jobs scheduled to become **Full Captures**. A single uvicorn worker process holds the queue in memory across three buckets — `queued` (waiting), `active` (worker grabbed, in deciding/capturing/parsing), `done` (terminal: completed/failed/cancelled/skipped). Workers process N items in parallel up to `HOGA_MAX_CONCURRENT`. The queue can be `paused` (e.g. after `cookie_expired`) which holds active workers and prevents queued items from advancing. Persisted to `<data_dir>/.queue.json` so server restart auto-resumes the in-flight queue (ADR-0019); `done` is volatile and not persisted. The same manifest also persists `fail_streaks` (per-(Code, Stock-Date) consecutive non-COMPLETE-terminal counter — see **fail_streak** below; ADR-0042) so that the **attempt_cap** policy survives restart. Surfaced on the wire as `QueueSnapshot` and mutated via `POST /api/captures/items` / `items/retry` / `items/{code}/{date}/unblock` / `cancel` / `cancel-all` / `queue/resume`.
_Avoid_: "job queue" (overloaded with background-task semantics from web frameworks), "capture pool", "capture list" (ambiguous with **Stock-Date Range**).

**Retry**:
Re-enqueuing a terminal **Capture Queue** item with `attempt = prior + 1`. Two paths trigger it:
1. **Explicit Retry** — `POST /api/captures/items/retry` with one or more `item_id`s. `failed`-only by policy (per ADR-0031); the per-row ↻ button and header "Retry Failed" both use this path. Preserves the old item's legacy `force_retry` wire field for compatibility, but retry policy no longer branches on it (ADR-0081).
2. **Implicit Retry** — `POST /api/captures/items` (the normal enqueue path) when a request's `(code, date)` collides with a `_done` item. The backend auto-dismisses the old terminal `_done` row and enqueues a new attempt for `failed`, `cancelled`, `skipped`, and `done` phases. The worker-time **Capture Eligibility** decision protects complete disk data and decides whether incomplete disk states resume or start fresh.

   | `old.phase` | implicit retry behavior |
   |---|---|
   | `failed`    | auto re-enqueue |
   | `cancelled` | auto re-enqueue |
   | `skipped`   | auto re-enqueue |
   | `done`      | auto re-enqueue; `COMPLETE` disk state still skips at worker time |

   See ADR-0033 + ADR-0035 for the predecessor force-gated design and ADR-0081 for the current force-free retry policy. This is what makes inventory re-capture work without a separate user-facing override: non-complete disk states get another attempt; `COMPLETE` remains protected by `decide_capture`.

Either path: backend removes the old `_done` entry, publishes `CaptureDismissedEvent` (so the frontend hides the old row), then publishes `CaptureQueuedEvent` for the new attempt. The `×N` attempt badge on the queue row counts every Retry regardless of trigger.

**Capture Eligibility**:
The worker-time decision for one **Stock-Date** after reading on-disk **DiskState**. `COMPLETE` is never re-captured by ordinary retry and exits as `skipped/already_complete`; `CLIENT_INCOMPLETE` resumes; `INVALID`, `NONE`, `SOURCE_PARTIAL`, and `NO_UPSTREAM_DATA` start fresh, with the `.no_upstream_data` sentinel deleted immediately before the fresh attempt. This replaces the former user-facing `force_retry` concept (ADR-0081). The `force_retry` boolean may still appear on legacy wire models and queue rows, but it is not domain language and must not be shown as a user control.
_Avoid_: "force retry", "force re-capture", "cache override" (use **Retry** plus **Capture Eligibility**), "retry limit" for **attempt_cap**.

Both Retry paths are gated by **fail_streak** ≥ **attempt_cap** (ADR-0042): a (Code, Stock-Date) with 5 consecutive non-COMPLETE terminal results (`failed`/`skipped`/`done`-but-not-COMPLETE) is `blocked` and any new enqueue is rejected with HTTP 409 / `EnqueueResponse.blocked[]` until the user clicks `잠금 해제` in inventory (which posts to `POST /api/captures/items/{code}/{date}/unblock` and zeroes the counter). The gate runs **before** implicit retry, so a blocked (Code, Stock-Date) never reaches the Implicit Retry branch.
_Avoid_: "re-enqueue" (loses the attempt-counting semantics), "rerun" (ambiguous with replay / backtest reruns).

**fail_streak**:
The per-(Code, Stock-Date) count of consecutive **non-COMPLETE terminal results** in the **Capture Queue** since — and not including — the most recent **COMPLETE** capture or `unblock` action. A terminal result counts (+1) when `phase ∈ {failed, skipped}`, OR when `phase == done` but the on-disk Stock-Date is not COMPLETE (`check_disk_state` ≠ `COMPLETE` — e.g. a `stagnation_abort` or lenient-fallback invariant violation left `collection_complete=False`; ADR-0042 amendment 2026-06-03). The counter resets to 0 ONLY when a capture leaves a COMPLETE Stock-Date on disk, or via the unblock endpoint — **`phase == done` alone is not a reset** (it means "worker returned without exception", not "data is complete"; the same `phase=done ≠ COMPLETE` predicate ADR-0034 uses for the Watchlist marker, classified once in `_finalize_item` and shared by both consumers). `phase == cancelled` does not change the counter (user-initiated cancel; external-call status unknown). Persisted as `.queue.json`'s `fail_streaks: dict[str, int]` (key `"{code}|{date}"`); missing key means `0`. Read by `enqueue_items_core` to enforce **attempt_cap** before dedupe; surfaced on `InventoryRow.fail_streak` so the inventory UI shows it in a dedicated **재시도** column: `—` when 0, an `N/5` warn badge when 1–4, and a `차단됨` error badge when `blocked` (the visible badge text dropped the `재시도`/`(5/5)` affixes — those survive in the column header and the aria-label). Distinct from **attempt** (ADR-0031), which counts every Retry of a single (Code, Stock-Date) regardless of outcome (success does not reset attempt; `×N` badge) — `fail_streak` is the *consecutive-failure* dimension while `attempt` is the *all-time-retries* dimension. Introduced in ADR-0042.
_Avoid_: "retry count" (overloaded with `attempt`; also implies counting includes the initial attempt), "fail count" alone (ambiguous about reset semantics), "block count".

**attempt_cap**:
Constant `5`. The exclusive upper bound on **fail_streak** for enqueue acceptance: `fail_streak >= attempt_cap` ⇒ the (Code, Stock-Date) is `blocked` and `enqueue_items_core` rejects it. Concretely 5 consecutive non-COMPLETE terminal results are allowed (each was a real worker outcome — `failed`, `skipped`, or `done`-but-not-COMPLETE); the **6th** enqueue is rejected. Currently hard-coded; lifting to user settings is deferred (ADR-0042 "When to revisit"). Distinct from `HOGA_MAX_CONCURRENT` (worker concurrency, not per-Stock-Date cap) and from `MAX_STAGNANT_PAGES` (per-page collector loop guard, ADR-0017).
_Avoid_: "retry limit" alone (overloaded with `attempt`), "max attempts" (suggests `attempt` is the gated counter, but `fail_streak` is).

**Watchlist**:
The set of **Code**s the user has marked for organised monitoring and unattended offline catch-up, arranged into user **Watchlist Folder**s. **A Code is in the Watchlist iff it is a member of at least one Folder — membership is the union of the Folders (ADR-0070, v3).** A Code may belong to **several Folders at once** (multi-membership); a Code in zero Folders is not in the Watchlist. There is one Watchlist per `<data_dir>`; no per-user multiplexing because hoga-ops is a single-user local tool. Persisted to `<data_dir>/watchlist.json` as a versioned document `{schema_version, folders, entries}` (v3) — Folders **own** their ordered `member_codes`, and **WatchlistEntry** records hold per-Code backfill markers only (`{code, name, registered_at_kst_date, last_success_date}`; no `folder_id`/`order`). Invariant: `{e.code} == ⋃ folder.member_codes`. The **wire** (`WatchlistResponse`) ships the consumer shape — Folders `{id,name,order}` + entries **exploded** to `{code,name,...,folder_id,order}` one row per (Folder, Code), so a multi-Folder Code appears once per Folder; the projection happens in the backend route, there is no client adapter (ADR-0004). Mutated via the `/api/watchlist*` endpoints (folder member add/remove, catch-up, folder create·rename·delete·reorder, entry reorder, bulk-remove, folder capture toggle) and the **Daily Scheduler**'s `bump_last_success` hook; **every writer round-trips the whole document under one async lock** so folders survive a capture-success write (ADR-0065). **Watchlist 에 있으면 저장 대상이다** — 폴더 단위 저장 옵트인(`capture_enabled`)은 **ADR-0150 으로 제거**됐다(ADR-0079 supersede). 모든 Folder 의 멤버가 **Capture Candidates** 이고, 저장 경로는 KIS WS 삭제 후 **키움 WS 단일**이다(ADR-0118). 저장셋은 이것과 **히트맵 종목의 dedup union** 이며(위 /heatmap 항목) 양쪽 다 게이트가 없다 — 즉 **"등록 = 대상"** 이 두 리스트의 공통 규칙이다. 유한한 키움 등록 예산(200 × 앱키수)을 넘으면 **관심종목 우선**으로 채우고 초과분은 미수집(경고); the Daily Scheduler and `catchup_all` still iterate every WatchlistEntry regardless of Folder capture toggle, and removing a Code does not cancel its queued/active **Capture Queue** jobs. v1→v2→v3 is forward-migrated in place, never quarantined (ADR-0065); the v2→v3 migration folds `folder_id`/`order` into `member_codes` and preserves former 미분류 (unfiled) Codes into a created **"기본"** Folder.
_Avoid_: "subscription" (ambiguous with SSE topics), "auto-list", "follow list", "starred" (no UI star metaphor — the verb is "add to Watchlist"); calling it a flat/unordered list (it is folder-grouped); "single-folder"/"exclusive grouping" (multi-membership since v3); **미분류** for the Watchlist (abolished in v3 — it survives only in the independent **히트맵** store).

**Watchlist Panel**:
The app-wide **Right Rail** view of the **Watchlist**, showing each **Code** under every **Watchlist Folder** it belongs to, with collapsible groups, member counts and **Live Quote**s; row clicks and single-Code chart drops navigate to the current `/live` view, while dedicated handles support folder reorder and single- or multi-Code moves between groups with precise placement and guarded undo (see the [panel transfer behavior and storage contract](docs/superpowers/specs/2026-09-08-watchlist-panel-transfer.md)). A focused row's `Delete` excludes that Code from **that Folder only**, preserving its other memberships, while the context menu's 관심 해제 removes it from all Folders; the **Watchlist Edit Modal** remains the fuller structural editor, alongside the panel's group picker and direct manipulation.
_Avoid_: "watchlist" alone (ambiguous with the backend **Watchlist**); "read-only panel" or "the Modal does all structural editing" (the panel also changes membership and order); "Delete removes the Code from every group" (only 관심 해제 does that); "drag to reorder the flat list" / "the /watchlist page" (both removed when folders landed).

관심종목·히트맵 우측 패널의 표시 확장(2026-10-21): 사용자 승인으로
당일 흐름(64×16px)을 별도 열로 두어 종목명·가격·등락률·흐름을 한 줄에 표시한다.
모든 우측 패널은 기본 320px(20rem)로 통일하며, 두 패널의 목록 상단에는 공통 열 제목을 고정한다. 그룹 헤더는
이름·개수와 기존 접기·정렬 기능만 표시하고 등락률·흐름은 표시하지 않는다. `/api/panel-flow?source=watchlist|heatmap&venue=…`가 독립
목록의 그룹 구성과 코드별 저장 분봉을 배치 계산한다. 코드별 계산은 소속 수와 무관하게
한 번 수행하고 그룹은 유효 관측 종목 평균을 쓴다. 5분 버킷·60초 조회, 결측·미래 시간은
보존하고 무데이터를 0%로 채우지 않는다. 통합의 비NXT 종목은 기존 시세처럼 KRX를 읽는다.
원본은 증분 JSONL이며 벤더 호출이나 구독을 추가하지 않는다. 미국 관심종목은 이 국내
저장 경로 밖이라 흐름 미지원으로 명시하고 국내 평균에서 제외한다. 다른 우측 패널의
현재가와 `/heatmap` 보드는 유지한다.

**Screener Panel**:
The right-rail sibling of the **Watchlist Panel** (`ScreenerDrawer`), surfaced via the **Right Rail** (ADR-0052). Pick a **저장된 조건검색 (SavedScreener)** from the dropdown, run 조회 (a `/api/screener/scan` against the EOD corpus), then click a result row to set **activeCode** + jump to `/live` — same jump-to-chart pattern as the Watchlist Panel. Dragging a result row onto the `/live` chart also changes the current view's **Code**, but unlike the Watchlist Panel it never reorders or persists row order; the drag payload is only a chart-drop affordance. Read-only w.r.t. saves (create/rename/delete live on the `/screener` page). Result rows carry a **Live Quote** overlay on **every row** (display-only — the panel scan filter stays EOD; see **Live Quote**). Each result row also carries a **Watchlist** membership **heart** (filled = in ≥1 Folder, via `useWatchlistMembership`) that opens the **WatchlistGroupPicker** popup to choose which Folder(s) the Code belongs to (v3, ADR-0070 — there is no single "미분류" add target) — so the panel is a **Watchlist writer** even though it stays read-only w.r.t. **SavedScreener**s and the EOD scan. The hearts cover **all** result rows, as does the **Live Quote** overlay (the former top-30 cap was removed — ADR-0056 2026-06-03; the `/screener` page's result table carries the same per-row live overlay).
_Avoid_: "screener sidebar" (collides with **Cursor Sidebar** / **Right Rail** naming); conflating with the `/screener` **Screener** page (the panel runs saved scans and toggles **Watchlist** membership but is read-only w.r.t. **SavedScreener**s — it is not the condition builder).

**Browser Tab Title**:
The browser chrome title (`document.title`) for the current hoga-ops page. On `/live`, it summarizes the active **Code** for quick OS/browser tab switching: `change_pct price name` when a **Live Quote** has `change_pct`, `price name` when the quote has `change_pct=null`, `name`/`Code` fallback when no quote is available, and `hoga-ops` when there is no active Code.
_Avoid_: "browser label" (too vague), putting 봉 labels here (kept out to preserve short OS/browser tab text).

**Live Quote**:
The per-**Code** 현재가 (price) + 등락률 (`change_pct`) + 전일대비 등락액 (`change_won`, KIS `inter2_prdy_vrss`, signed via `prdy_vrss_sign` like `prdy_ctrt`) bundle shown on **Watchlist Panel** / **Screener Panel** rows (and the `/screener` page's result table). The **Live Status Bar** uses the same source for 등락률(%) only beside the active Code's chart price; the **Browser Tab Title** uses `price` + `change_pct` beside the active Code's name. Fetched from KIS `intstock-multprice` (TR `FHKST11300006`, ≤30 codes/call) via `GET /api/live/quotes` and polled every 10s by the frontend `useQuotes` hook (ADR-0056). **KIS-direct, not the Screener corpus** — keeps the panels in their own realm and needs no Screener seeding. **Session-gated**: before the KST 09:00 open (장전) `change_pct` is nulled (rendered `—`); during the session it is current-price-based and after close it is the settled-close 등락률 — both come from KIS `prdy_ctrt`, gated by `_market_phase`. **Usually display-only**: Watchlist Panel, Screener Panel, and `basis=eod` scans still filter on the EOD corpus, so displayed live values may differ from the filtered EOD value intraday. Exception: 풀페이지 `/screener` 의 explicit `basis="intraday"` scan builds a query-time OHLCV overlay from KIS quote rows and lets the condition engine filter on that overlay; if overlay construction fails it falls back to EOD with warning. Each response row maps by its own `inter_shrn_iscd` (never request position). Normal fetch errors yield an empty result so the 10s poller never 500s; **KIS REST Bypass** may instead return process-memory last-good quotes marked stale, because the user intentionally requested stored/cached display. Rendered by the shared `QuoteRow` — 이름 (left) │ 현재가·전일대비 2-line stack (right); the 전일대비 cell is `QuoteChange` (등락액(원) + 등락률 together, KRX color, no ▲▼ glyph). **종목코드 is not a column** — it survives only in each row's `aria-label`/`testid`. Plus an optional trailing action supplied by the host panel — a **Watchlist** heart on **Screener Panel** rows, a remove control on **Watchlist Panel** rows. The **Live Status Bar** reuses the same Live Quote source but renders **등락률(%) only** (현재가 there comes from the **RangeBundle**/WS, not this 10s poll — a deliberate dual-source). The **Browser Tab Title** uses only non-stale `price` + `change_pct` from the Live Quote and omits 봉 labels and `change_won` to stay short.
_Avoid_: "live price" alone (the bundle includes **등락률** + 전일대비 등락액); calling it real-time tick data (N-second REST polling per ADR-0038, like **Live Capture**); deriving it from the **Screener** corpus (explicitly rejected — ADR-0056); confusing its **등락률** with **봉대비** (the **Candle Tooltip**'s 직전-봉 metric — a different reference).

**Candle Tooltip (캔들 호버 툴팁)**:

2026-10-30 후속 요청: 툴팁은 표시를 켠 창의 캔들 영역에 실제 마우스가 있을 때만 표시한다.
분봉의 날짜가 일봉에 연결돼도 일봉에 마우스가 없으면 표시하지 않는다. 차트 이탈·
포커스 상실·페이지 숨김에는 즉시 닫고 동기화·데이터 갱신만으로 다시 열지 않는다.
날짜·크로스헤어·레전드 동기화는 기존대로 유지한다.

2026-10-30: 표시 중인 현재봉·일봉 이동평균선의 호버 시점 가격과 이격도를
`가격 (이격도%)`로 함께 보여준다. 이격도는 `(호버 봉 종가 / 같은 봉의 이평선 값 − 1) × 100`이며
동일 가격은 0%다. 창·반복 지표별 실제 시리즈의 정확히 같은 봉 값을 읽고, 숨김은 제외하며
결측·계산 불가는 `—`로 표시한다. 레전드 표시와 독립적이며 종가·이평선 변경 시 호버 중에도 갱신한다.

The floating, cursor-following readout shown while hovering a candle on the `/live` chart's **candle pane** (and only there) — 시·고·저·종 + 봉대비 변동(액·률) + 거래량 + 직전봉 거래량비. Appears **only on hover** (unlike the always-on pane legend) and hides when the cursor leaves the candle pane. 일봉 종목에서는 해당 거래일의 실제 거래대금(억원)을 함께 보여주며, 레전드·보조지표 표시와 독립적이다. 2026-10-30 사용자 요청으로 기관·외인·프로그램 순매수량과 이를 위한 툴팁 전용 조회를 제거했다. 제공되지 않은 값은 0이나 전날 값으로 대체하지 않는다. Its reference convention is **봉대비**, *not* the **Live Quote** 등락률.
_Avoid_: "legend" (that is the always-on pane legend, which tracks latest-when-idle); implying it shows the **Live Quote** 등락률 (it uses **봉대비**, a different reference).

**봉대비 (Bar-over-Bar)**:
The **Candle Tooltip**'s reference convention — each value compares the hovered candle to the **immediately preceding drawn candle** (`candles[index−1]`) of the *same* **Timeframe**, uniformly across 분/일/주/월: 봉대비 변동률 = `(close/prev.close − 1)×100`, 봉대비 변동액 = `close − prev.close`, 직전봉 거래량비 = `(volume/prev.volume)×100` (같으면 100%). **Deliberately distinct from 등락률 / 전일대비** (the **Live Quote** `change_pct` / `change_won`, measured vs the *previous trading day's close*, ADR-0056): on intraday timeframes 봉대비 compares to the previous *minute* bar, so the tooltip value differs from the **Live Status Bar** / **Watchlist Panel** / **Screener Panel** for the same **Code** at the same instant — chosen for cross-timeframe uniformity over surface-consistency (ADR-0059). On 일/주/월 the two coincide (직전 봉 = 전일/전주/전월). UI label = "직전대비".
_Avoid_: calling it **등락률** or **전일대비** (those are the 전일 종가 metric — collision); "change_pct" (that is the **Live Quote** field).

**극값 대비율 (Extreme Gap)**:
The **High/Low Extreme Labels**' reference convention — `(기준가 − 가시 극값) / 가시 극값 × 100`, where **기준가 (basis) = the close of the RIGHTMOST (most recent) candle currently in view** and 가시 극값 is the highest high / lowest low among the currently-visible drawn candles. The basis is **viewport-relative, not the global last candle**: panning left changes which candle is rightmost-in-view, so 기준가 (and every label's %) recomputes on pan even when no new candle arrives. At the live edge the rightmost-visible candle IS the last candle, so 기준가 momentarily coincides with the **Live Current Price Line** / **Live Status Bar** 현재가 — but they diverge the moment you scroll into history (deliberate: the label answers "how far is this peak/trough from where price sits at the right edge of what I'm looking at"). 고가 라벨 = **고점대비** (기준가 ≤ 고가 → 보통 음수, 빨강 `--price-up`); 저가 라벨 = **저점대비** (기준가 ≥ 저가 → 보통 양수, 파랑 `--price-down`). A **third reference distinct from both 등락률 (vs 전일종가) and 봉대비 (vs 직전봉)**.
_Avoid_: **등락률** / **전일대비** (vs 전일종가) and **봉대비** (vs 직전봉) — all three are different references; equating 기준가 with the **Live Quote**/Status Bar 현재가 (only equal at the live edge — 기준가 is the *rightmost-in-view* close, not the global last close); "고점/저점" alone (그것은 극값 자체 — the price, not the gap %).

**High/Low Extreme Labels (고저 극값 라벨)**:
Red highest-high and blue lowest-low annotations within the visible chart range, showing price and **극값 대비율** against the rightmost visible candle's close. Labels preserve candle visibility by shortening to price or a small extreme mark when space is limited; hovering reveals price, gap and time, while optional **극값 가격선** remain independently visible.
2026-10-26: 차트 헤더의 `차트 설정 → 가격 표시`에서 창별로 편집한다. 라벨과
고가·저가·이전일 고저선의 표시·색상·두께는 모두 같은 창 설정에 저장하며 종목·봉과
독립적이다. 구 창 설정에는 누락 필드만 종전 전역값에서 한 번 이관한다. 앱 설정에는
해당 항목과 하위 가격선·스타일을 노출하지 않는다.
_Avoid_: calling the gap **등락률** (that means change against the previous close); treating the basis as the global live quote when viewing history; assuming price, percentage and time must always remain on the canvas; accepting opaque label overlap with candles or legends as the space-shortage fallback.

**Watchlist Folder**:
A user-named, ordered grouping of **Code**s within the one **Watchlist** — `{id, name, order, member_codes}`, persisted in the v3 `watchlist.json` document's `folders` array. `id` is a server-minted opaque token (`f_` + 8 hex); `name` is a non-empty trimmed label (duplicates allowed); `order` is its 0-based position in the folder list. **The Folder OWNS its membership: `member_codes` is the ordered list of member Codes (ADR-0070, reversing the v2 "folders do not embed members").** A Code may be a member of several Folders at once (multi-membership); adding/removing a member is a per-(folder, code) write via the **member** endpoints. **모든 Folder 가 멤버를 Capture Candidates 로 기여한다** — 폴더별 저장 옵트인 `capture_enabled` 는 ADR-0150 으로 제거됐다(on-disk 키가 남은 옛 문서는 무시하고 로드; 다음 save 에서 소멸). Daily Scheduler catch-up 은 그 전에도 이 플래그와 무관했다. **Deleting a folder is destructive to membership** (v3): a Code that was only in that folder leaves the **Watchlist** (capture and catch-up stop for that Code) — the UI **confirms** before a delete that would orphan any Code ("이 N종목이 관심종목에서 빠집니다"), preserving the ADR-0065 no-silent-loss spirit. CRUD + reorder via `/api/watchlist/folders*`; member add/remove via `/api/watchlist/folders/{id}/members[/{code}]`; live-storage inclusion via the folder capture toggle.
_Avoid_: "category"/"tag" framed as exclusive single-parent (v3 is multi-membership — a Code can be in many); "playlist"; "non-destructive delete" (v2 behaviour — v3 delete can drop Codes from the Watchlist, with confirmation).

**미분류 (Unfiled)**:
The implicit "home" of a Code with no folder — **abolished everywhere.** For the **Watchlist** in v3 (ADR-0070): membership is the union of Folders, so a Code with no Folder is simply not in the Watchlist (no unfiled bucket, no `folder_id=null`). For the **히트맵 (Heatmap)** in v3 (ADR-0112): `HeatmapEntry.folder_id` is required, group delete destroys the folder **and its member entries** (no reparent), and the only add surface is folder-scoped. The word survives only as a migration artifact: the heatmap v2→v3 read-path migration rescues former `folder_id=null` Codes into an **ordinary** folder named "미분류" (deterministic id `f_00000000` — renamable, deletable, never auto-recreated), mirroring the Watchlist's "기본" rescue folder.
_Avoid_: reintroducing an unfiled bucket in either store; treating the migrated "미분류" heatmap folder as special (it is a plain folder); describing heatmap group delete as "moves members to 미분류" (pre-ADR-0112 behaviour).

**Watchlist Edit Modal**:
The two-pane structural editor for the **Watchlist**, opened from the **Watchlist Panel** header `편집` control (`role="dialog"`, name "관심종목 편집"; `WatchlistEditModal`). Left pane = the **Watchlist Folder** list (select to scope the right pane, `그룹 추가`, rename, delete, reorder); right pane = the selected folder's Codes with add (**WatchlistAddForm** → **WatchlistGroupPicker**), bulk-select checkboxes, group-membership edit, remove, and within-folder reorder (drag handles + codec in `dragHandlers.ts`). It is **a** surface for folder CRUD and reordering — group membership is **also** editable in-panel via the row **그룹 편집** picker (v3, ADR-0070), so the Modal is no longer the sole membership editor. Mutations go through the folder/entry `/api/watchlist*` endpoints and optimistically update the shared `['watchlist']` query. (Replaces the removed `/watchlist` full page as the watchlist editor.)
_Avoid_: "watchlist page" (removed); calling the **Watchlist Panel** an editor (it is read+navigate+quick-remove; this Modal is the editor); "popover" (it is a modal dialog).

**히트맵 (Heatmap)**:
`/heatmap` 풀페이지 보드 — **Watchlist 와 독립된 자체 리스트**(ADR-0068)의 모든 **Folder**(섹터) 종목을 동시에 신문형 멀티칼럼(CSS multi-column)으로 펼쳐 **Live Quote**(현재가·전일대비·등락률) 를 등락률 히트(±8% 포화 가변 알파, `--price-up`/`--price-down`; `heatmap/heat.ts::heatBg`)로 칠한 시장-온도 스캔 화면. **관심종목(캡처용)과 별개 집합**(모니터링용) — 한쪽에 추가·삭제해도 다른 쪽은 변하지 않는다. 자체 스토어 `heatmap.json`(`api/heatmap.py`) · REST `/api/heatmap/*`(`heatmap_routes.py`) · React Query 키 `['heatmap']`(`useHeatmap`). 첫 부팅 시 watchlist 가 비어있지 않으면 1회 시드 복사(폴더+종목, 캡처 필드 제거) 후 영구 독립. 행 클릭 → **activeCode** 설정 + `/live` 점프. **드로어(우측 레일)의 행은 차트 창으로 드래그**해서도 종목을 바꾼다 — 재정렬·그룹 이동과 dnd-kit 제스처 하나를 공유하고(관심종목과 같은 부류), 커서가 워크스페이스 캔버스 위면 패널 쪽 드롭 프리뷰는 억제된다(`withChartDropSuppression`). 창 위 드롭=그 창 종목 교체, 캔버스 여백=클릭과 같은 목적지 규칙. `/heatmap` 전체 페이지 보드는 캔버스가 없어 이 경로가 비활성이다(등록 의존). 정렬 토글 manual(=`entry.order`, **기본**)↔change(등락률↓, **옵트인**); 색·숫자는 두 모드 모두 10초 라이브. **v3 (ADR-0112): 모든 종목은 실폴더 소속**(`folder_id` 필수, `heatmap.json` schema v3) — 미분류(null) render-group 은 폐지됐고, 그룹 삭제는 **멤버 종목 동반 파괴적 삭제**(멤버 있으면 confirm), v2 파일의 null 종목은 읽기 마이그레이션이 일반 폴더 "미분류"(`f_00000000`)로 1회 수용한다. 편집: 폴더 헤더 **인라인 ＋종목**(SymbolSearch → `addToHeatmapFolder` 단일 커맨드, `heatmap/useAddToFolder`), 드로어 헤더 **종목 추가**(그룹 셀렉트, 기본=첫 그룹), 상단 **＋새 그룹**(`GroupNameModal`→`createHeatmapFolder`), manual 모드 **그룹 내 드래그 재정렬**, **행 우클릭 메뉴**(삭제·실폴더 간 이동, `HeatmapRowMenu`). 히트맵 시세 표시는 `/api/live/quotes` **read-only 폴링 소비자**이고 KIS WS 구독·hogaplay 캡처는 구동하지 않지만, **ADR-0097**부터 히트맵 종목은 **실시간 저장셋에 합류**한다 — 도입 당시엔 KIS REST 30초 기록기의 REST-전용 후보였으나, KIS WS 계층 삭제(ADR-0118)로 저장 경로가 키움 WS 하나가 되면서 지금은 `coverage.plan_storage_targets(heatmap_candidates=…)` 가 **관심종목과 dedup union** 해 키움 WS 저장셋을 만든다(용량 초과 시 **관심종목 우선**, 초과분 미수집). 엔트리 집합이 바뀔 수 있는 라우트(remove/folder-member add/bulk remove + **folder delete** — v3 부터 멤버 동반 삭제라 편입, ADR-0112)만 `refresh_live_stream`을 best-effort 호출해 저장 타깃을 재동기화한다(폴더 rename/reorder/move 는 훅 없음). **이 합류에는 게이트가 없다** — `LiveSettings.heatmap_capture_enabled` 는 rest30 정책과 함께 2026-07-17 에 제거됐다(`api/models.py` · `api/liveSettings.ts` 주석). 즉 히트맵에 있는 종목은 관심종목 폴더의 `capture_enabled` 와 무관하게 저장 대상이 되며, 빼려면 히트맵에서 지우는 것이 유일한 방법이다. 데이터소스 설정(캔들 기준·KIS API 우회·거래소·소스선호·저장정책·프로그램순매수)은 `live/settings/DataSourceDetail.tsx`로 추출돼 메인 Settings 「데이터 소스」 섹션에 있다 — 라이브 워크스페이스 ⚙️ 모달에선 제거됐다(설정 진입점은 상단 TopNav 하나다. `variant='study'` 축은 ADR-0157 로 사라졌다). KIS 자격증명 없음/오프라인은 셀이 `—`, `deriveBannerState`+`LiveStateBanner` 재사용. Implemented as `pages/Heatmap.tsx` + `heatmap/*` (`HeatmapBoard`/`HeatmapFolder`/`HeatmapRow`/`HeatmapRowMenu`/`FolderAddButton`/`heat`/`visibleGroups`/`useAddToFolder`/`useHeatmap`/`heatmapKeys`) + `api/heatmap` + `state/heatmapPrefs`.
_Avoid_: **Watchlist** 과 동일시(2026-06-11 분리 전엔 히트맵이 watchlist 의 한 뷰였으나 ADR-0068 로 독립 — "관심맵"·"한 Watchlist 의" 표현은 폐기); **Watchlist Panel** 과 혼동(패널은 우측 레일의 관심종목 한 폴더 read+navigate 스트립; 히트맵은 자체 리스트의 전 폴더 풀페이지 보드).

히트맵 종목 설명(2026-10-22): 보드 종목명 호버·키보드 포커스에 코드별 기업 소개를
표시한다. `stockDescriptions.json`은 직접 작성한 330개 고유 Code의 2줄 설명과 출처를
보유한다. `StockDescriptionTooltipProvider`가 보드당 한 툴팁을 관리하고, 동일 Code의
다중 그룹 등록·표시 별칭은 같은 설명을 공유한다. 기존 수집일 안내는 툴팁 하단에 남는다.
미등록 Code는 임의 소개를 생성하지 않고 기존 수집 안내를 유지한다.
2026-10-23: `/live` 캔들 차트 제목줄의 종목명도 같은 Code 설명과 500ms 지연을 공유한다.
워크스페이스당 한 provider를 두며, 종목 교체·드래그/누르기·창 닫기에 해제한다. 그 밖의
모든 창 제목줄 툴팁은 제거했다(접근성 이름과 버튼 동작은 유지). 설명 미등록 Code·지수·
미국 종목에는 소개 툴팁이 없다. 본문 캔들 툴팁은 별개다.


**Index Sector Ranking Pane**:
`/live` 의 **Representative Index** 에서만 보이는 하단 workarea 패널로, 선택된 KST 거래일을 현재 **히트맵** Folder 구성에 대입해 왼쪽은 섹터 평균 등락률 순위, 오른쪽은 선택/preview 섹터의 종목 등락률 순위를 보여준다. 기준일은 지수 캔들 hover 를 따라가거나 캔들 click 으로 고정되고, 섹터는 row hover 로 preview 하거나 click 으로 고정된다. 과거 기준일 값은 **Live Quote** 가 아니라 일봉 EOD 데이터에서 계산한 daily change 이며, 오늘 기준일의 intraday overlay 는 `LiveIndexSectorIntradayOverlay` 가 KIS Capacity Scheduler 의 `QUOTES` request 로 현재가를 가져오고 실패/timeout 시 빈 overlay 로 degrade 한다. 이 패널은 hoga 캡처나 Watchlist 구독을 구동하지 않는다.
_Avoid_: "sector tooltip" (항상 떠 있는 캔들 툴팁이 아님), "index hoga pane" (지수에는 hoga pane 이 없음), "official sector ranking" (사용자 히트맵 Folder 기준), 과거 기준일 데이터를 **Live Quote** 라고 부르기.

**WatchlistEntry**:
A per-Code backfill record of the **Watchlist** (v3): `{code, name, registered_at_kst_date, last_success_date}` — **one record per Code, no `folder_id`/`order`** (membership and ordering live on **Watchlist Folder**`.member_codes`; ADR-0070). The Entity carries only these capture markers; the **wire** exploded entry (`WatchlistResponse.entries`) additionally carries a derived `folder_id` + `order` per (Folder, Code) row, projected in the backend route (Entity≠Wire, ADR-0004). `name` is captured at registration time from the symbol-master cache so the UI does not re-resolve it on every render. `registered_at_kst_date` is a YYYYMMDD KST-date stamp used as the floor for **Catch-up Run** when `last_success_date` is null — past history before registration is never backfilled. `last_success_date` is the most recent YYYYMMDD with a COMPLETE artifact on disk for this Code, regardless of whether the capture happened through the **Capture Queue** or already existed when the Code was added to the Watchlist. Seeded from the disk when the Code first enters the Watchlist via `add_member` (via `disk_state.latest_complete_date`) and reconciled on every startup by the **Catch-up Run** before its backfill pass — so Codes registered while prior data already lived on disk do not show "마지막 성공: 아직 없음". The marker only advances forward; out-of-order `phase = done` completions and disk reconciles cannot regress it. Null only if the Code has no COMPLETE captures anywhere.
_Avoid_: "watch item", "subscribed code".

**Daily Scheduler**:
The asyncio task that sleeps until the next KST 17:00, then runs three steps in order — (1) **Promotion** of any Live Capture JSONL artifacts produced earlier that day (or any unpromoted backlog from prior days), (2) **Raw Prune** of hogaplay raw for Stock-Dates older than the retention window whose hogaplay parquet is COMPLETE (ADR-0075), (3) hogaplay enqueue of `(entry.code, today_kst)` for every **WatchlistEntry** — then sleeps another 24 h. Runs in the same uvicorn process as the **Capture Queue** workers — wired into the FastAPI lifespan beside `start_capture_pool` and `start_live_poller`. The enqueue step skips non-trading days via `calendar.trading_days_in_range`; Promotion and Raw Prune run every day, before the trading-day gate. The Scheduler is a *client* of the **Capture Queue**: it always goes through `enqueue_items_core` for step (3), never touches `_queue` / `_active` / `_done` directly, so ADR-0033 dedupe, ADR-0019 manifest persistence, ADR-0031 retry policy, and cookie-expired auto-pause are all inherited automatically (see ADR-0034). Steps (1) Promotion and (2) Raw Prune are Scheduler-owned and do not interact with the Capture Queue at all, so they do not break the queue-client invariant. The 16:30 `today_too_early` rule (Q14) is the one piece the Scheduler must consult separately (via `find_ineligible_dates`) before calling `enqueue_items_core`, because `enqueue_items_core` *rejects* the whole request on Q14 rather than trimming it.
_Avoid_: "cron" (no system cron is involved), "watcher" (overloaded with file-system watchers and uvicorn `--reload-dir`), "auto-capture" (ambiguous with retry-on-failure auto-capture).

**Raw Prune**:
The disk-retention step that deletes `raw/{date}/{code}/` once its data is safely in parquet — the **Daily Scheduler**'s step (2) and the `hoga prune` CLI share one pure helper (`hoga/api/prune.py`). Gate: `date` older than the retention window (`HOGA_RETENTION_DAYS`, default 3 **calendar** days) AND the (date,code)'s **hogaplay** parquet is `DiskState.COMPLETE`. raw/ is **hogaplay-only** (flat `first_*.tsv` layout — KIS live promotes straight to parquet, never through raw/), so the gate reads the **hogaplay source** state, not the aggregate: an aggregate `COMPLETE` driven by a `kis_live` source must not delete a still-`SOURCE_PARTIAL` hogaplay raw (ADR-0075, ADR-0039). Lossless by construction — only COMPLETE raw (fully parsed, never re-read after parse) is removed; resume sources (`CLIENT_INCOMPLETE`), partials, `INVALID`, and `.no_upstream_data` sentinels are all preserved, and the parquet-first classifier keeps the Stock-Date COMPLETE after the raw is gone so **Catch-up Run** never re-captures it. The CLI is dry-run by default (`--execute` to delete); the scheduler path runs execute and logs reclaimed bytes. Distinct from **Capture Eligibility**'s sentinel unlink (retry clears `.no_upstream_data` to *re-capture*; Raw Prune removes whole COMPLETE raw dirs to *reclaim disk*) — see ADR-0075 and ADR-0081.
_Avoid_: "cleanup" (overloaded — `cleanup_archive` is a Promotion step), "retention" alone (the policy; "Raw Prune" is the action), "GC" (no reference-counting involved).

**Catch-up Run**:
The per-entry "advance the marker, then enqueue the gap" routine — embodied by `scheduler.catchup_one_entry(entry, *, data_dir, now)`. For a single **WatchlistEntry**: (1) disk reconcile via `disk_state.latest_complete_date` to advance `last_success_date` to the latest COMPLETE Stock-Date on disk (idempotent thanks to `bump_last_success`'s monotonic guard — auto-heals legacy entries registered before the disk-seed flow existed); (2) compute `[next_kst_day(last_success_date or registered_at_kst_date), today_kst]`, pre-trim today through `find_ineligible_dates`, and enqueue via `enqueue_items_core`. Returns the resulting `EnqueueResponse` (empty when there's no gap or Q14 trimmed everything). Three trigger surfaces — all call the same helper:
- **Startup** — `_catchup_run` iterates the Watchlist once on server boot.
- **Per-row manual** — `POST /api/watchlist/{code}/catchup` for one entry the user clicked `↻` on.
- **All-rows manual** — `POST /api/watchlist/catchup` for the header `↻ 지금 전체 수집` button (returns a per-entry summary so the banner can show counts and any failures).

Errors are per-entry and logged (KRX list unavailable, credentials missing, exception in the helper); none of the three triggers aborts the rest of the Watchlist when one entry fails.
_Avoid_: "backfill" (overloaded with parquet rewrite operations), "catch-up sync", "startup capture".

**Wire Model**:
The pydantic model returned by API endpoints — the shape clients see. Strips forensic fields (and any other internal-only data). Each table module pairs an **Entity** with its Wire Model: `Trade`↔`ApiTrade`, `Orderbook`↔`ApiOrderbookSnapshot`, `BrokerRow`↔`ApiBrokerEntry`, `Candle`↔`ApiCandle`. Query helpers (`query_at`, `query_up_to`, etc.) return Wire Models directly — there is no intermediate dict materialization.
_Avoid_: "API model" alone (ambiguous with response containers like `OrderbookResponse`), "DTO"

**Invariant**:
A declarative domain rule that a **Stock-Date**'s captured artifacts must satisfy — e.g. "`regular_session_close_ms` must be strictly greater than `regular_session_open_ms`". Lives in the central catalog at `hoga/api/invariants.py` as two registries: **META_INVARIANTS** (`(id, severity, description, check)` tuples where `check` is a pure function from a meta dict to an optional **Violation**) and **SERIES_INVARIANTS** (run over loaded parquet artifacts — e.g. `series.candles_ts_monotonic` — too costly to live-evaluate on the read path). The catalog is the single source of truth — all four checkpoints (parser write-time archival, `DiskState.classify_from_meta`, `build_range_bundle` read-path, `hoga validate` CLI sweep) consume it, so adding a rule is a one-line catalog entry rather than scattered ifs. **Meta** invariants are re-evaluated live at each checkpoint; **series** invariants are archived in meta.json's `invariant_violations` at write time and read back from that archive by the read-path — `classify_from_meta` unions archived `series.*` violations so a series `error` gates `INVALID` without re-loading parquet (ADR-0020 §4.6 amendment, 2026-06-03), while `hoga validate` re-runs them live. Distinct from pydantic field validators (which guard wire shape) — Invariants encode cross-field semantic rules that wire validation can't express.
_Avoid_: "data check", "validation rule" (overloaded with pydantic field validators), "constraint" (overloaded with DB constraints).

**Violation**:
The output of an Invariant whose `check` returned non-None — a `(invariant_id, severity, message, ctx)` record where `ctx` carries the meta values that triggered the failure (so a future reader can reproduce the decision without re-querying disk). Two severities: **error** (data shape itself is broken — `build_range_bundle` excludes the affected **Stock-Date** silently and lists it under `RangeBundle.excluded_dates`) and **warn** (data shape is plausible but trust is low — the **Stock-Date** is included and surfaced under `RangeBundle.data_warnings`). Severity is intrinsic to the Invariant, not to the Violation instance. Surfaced on the wire as plain dicts so non-Python clients can consume without sharing the enum.
_Avoid_: "error" / "warning" alone (overloaded with logging concepts), "failure" (suggests an exception was raised).

**Stock-Date Range**:
A `(Code, fromDate, toDate)` tuple bounding N consecutive **Stock-Date**s (`fromDate <= toDate`, both YYYYMMDD KST). `fromDate == toDate` is the degenerate single-Stock-Date case; otherwise multiple. The unit that `GET /api/range` accepts and that `useRange` (consumed by `/live`'s historical backfill path) wraps. Distinct from the **Data Window**'s intra-day range (08:40–16:00 of one **Stock-Date**) and from the collector's loop range / scrubber range surfaced via **Capture Frontier**. Maximum span enforced server-side (currently 90 days).
_Avoid_: "date range" (collides with Data Window range and capture loop range — both pre-existing), "range" alone (ambiguous across three meanings now), "selection" alone (what is being selected is unclear — use the compound).

**RangeBundle**:
The Wire Model returned by `GET /api/range` for one **Stock-Date Range** — bundles four pre-aggregated time-series (`candles`, `quote_ratio`, `volume_profile_range` / `volume_profile_by_day`, `fill_strength`) aggregated at the requested **Timeframe**'s `bucket_ms`, plus a `segments` array carrying each in-range **Stock-Date**'s `session_open_ms` / `session_close_ms`. The series with a per-day price-grid binding (`volume_profile_by_day`) ships as a per-segment list; series with flat point arrays (`quote_ratio.points`, `fill_strength.points`, `candles`) are concatenated across segments (the **Regular Session** bounds, in Unix ms per ADR 0003). `len(segments) == 1` is the degenerate single-**Stock-Date** case. The displayed window each segment covers spans the **Regular Session** plus the closing **Auction Window** plus the trailing **After-Hours Trading**. Built in `hoga/api/bundle.py::build_range_bundle`. The frontend hook `useRange(code, from, to, timeframe)` calls this endpoint; the frontend type `RangeBundle` mirrors the Wire Model verbatim per ADR-0004. RangeBundle is the single read-path Wire Model for **Stock-Date Range** queries — there is no separate single-day variant (the prior `SessionBundle` / `/api/session` was retired in ADR-0013; see relationships note below). A fifth series `depth_intensity_by_day` was retired alongside the IntensityPane removal — see the 2026-05-23 Quote Totals Pane design.
On `/live` minute charts, hoga indicators (`/api/range?mode=hoga`) and sidecar overlays (`/api/range?mode=sidecar`) use client-side left-delta fetch + merge: extending `20260629..20260706` to `20260624..20260706` should request `20260624..20260628` for those modes, not refetch the full `20260624..20260706` span. Cutoff sidecar profile queries remain single-Stock-Date full requests.
_Avoid_: "MultiSessionBundle", "StockDateBundle", dropping the "Bundle" suffix — "the range" alone collides with **Stock-Date Range** and is _Avoid_'d. Canonical reference: "the RangeBundle for {code}/{from}..{to}@{timeframe}".

**RangeBundle Slice (슬라이스)**:
One array-or-struct field of a **RangeBundle** — `candles`, `ask_peaks`, `depth_heatmap`, `volume_distributions` and the rest. The four scalars that identify the **Stock-Date Range** itself (`code`, `from_date`, `to_date`, `bucket_ms`) are not Slices. Each Slice carries up to seven independent axes: the HTTP `Query` flag on `/api/range`, the frontend request option (and its position in the cache key), the backend gate, the client-side delta-merge rule, membership in the chart-path bundle, and the past-day cache kind. **An empty axis is not itself a defect** — several asymmetries are deliberate — but an *unrecorded* one is how a Slice stops reaching the screen: 호가벽 급증 took three PRs (#1321 → #1333) because the axes it was missing were written down nowhere — that indicator was itself removed on 2026-08-26 (ADR-0162), but it is why this registry exists. The axes are declared by hand in `frontend/src/api/rangeSlices.ts` and checked against the code by `tests/unit/api/test_range_slice_registry_contract.py`.
_Avoid_: "sidecar" alone — that is a value of the `mode` parameter, and only some Slices belong to that mode; "indicator" (a Slice is the wire-level payload, whereas an indicator is what the user toggles and sees — one indicator can need two Slices).

**Quote Totals**:
The 매수 1–10호가 / 매도 1–10호가 quantity sums per **Timeframe** bucket — the raw orderbook depth metric from which **호가비** is derived. Exposed on the wire as `quote_ratio.points[*].bid_total` and `ask_total`, computed in `hoga/api/bundle.py::build_quote_ratio_slice` via `SUM(bid_q1..bid_q10)` / `SUM(ask_q1..ask_q10)` over each bucket. Rendered by the `/live` page's `QuoteTotalsPane` (chart pane 3) as two `LineSeries` — red = bid total (매수), blue = ask total (매도), per the KRX 매수=빨강·매도=파랑 convention — sharing a single auto-scaled price axis so the two values read on the same Y. Quote Totals and 호가비 share one wire field; the field's name reflects the historical (derived ratio) view but the underlying value pair is the primary data.
_Avoid_: "depth totals" (collides with the retired `depth_intensity_by_day` grid), "잔량" alone (ambiguous with broker net 잔량), "bid/ask total" alone (loses the 1–10호가 scope and may be read as a cumulative aggregate over time).

**총잔량 급증 (Quote Totals Surge)**:
The `/live` realtime signal that fires the moment one side's **Quote Totals** (매도총잔량 = `ask_total`, or 매수총잔량 = `bid_total`) exceeds its own **intraday running peak by a margin** (default +50% / `1.5×`). Per-side independent (매도·매수 separate tracks); the running peak ratchets up on each new high, and the margin *is* the debounce — a wall must be ≥`(1+margin)×` the day's prior largest wall *on that side* to fire, so peak-adjacent jitter never alerts. Despite the name, the trigger is **prior-peak-relative**, not baseline-relative (a median-relative "surge" variant was evaluated and rejected). Eval-first delivery: computed client-side over `quote_ratio.points` and drawn as **QuoteTotalsPane** series markers (매도 marker on the ask line, 매수 on the bid line); the watchlist-wide backend detector + alert feed is the production phase. `margin` is a **ChartViewPrefs** knob. Spec: `docs/superpowers/specs/2026-06-12-chongjanryang-breakout-live-marker-design.md`.
_Avoid_: "돌파" / "Breakout" (reserved for the Screener EOD new-high condition — overloading hides the realm difference: Screener daily 수정주가/거래량 vs Live intraday Quote Totals); "총잔량 돌파" (same overload); "surge" read as the median-baseline variant (this is prior-peak-relative).

**당일 매도 최대벽 (Day Ask Peak)**:
The `/live` chart overlay marking, **for each visible trading day, the single ask price-level that held the largest quantity that day** — the day's high-water mark of sell-side resting liquidity — drawn as one horizontal segment spanning that day's candle x-range, marked at the peak's time with an **arrow whose tip touches the line** (매도 points down from above, 매수 up from below — the same shape as the rank arrows, shared via `peakWallArrowShape`; it was a 3.5px dot until 2026-08-26). **The line and that arrow are independent per-family toggles** (`*HorizontalLineEnabled` / `*TimeMarkerEnabled`, both default on, in each family's 「세부 설정」): all four combinations are valid, since the arrow anchors on the wall price and states the level on its own. Turning the arrow off also drops the label's avoidance gap back to `LABEL_GAP_PX` — otherwise the chip would dodge empty space. The family switch (`*LineEnabled`) still means **whether the family exists at all**; these two say *how* it is drawn. The wall is labelled with the quantity (k/M) **centred on that same bar** — 매도 above the line, 매수 below, so both sides' walls from one minute read without colliding. The chip is kept inside its own day's span and the pane; when the collision layout pushes it off its arrow, a faint dashed leader reconnects the two. A zoom budget (`peakLabelBudgetForBarSpacing`) caps how many labels survive per side, and hides them all when zoomed out. Distinct from **Quote Totals (매도총잔량)**: that sums all 10 ask levels, this is the **single deepest level**. Computed over the **same bucket representatives the Quote Totals line uses** — the peak is searched over each `bucket_ms` bucket's *last continuous-trading snapshot*, NOT over raw ticks, so the marked wall is one the user can actually see in that minute's orderbook (a wall that spikes and recedes *between* bucket representatives is a sub-bucket transient — invisible at the displayed 1m/3m resolution — and is correctly skipped). 동시호가 is excluded on three paths, mirroring Quote Totals: closing **Auction Window** + intraday **VI** collapse to 3 levels (**Single-Price Book Signature**) → structurally dropped by the `deep_book_sql` / `isContinuousBook` predicate; the **opening auction (<09:00)** exposes a full 10-level accumulation book that *passes* that predicate (usually the day's largest pile) → dropped by the `session_open_ms` lower bound (the structural analogue of Quote Totals' `surgeStartHHMM` display gate); the post-cross **book re-expansion (~15:30:14)** also passes the predicate → dropped by the `session_close_ms` upper bound. Trading-day scoped (KST), 매도(ask) side only. Per-day correctness is composed from backend **seeds** (`ask_peaks` list on the **RangeBundle** — one bucket-representative `query_day_ask_peak` per captured day, cached per `(code,date,source,bucket_ms)`) plus, for today, a client-side **monotonic ratchet** over the live `ob` SSE buffer (continuous-book + `isAfterRegularOpen` gated; mirrors the **총잔량 급증** running-peak pattern; never forgets a peak that ages out of the 15-min buffer). Toggled + styled (color/width, reusing the MA **MAStylePicker**) from the **지표** modal's side menu, default off. The close-representative search above is the *default*; an opt-in **분봉 내 최댓값 기준 (Intra-Bar Max)** basis deliberately surfaces the skipped sub-bucket transient walls (ADR-0076). Spec: `docs/superpowers/specs/2026-06-13-live-ask-peak-line-design.md` (Status: Draft).
_Avoid_: "매도총잔량" / "Quote Totals" (that's the 10-level **sum**; this is a single level), "총잔량 급증" (that's the sum exceeding its prior peak — an event, not a price line), "오른쪽 벽 / **Right Wall**" (that's the viewport pan clamp — entirely different realm), "매도벽" alone (qualify as 당일 *최대* 매도벽 to keep the day-high-water-mark scope).

**동일분 터치 최대벽 (Same-Minute Touched Day Peak Wall)**:
A **Day Ask Peak** or symmetric day bid peak wall event whose price is dominated by a continuous-trading tick **inside the same 1-minute window the wall was observed in** — ask: `trade.price >= wall.price`, bid: `<=`. **Order inside that minute does not matter** (a tick before the wall snapshot counts): the default `rep` basis observes a wall at the minute's *last* snapshot, so an "after only" rule would empty that path. The touch window is **fixed at 1 minute regardless of the displayed timeframe** — a 3m/5m bar's wall is the rep of the last 1-minute bucket in that window, so "the minute the wall stood in" reads the same at every timeframe, and it is the only resolution that both the shared per-code live state and the 1-minute `peak_rep` cache can serve (ADR-0156). Ranks per price (one row per price, best qty). UI calls this "체결된 벽"; the domain meaning is a same-minute price touch, not order-ID-level fill certainty. Legacy wire names stay `traded_*`.
_Avoid_: "사후터치" / "post-touch" (that was ADR-0084's *any later tick* rule — superseded; the difference is exactly the bug this replaced), "체결가격 기준" (older still: whole-day price membership), "executed wall" if it implies the exact resting order itself filled.

**분봉 내 최댓값 기준 (Intra-Bar Max)**:
The opt-in per-indicator basis that replaces a state hoga indicator's **bucket representative** (close = the bucket's last continuous-trading snapshot) with the bucket's intra-bar maximum — mirroring a candle's 고가(high) vs 종가(close). Applies to **Quote Totals** (each side's independent max, distinct timestamps allowed), **호가비** (the sign-preserved extreme \|imbalance\| snapshot), and **Day Ask Peak** (the **동일분 터치 최대벽**; ADR-0076 originally shared the basis with a second, untouched-wall line that ADR-0156 removed). Per-indicator toggle (`*IntraMax`, a **CHART_TOGGLES** `category:'indicator-modal'` entry, default off). Intra-Bar Max fields ride alongside close on the wire so the toggle is a pure client render switch — no refetch, **Past/Today Split Cache** intact, no `mode=` param. Today is approximate (live ratchet / SSE buffer); the backend confirms precise values once a bar ages into history. **총잔량 급증** detection stays close-based regardless (display-only); its marker just rides the displayed line. 호가비 Intra-Bar Max still passes the **Outlier Mask** — turn the filter off to see raw extremes. Spec: `docs/superpowers/specs/2026-06-13-live-hoga-peak-basis-design.md`.
_Avoid_: "peak" / "고점" (reserved — **총잔량 급증**'s running peak and **당일 매도 최대벽** (Day Ask **Peak**) already own those; this is the bar's *internal* max — a basis choice, not an event or a price line); "고가" framed as the **High/Low Extreme Labels**' candle 고가 (that's a price; this is an indicator value).

**Volume Profile**:
The per-price-bucket cumulative volume histogram derived from a **RangeBundle**'s trade aggregation, surfaced on the wire as `volume_profile_range` and `volume_profile_by_day`. Not currently consumed by the frontend — `/replay`'s `VolumeProfileOverlay` was removed on 2026-05-29 along with the page; `/live` does not mount `VolumeProfileOverlay`. The wire fields remain available for future use.
_Avoid_: "volume histogram" alone (collides with the candle-pane volume bars — distinct concept), "bid/ask profile" (loses the trade-volume scope and may be read as orderbook depth), "VP" abbreviation (unclear to readers outside the chart layer).

**호가비**:
The signed bid/ask imbalance ratio derived from **Quote Totals** per **Timeframe** bucket. Positive when asks are heavier (sell-side pressure, formatted "Nx S"); negative when bids are heavier (buy-side pressure, "Nx B"); zero-centered when balanced. Computed frontend-side in `frontend/src/util/imbalance.ts` from `quote_ratio.points[*].{bid_total, ask_total}` and rendered by the `/live` page's `RatioPane` (chart pane 2) as a single teal `LineSeries`. Each rendered point passes through two independent mask gates before reaching the series, **applied in distinct ways**: the value-based **Outlier Mask** replaces the point's value with 0 (see ADR-0026), while the time-based **Auction Mask** drops the point entirely and inserts a `WhitespaceData` boundary marker so the line breaks cleanly at 15:20 (see ADR-0029). The two are no longer symmetric in action; they remain symmetric only in predicate-driven activation. Sibling of **Quote Totals** — same source field, different question: 호가비 reads "which side is heavier", Quote Totals reads "how much is on each side".
_Avoid_: "quote ratio" alone (the wire field name; the user-facing concept in Korean is 호가비), "imbalance" alone (ambiguous with **FillStrength**'s buy/sell trade imbalance), "ratio" alone (overloaded across price ratio / time ratio).

**Outlier Mask**:
The composite UI state that gates whether a **호가비** point should be suppressed because its magnitude would dominate the **RatioPane**'s autoscale. Active for a given point iff (1) the global `ratioOutlierFilterEnabled` toggle is `true` AND (2) the chart-label value `1 + |raw imbalance|` is `>=` the global `ratioOutlierThreshold` (default 100, range `[2, 10000]`, integer; expressed in label units — `max(ask/bid, bid/ask)` — to match what the user reads off the Y axis). When active, `projectRatio` emits `value = 0` for that point (the data point is kept on the time axis, not dropped). Sibling of **Auction Mask** in trigger structure — both gate 호가비 visibility — but the **rendering actions differ**: Outlier Mask still emits a value-0 baseline-touch (BaselineSeries's 0-crossing styling reads it as "clamped"), while Auction Mask drops the point and breaks the line (see ADR-0029). The two are applied with logical OR per point; when both fire on the same point, the Auction Mask's "drop + break" wins (no point reaches the series at all). Unlike Auction Mask, Outlier Mask applies to the time-series RatioPane only — not to spot views (e.g. BookPanel's 총잔량 스트립). The asymmetry is intentional: outlier suppression exists to keep autoscale honest across a window of points, and a single spot reading has no autoscale to protect; if the cursor sits on an extreme moment the user should see it. The toggle + threshold pair are stored in **ChartViewPrefs** (alongside `auctionWindowMask`, which remains in the ⚙️ Settings modal's "차트" category) but surfaced in the **지표** modal's 호가비 Config — 호가 동작설정을 해당 지표 항목 아래로 통합한 결과(2026-06-13, `category: 'indicator-modal'`); the threshold input is dimmed and disabled (but value preserved) when the toggle is off. See ADR-0026 for the frontend-layer / label-unit / user-tunable decisions; ADR-0029 for why the two masks no longer share a rendering action.
_Avoid_: "outlier filter" alone (the user-facing UI label; in prose the masking concept is paired with **Auction Mask**), "ratio clamp" (no clamping happens — values are replaced with 0, not bounded), "outlier rejection" (suggests data deletion; values are masked at render time, never removed from the wire or disk).

**FillStrength**:
The per-**Timeframe**-bucket trade-side imbalance metric — buy-aggressor volume vs sell-aggressor volume — derived from the trade aggregation over a **RangeBundle**. Wire field `fill_strength.points[*].{t, buy_qty, sell_qty}`, computed in `hoga/api/bundle.py::build_fill_strength_slice` by summing per-side `qty` from continuous-trading rows (`side != 0`) bucketed at the requested `bucket_ms`. Rendered by the `/live` page's FillStrength pane (chart pane 4) as two `HistogramSeries` sharing a single zero-baseline price axis — buy quantities painted upward in KRX 빨강 (`--price-up`), sell quantities painted downward in KRX 파랑 (`--price-down`) by emitting `-sell_qty` to the same axis. Continuous-trade only — **Auction Cross** rows (`side = 0`) are excluded by the backend filter; the closing **Auction Window** therefore has no points natively. By default, the cross moment's single bar at 15:30 is also visually hidden when `auctionWindowMask` is on (per ADR-0029); when the user toggles the mask off, the cross bar reappears. Sibling of **호가비** in pane-positioning ("how much was traded each way" vs "how much rests on each side"), and distinct from **Volume Profile** in axis ("trade side at time t" vs "trade volume at price p").
_Avoid_: "imbalance" alone (collides with 호가비's bid/ask imbalance — qualify as "체결 imbalance" or "fill imbalance" when needed), "체결강도 막대" alone (loses the buy/sell split; ambiguous after **Cumulative Net Fill** overlay is added), "trade strength" (overloaded with VWAP / momentum readings outside this codebase).

**Cumulative Net Fill** (체결강도 누적):
The per-**Stock-Date** running sum of `(buy_qty − sell_qty)` over **FillStrength**'s bucketed continuous-trade series — a single signed LineSeries overlaid on the FillStrength pane that reads as "which side has been winning the day, and by how much, as of cursor t". Resets to 0 at each `segments[i].session_open_ms`; pre-open and after-hours points (outside `[session_open_ms, session_close_ms]`) are excluded from the sum. Two predicates apply independently in the projector: an **in-session** predicate gates whether a point contributes to the running sum, an **in-viewport** predicate (`axis.contains`) gates whether the resulting cumulative value is emitted to the series — so zooming into mid-session keeps the line starting from the correct 09:00-anchored baseline rather than re-zeroing at the viewport edge. Closing **Auction Window** handling: `runningSum` keeps accumulating from 15:20 onward (in practice no points exist there because **FillStrength** is continuous-trade only — so the sum is unchanged), but emission is suppressed and the line breaks at 15:20 when `auctionWindowMask` is on (per ADR-0029). The legacy "flat through 15:20–15:30 with a jump at the cross" visual is gated behind toggling the mask off. The reset is also made visually explicit at each day boundary by emitting two extra points per segment: a **line break** (lightweight-charts `WhitespaceData` — `time` only, no `value`) one virtual-second before session open so the prior day's last value doesn't draw a diagonal into the new day, and a **zero anchor** at session open (only when in viewport and not pre-empted by an actual fill point at the same timestamp) so the new day's line visibly starts from 0. Rendered with `--fg-dim` (mid gray) — neutral enough to read as "derived signal" without colliding with the **Zero Baseline Guide**'s darker `--fg-dimmer`. `priceScaleId: ''` (invisible overlay scale) keeps the line's magnitude — typically 1–2 orders larger than per-bucket histogram values — from compressing the buy/sell bars on the shared right axis. A **Zero Baseline Guide** is drawn at price 0 to mark the buy/sell-cumulative-pressure transition point. Per-tab `fillStrengthCumulative` toggle (entry in `CHART_TOGGLES` with `category: 'indicator-modal'`, default `true`); surfaced in the **지표** modal's 체결강도 Config (이동: ⚙️ 설정 모달 → 지표 모달, 2026-06-13).
_Avoid_: "체결강도 라인" alone (overloaded — the histogram is also a series in the same pane), "누적 델타" (델타 is loaded; collides with options Greek and with CVD-style "cumulative delta volume" definitions that differ in side-classification rules), "buy-sell cumulative" alone (loses the per-day reset — could be read as a multi-day running total).

**Zero Baseline Guide**:
A horizontal 0-price reference line drawn on chart panes whose data straddles zero and whose cross-zero moment is itself the signal (sign-flip = polarity reversal). Visual contract: dotted, 1px, neutral color (`--fg-dimmer`), no axis label, no title. Currently rendered by the **RatioPane** (호가비 BaselineSeries draws no line at its `baseValue`, so the reference must be explicit) and the **Cumulative Net Fill** line on the FillStrength pane. Implemented as `addZeroBaselineGuide(series, color)` in `frontend/src/chart/util/zeroBaseline.ts`; a future indicator that needs the same affordance reuses the helper rather than re-asserting the visual contract.
_Avoid_: "baseline" alone (collides with lightweight-charts' `BaselineSeries`, which switches color at its baseValue but doesn't draw a visible line — the Zero Baseline Guide is what closes that gap); "zero line" (too generic — used in trading UIs for unrelated VWAP / pivot references).

**RangeSeriesPane**:
The deep module that owns chart-pane lifecycle for any indicator derived from a **RangeBundle**. Replaces the prior pattern of five near-clone pane components (CandlePane, VolumePane, RatioPane, QuoteTotalsPane, FillStrengthPane), each repeating the same useEffect → addSeries → `axis.contains` filter → `axis.toVirtual` mapping → `setData` → `try { removeSeries } catch` shape with only the per-series projection differing. Takes a **PaneSpec** describing series count, type, options, and a `(bundle, axis, ctx?) => DataPoint[]` projection per series; the module owns the lifecycle invariants (pre-open auction point drop, real-ms → virtual-second mapping, ChartErrorBoundary teardown race guard around `removeSeries`). New indicators add one PaneSpec entry instead of a new component file; cross-cutting policy changes (e.g., a chart-wide setting toggle, a label format change) land in one place. Lives at `frontend/src/chart/RangeSeriesPane.tsx`; the five historical panes survive as named PaneSpec exports (`CANDLE_SPEC`, `VOLUME_SPEC`, `RATIO_SPEC`, `QUOTE_TOTALS_SPEC`, `FILL_STRENGTH_SPEC`).
_Avoid_: "ChartPane" (collides with lightweight-charts' own "pane" terminology), "BundlePane" (loses the per-`paneIndex` series semantic), "SeriesView" (loses the multi-series-per-pane semantic).

**거래량 색상 기준 (Volume Color Mode)**:
거래량 보조지표별 `volumeColorMode`는 `candle`(기본, 캔들의 양봉·음봉 방향)과
`previous-volume`(같은 주기 직전 봉의 거래량과 비교) 중 하나다. 비교는 증가일 때만
양봉 색상이며 동일·감소는 음봉 색상이다. 직전 봉이 없는 첫 관측은 캔들 방향을 따른다.
화면 범위·거래일·과거 캐시 경계에서 비교를 초기화하지 않고 진행 중 봉은 누적량으로
갱신한다. 창·봉 프로필·반복 지표별로 저장하며 기본 거래량 겹쳐 표시도 같은 값을 쓴다.
색상·투명도·반전 설정은 기존 표시 규칙을 따른다.

**거래량 겹쳐 표시 (Volume Overlay)**:
`보조지표 → 거래량 → 표시 방식`에서 편집하는 창별 표시 방식이다. 기존 창별 저장값을
유지하고 보조지표 패널의 되돌리기를 지원한다. 기본 거래량을 캔들 pane 하단에 숨은 독립 축으로
그리고 별도 volume pane을 마운트하지 않는다. 가격축·거래량 원본·공용 Pane Group은
바꾸지 않으며, 끄면 기존 pane 배치·봉별 높이·거래량 드로잉을 복원한다. 기본 끔,
투명도 65%, 높이 25%, 상승·하락 색상은 테마를 따른다. 반복 추가한 거래량은 별도
pane에 남는다. 거래량 내 누적 체결강도 표시는 2026-10-26 사용자 요청으로 제거했다.
독립 체결강도 지표의 누적선과는 별개다.
_Avoid_: 가격·거래량 축 공유; 거래량 데이터 재집계; 공용 Pane Group의 캔들 병합으로 표현.

**Pane Group**:
사용자가 레전드 이름 칩을 드래그(또는 칩 메뉴)로 보조지표 pane 들을 **한 pane 에 병합**한 단위 (ADR-0160). 레이아웃의 원본은 `paneGroups: PaneId[][]`(전체 PaneId 의 순열+분할)이고 종전 `paneOrder` 는 그 평탄화 투영으로 남는다. 렌더는 지표당 **RangeSeriesPane** 1개가 같은 `paneIndex` 를 공유하는 방식이라(병합 PaneSpec 을 합성하지 않는다) 데이터 라우팅·memo 경계가 병합 전과 같다. 멤버십은 여전히 타임프레임 게이트 소유 — 그룹은 레이아웃일 뿐이다. y축은 기본 멤버별 격리(`merged:<paneId>:<원id>` 네임스페이스), 그룹별 3모드(`isolated`/`shared`/`left`) 오버라이드는 멤버 구성의 정렬 join 을 키로 저장돼 구성이 바뀌면 기본값으로 리셋된다. 핵심 모듈: `frontend/src/chart/paneGroups.ts`(모델·연산·축 정책), `frontend/src/live/paneGroupSpecs.ts`(게이트 분할), `frontend/src/live/paneMergeDrag.ts`(드롭 판정).
_Avoid_: "pane 스택"(z-순서로 읽힌다), "합성 pane"(새 PaneSpec 을 만든다는 오해 — 렌더 모델과 반대), "그룹"(단독으로는 워크스페이스 창 **그룹**(차트 연동 그룹)과 충돌).

**Virtual Axis**:
The stitched, gap-compressed ms time axis on which the `/live` page's chart renders. Constructed from a **Stock-Date Range**'s `segments`: each segment's `[sessionOpenMs, sessionCloseMs]` interval is laid end-to-end with a fixed 1-second `INTER_SEGMENT_GAP_MS` separating adjacent segments, so the inter-session **Day Boundary** gap (~17.5 hours of weekday non-trading) collapses to a single second on the axis. The 1-second gap is too small to perceive at any realistic bar spacing but large enough to keep day N's closing candle (`sessionCloseMs`) and day N+1's opening candle (`sessionOpenMs`) on distinct integer-second `UTCTimestamp` values — otherwise lightweight-charts' `setData` rejects the N-1 boundary collisions for multi-day ranges. A real Unix-ms value `t` inside any segment maps to `virtualMs = segments[i].virtualStart + (t - segments[i].sessionOpenMs)`; values in a Day Boundary map to the prior segment's virtual end (the gap "belongs to the day just closed"); values before the first segment map to the axis sentinel (no preceding real time). Lives in `frontend/src/util/virtualAxis.ts` as a frozen factory: `createVirtualAxis(rawSegments, originMs = 0)` returns a `VirtualAxis` with `axis.segments` (frozen), `axis.dayBoundaries` (derived), `axis.toVirtual(ms)` / `axis.toReal(ms)` (projections), `axis.findByReal(ms)` / `axis.findByVirtual(ms)` (lookups), and `axis.contains(ms)` / `axis.isInGap(ms)` (predicates). `originMs` anchors `segments[0].virtualStart` — 0 by default; `/live` passes `segments[0].session_open_ms` (the **real-anchored origin**) so an axis remap (leftward-pan prepend) changes the time value at index 0 and lightweight-charts rebuilds its value-keyed tick weight/label state instead of reusing the previous generation's real dates (see ADR-0054 addendum). All consumer panes receive `axis: VirtualAxis` as a single prop rather than threading raw `segments`. lightweight-charts receives virtual-ms values directly; tick labels are rebuilt into KST via a custom `tickMarkFormatter` (see spec §6.6(b) — implementation detail kept out of this glossary per grill D4).
_Avoid_: "compressed timeline" alone (ambiguous with replay-speed compression), "virtual time" (ambiguous with synthetic time / mock clocks in tests), "axis" alone (chart has price axis too — always qualify).

**Day Boundary**:
The non-trading gap between two adjacent **Stock-Date**s in a **Stock-Date Range** — from segment `i`'s `session_close_ms` (15:30 KST) to segment `i+1`'s `session_open_ms` (09:00 KST), plus any tail past the final segment's close. Compressed to a 1-second `INTER_SEGMENT_GAP_MS` on the chart's virtual axis (see `util/time.ts`) — visually contiguous but large enough to keep boundary candles on distinct `UTCTimestamp` values — and surfaced as a thick vertical divider line at each boundary (date labels are owned by the adaptive x-axis, not the divider). The frontend predicate `isDayBoundary(segments, realMs)` returns true exactly when `realMs` falls inside such a gap. Distinct from intra-day non-trading periods (lunch break does not exist in KRX continuous trading; pre-open auction at 08:40–09:00 is part of the **Data Window** but outside any segment's **Regular Session** bounds — those are NOT Day Boundaries, they sit before `segments[0].sessionOpenMs`). A **Stock-Date Range** with N segments has N-1 Day Boundaries plus a post-tail region; N=1 has zero Day Boundaries.
_Avoid_: "overnight gap" (collides with after-hours overnight quote moves that aren't part of this codebase's window), "session gap" alone (ambiguous — Regular Session is part of the term).

**Timeframe**:
Chart candle time resolution. Six fixed values: 1m / 3m / 5m / 10m / 15m / 30m. Surfaced as `bucket_ms` on the wire (60_000, 180_000, 300_000, 600_000, 900_000, 1_800_000). All five **RangeBundle** series share the same Timeframe — `candles` re-aggregates OHLC, the other four use their existing `bucket_ms` parameter set to the same value. User-selectable via the `/live` page's timeframe selector (see **LiveTimeframe**). Distinct from **Page Step** (collector loop's `time` increment, write-path concept) and from the Cursor's intra-Stock-Date sampling resolution. The `/live` page exposes a superset of selectable resolutions; see **LiveTimeframe**.
_Avoid_: "interval" (collides with **Page Step**), "resolution" (ambiguous with chart pixel density / display resolution), "bucket" alone (overloaded — `bucket_ms` is fine as a field name, but "the bucket" in prose is unclear).

**LiveTimeframe**:
The `/live` page's candle-resolution selector. Superset of **Timeframe**: the six minute values (1m / 3m / 5m / 10m / 15m / 30m) plus three calendar values (D / W / M). Defined in `frontend/src/state/livePage.ts` as `LIVE_TIMEFRAMES`. The minute subset round-trips to backend `/api/range`'s `bucket_ms` exactly like a Timeframe and gets the full five-pane chart (candle + volume + 호가비 + Quote Totals + FillStrength). The calendar subset (D/W/M) uses a **separate backend endpoint** — `GET /api/live/past-daily-candles` returns daily bars directly (no client-side minute→daily aggregation needed); the page renders D as-is and client-aggregates D→W/M via `aggregateCalendar(rawDaily, 'W'|'M')`, bucketing by Monday-anchored week / calendar month. On normal `/live`, D/W/M never hits `/api/range`, so the hoga-derived panes (RatioPane, QuoteTotalsPane, FillStrength) have no data and are not mounted in those modes (candle + volume only). This split has **no exception** — the hoga bundle is minute-only everywhere, saved views included (`planLiveRangeRequest` gates on `isMinuteTimeframe`, and `rangeRequest` disables a request with no code). It mirrors the **Live Candle Backfill** vs `/api/range` data-path split: minute = wire-bucketed indicators, calendar = client-aggregated candles with no indicators. This entry claimed a `/study` exception until 2026-08-23; that path had been removed earlier (mixing hogaplay minutes with vendor dailies broke on split-adjusted stocks) and only the sentence survived — see ADR-0157 §Context.
_Avoid_: "Live Timeframe" with a space (the codebase uses one word), "calendar timeframe" alone (the term covers both subsets — minute + calendar), "9-value Timeframe" (collides with **Timeframe**'s strict six-value definition).

**Live Edge (라이브 엣지)**:
The viewport state where the visible range's right edge sits at the latest candle plus the default `rightOffset` padding (15 bars) — the state the `/live` chart opens in and returns to on every (code, timeframe) switch (`scrollToPosition(0)` in LiveChartRoot's initial-view effect), and the default working position for watching live data. `useViewportBackfill`'s repositioner skips repositioning when the pre-swap snapshot was at the live edge (within tolerance) so prepends don't yank a live-edge viewer; plain-wheel zoom at the live edge keeps the **latest candle** pixel-fixed (anchor = `min(to, lastBarIndex)`, v0.7.0.1 — earlier it pinned `range.to`/the padding edge, which drifted the candle left on zoom-in). Leaving the live edge by panning/scrolling left past the leftmost loaded bar is what arms historical backfill — the from<0 trigger fires on every **LiveTimeframe** (D/W/M extend one large chunk per trigger); only the multi-step settle loop is minute-only.
_Avoid_: "right edge" alone (that's the viewport's `range.to` at ANY scroll position — live edge specifically means latest-candle anchoring), "현재 시점" (ambiguous with **Cursor**).

**Right Wall (오른쪽 벽)**:
The clamp that stops user-initiated rightward shift+wheel panning at the default live-view position (`maxTo = lastBarIndex + rightOffset` — the latest candle plus the 15-bar right padding): a pan tick that would push `to` past the wall pins `to` at `maxTo` and preserves the visible span, so being "at the wall" coincides with the **Live Edge** default view. `lastBarIndex` is the latest candle's index in the shared timeScale's UNION coordinate space, obtained at event time via `ts.timeToIndex(axis.toVirtual(latestCandleMs))` — NOT `bundle.candles.length - 1`, which understates it because quote panes add union points for tradeless minutes (observed skew ~273). Applies ONLY to the shift+wheel pan branch — plain wheel anchors the latest candle (or `range.to` when scrolled into history) and ctrl/cmd zoom anchors the cursor, both unclamped to preserve their anchor invariants (2026-05-28 field-test reversal). History: tight at `lastBarIndex` (v0.6.4.0) → +rightOffset buffer (v0.6.5.1) → index source switched `candles.length-1` → union `timeToIndex` (v0.7.0.1, when the skew broke the new plain-wheel candle anchor). The pure helper `frontend/src/util/wheelInteractions.ts` takes `maxTo`/`lastBarIndex` as inputs; the hook supplies them. Specs: `2026-05-24-replay-wheel-right-wall-design.md`, `2026-06-07-live-wheel-interactions-design.md`.
_Avoid_: "clamp" alone (the codebase has several — barSpacing clamp, axis clamp, **Outlier Mask**), "오른쪽 끝" (that's the viewport right edge, not the wall).

**StockDateGroup**:
The frontend in-memory rollup of all **Stock-Date**s sharing one **Code** — the unit displayed in the Inventory page's left list (Master-Detail). Carries the grouping key (`code`), display name (`name`), the child `dates: StockDate[]` sorted desc, plus two aggregates used by the left list: `lastCapturedAt = max(captured_at)` (the parent sort key — most-recent first) and `totalSizeBytes = sum(file_size_bytes)`. Built client-side by `useStockDateGroups(rows, search)` from `useStockDates()`'s `StockDate[]` — no backend grouping endpoint. Single-level tree: parent is the StockDateGroup, children are Stock-Dates. Distinct from **Symbol Master** (the catalog of all `(Code, name, market)` from pykrx, including codes that have never been captured); a StockDateGroup exists only for Codes that already have at least one captured Stock-Date.
_Avoid_: bare "StockGroup" (loses what is being grouped — collides with bare "Stock" which is _Avoid_'d), "CodeGroup" (loses the Stock-Date scope and may be read as a grouping of Codes themselves), "inventory entry" (the Inventory page is a page, not a domain concept).

**Disk State Severity**:
The ranked ordering of **DiskStateValue** values by how "bad" the state is for a captured **Stock-Date** — `invalid > client_incomplete > source_partial > complete` (higher rank = worse). Shared SSOT for two consumers that both need to answer "which state is worse?": (1) `aggregateDiskState` in [DiskStateBadge.tsx](frontend/src/inventory/DiskStateBadge.tsx) — picks the worst state across a **StockDateGroup**'s children for the left-list dot, and (2) the Inventory detail table's State column sort (per the 2026-05-25 column-sort design) — orders rows by severity when the user clicks the State header. Exposed as `STATE_SEVERITY: Record<DiskStateValue, number>` in `DiskStateBadge.ts`; changing the order is a one-line edit and both consumers update in lockstep. The `'none'` DiskStateValue does not participate — by construction it never reaches the inventory rows (no `meta.json` means no row at all, per `api/types.ts` comment).
_Avoid_: "disk state priority" (overloaded with task/queue priority), "disk state rank" alone (loses what is being ranked), bare "severity" (overloaded with **Violation** severity which is a different two-level error/warn axis).

**Upstream No-Data**:
The signal that hogaplay's `info.php` endpoint returns HTTP 200 with an empty body for a given (Code, Stock-Date) — meaning the upstream source has no data for that day. Distinct from a network failure (5xx), an auth failure (4xx via `CookieExpiredError`), or a partial **Full Capture** (`SOURCE_PARTIAL`). The system records this signal as a `.no_upstream_data` sentinel file inside `raw/{date}/{code}/` and classifies the **Stock-Date** as `DiskState.NO_UPSTREAM_DATA`; the worker terminates the queue item as `skipped` with `skip_reason="no_upstream_data"`. The sentinel takes precedence over all other disk-state markers — by invariant the directory contains the sentinel alone (other zero-byte artifacts are cleaned up by `_record_no_upstream_data`). A later **Retry** deletes the sentinel and re-runs the collector, so the state is recoverable when upstream coverage gaps close later. Confirmed trigger case: `003490/20260319` (2026-05-24).
_Avoid_: "missing data" alone (ambiguous with a not-yet-captured **Stock-Date** in `DiskState.NONE`), "empty capture" (collides with `CLIENT_INCOMPLETE` where pages exist but parsing was interrupted), "no-data" alone without the "Upstream" qualifier (the user-facing label "no upstream data" in the calendar legend makes the source explicit; in prose use the compound).

**Symbol Master**:
The catalog of `(Code, name, market)` tuples sourced from pykrx — the lookup layer that lets a user type a Korean name fragment (e.g., "삼성") and resolve it to a **Code** (`005930`). **Disk-persisted** at `~/.local/share/hoga-ops/symbol-master.json` (machine-global XDG path; see ADR-0015) and mirrored in memory by `hoga/api/symbols.py` as module-level state (`_cache`, `_fetched_at_ms`, `_state: SymbolCacheState`) per ADR-0006's single-module pattern. Surfaced through `GET /api/symbols/all` (full catalog with per-Code captured-Stock-Date breakdown), `GET /api/symbols?q=…` (in-memory search), `GET /api/symbols/info` (lightweight metadata for the Settings page), and `POST /api/symbols/refresh` — **the sole pykrx entry point**. Boot and read endpoints never trigger fetches; a fetch happens only when the user explicitly clicks Update (Settings page) or Refresh (SymbolSearch unavailable/stale states). The catalog has no automatic-refresh TTL — staleness is signalled by the Settings page's "Last fetched: N days ago" row and by an empty-result nudge in SymbolSearch when the disk file is ≥ 7 days old. The frontend's `useSymbols()` hook and `SymbolSearch` component (`frontend/src/capture/`) bind to these endpoints. This compound is sanctioned despite the bare "symbol" noun being _Avoid_'d elsewhere — the established class names across backend (`SymbolHit`, `SymbolsAllResponse`, `SymbolMasterInfo`, `SymbolCacheState`) and frontend (`SymbolSearch`, `useSymbols`) make it the canonical term. Do not rename to `CodeCatalog` or `TickerMaster`; the compound is the term.
_Avoid_: bare "symbol" (use **Code** for the 6-digit ticker, or **Symbol Master** for the catalog/lookup layer), "ticker", "symbol list" (use "the Symbol Master" or "Symbol Master entries"), "force re-fetch" (the predecessor 24h-TTL model is gone — refresh is always user-initiated, never "forced" over an automatic schedule). The class names `SymbolHit` and `SymbolSearch` are sanctioned compounds — do not rewrite them in prose as bare "symbol".

**ChartViewPrefs**:
The global, single-user chart view preferences owned by `useChartPrefsStore` (`frontend/src/state/chartPrefs.ts`) — booleans from the `CHART_TOGGLES` registry, integers from `CHART_NUMERIC_PREFS`. Persisted to `localStorage["hoga.chart.prefs.v1"]` (debounced 250ms via `chartPrefsPersistence.ts`). Read by chart projectors (RatioPane, QuoteTotalsPane, FillStrength), the AuctionWindowOverlay, and the LiveSettingsModal through `useActivePrefs(selector)`. The boolean Source Preference setting lives in a separate `useSourcePreferenceStore` (see **Source Preference**).
_Avoid_: "per-tab prefs" (the multi-tab model was removed with `/replay` on 2026-05-29; **note: `/live` multi-tab is being reintroduced — ADR-0069 — but ChartViewPrefs stays global, NOT per-tab, so this _Avoid_ still holds**), "ChartPrefsContext" (the React-context indirection was removed in the same change).

**Drawing**:
A user-authored chart annotation persisted to the browser — one of three primitives: **horizontal line** (single price, full chart width), **trendline** (two-point segment), **pencil** (freehand polyline). Every Drawing is **bound to one chart pane** via a stable `paneId: PaneId` (string literal mirroring `PaneSpec.name` — `'candle'`, `'volume'`, `'ratio'`, `'quote-totals'`, `'fill-strength'`); the binding fixes both which clip region it renders into and how its `price` coordinate is interpreted (KRW on the candle pane, share count on the volume pane, signed −1..1 on the ratio pane, etc.). All coordinates are real Unix-ms (ADR-0003) plus pane-relative price, so a Drawing remains valid across different **Stock-Date Range** loads of the same **Code**. Persisted to `localStorage` under `replay.drawings.v1.<code>` (per **Code**; key name retained for backward compatibility after `/replay` removal on 2026-05-29). Selectable, draggable, and deletable in select mode (body-translate clamps to the origin pane — drawings never visually migrate between panes); created by activating a tool from the `LiveDrawingMenu` in the `/live` page's `LiveToolbar` and clicking the destination pane. Lives in `frontend/src/state/drawings.ts` (store) and renders via `frontend/src/chart/DrawingOverlay.tsx` (canvas overlay). See ADR-0024 for the realMs-vs-virtualMs decision and ADR-0028 for the `paneId`-vs-`paneIndex` decision.
_Avoid_: "annotation" alone (overloaded with `data-*` attributes used for E2E selectors), "shape" alone (collides with lightweight-charts' own primitives terminology), "line" (ambiguous across hline / trendline / pencil), "pane-bound Drawing" as a separate kind (pane binding is a property of every Drawing, not a sub-classification).

**Drawing Overlay**:
The canvas layer (`frontend/src/chart/DrawingOverlay.tsx`) above the `lightweight-charts` canvas in `LiveChartRoot` that renders all **Drawing**s and captures pointer events when a **Drawing Tool** is active (or when there are drawings present in select mode). Sibling of **DayBoundaryOverlay** / **AuctionWindowOverlay** in z-stack order; sits at z-20 versus z-10 for the read-only overlays because it consumes pointer events. Mounts a DPR-scaled `<canvas>` and coalesces redraws through a single `requestAnimationFrame` driven by `subscribeVisibleLogicalRangeChange` and a `ResizeObserver`, identical to **DayBoundaryOverlay**'s pattern. Pane-aware: each Drawing renders inside a clip rect computed from its `paneId`, and Y conversion reads from a `Map<PaneId, ISeriesApi>` registry owned by `LiveChartRoot` (each **RangeSeriesPane** registers its first series on mount). Pointer-down picks a `paneId` via cumulative-height lookup; the drag then sticks to that pane (clamp).
_Avoid_: "drawing canvas" alone (loses the React-component identity), "overlay" alone (chart has multiple overlays).

**Drawing Tool**:
The user's currently selected drawing mode — one of `select` / `hline` / `trendline` / `pencil` / `eraser`. **Global** UI state (not per **Code**) because it reflects the user's current intent, not data. The `LiveDrawingMenu` button in the `LiveToolbar` shows the active tool's glyph and reverts to `select` via the menu's "선택" entry or the `Escape` key. When the active tool is `select` the **Drawing Overlay** uses dynamic pointer-events gating (chart pan flows through unless the cursor is over a hit-testable drawing); when any drawing tool is active the overlay captures pointer events outright.

After a drawing tool commits a new **Drawing**, the active tool auto-reverts to `select` **and the just-added Drawing becomes the selected one** — the **Drawing Property Panel** attaches to it and the canvas renders the new shape with selection emphasis (halo + 2× stroke). The companion behaviour from ADR-0030 — clicking on empty chart space in `select` mode clears the current selection — is preserved, so a stale halo cannot linger across an unrelated chart interaction. Chart pan/zoom on that empty-space click is preserved. See ADR-0032 for the rationale and ADR-0030 for the prior, partially-superseded decision. `eraser` is intentionally excluded from auto-revert because continuous erasure of multiple drawings is the common flow. Each tool also has a keyboard shortcut (`Alt+H/T/P/E/V` for hline/trendline/pencil/eraser/select) declared on its spec; the **Drawing Overlay** keydown handler iterates `TOOLS` to dispatch and bails out while any pointer gesture is in flight (drag, trendline draft, or pencil draft) to avoid stranding draft refs in a zombie state.

The deep module that owns per-tool pointer behaviour is `frontend/src/chart/drawing/tools.ts` — each tool is a `DrawingToolSpec` value carrying `{kind, label, glyph, cursor, shortcut?, onPointerDown?, onPointerMove?, onPointerUp?}`. The **Drawing Overlay** dispatches into `TOOLS[activeTool]` per pointer event through a `ToolCtx` (coordinate helpers, hit-test, store actions, draft refs, plus a `revertToSelectMode()` helper that clears `selectedId` and switches the active tool to `select`); the same helper backs the `Escape` keyboard handler so there is one canonical "return to neutral" path. The **Drawing Menu** iterates the `DRAWABLE_TOOLS_ORDER` registry to render its rows. Adding a tool primitive is one new `DrawingToolSpec` plus a `TOOLS` entry — the **Drawing Menu** picks up the new row automatically. Mirrors the **RangeSeriesPane** deepening pattern.

The data-shape side of a primitive (render, hit-test, body-drag translate, hit-threshold) is currently scattered across four switch-on-`d.kind` sites: `drawing/render.ts` (`renderDrawing`), `drawing/translate.ts` (`translateDrawing`), `drawing/types.ts` (`HIT_THRESHOLD`), and `chart/DrawingOverlay.tsx` (`hitTestAt`). The deepening follow-up tracked in `docs/superpowers/specs/2026-05-24-drawing-kind-spec-design.md` introduces a sibling **Drawing Kind Spec** registry (`drawing/kinds.ts`) that collapses these four switches into a single `KIND_SPECS[d.kind].xxx(...)` lookup, so a new primitive becomes truly two registry entries (one in `TOOLS`, one in `KIND_SPECS`) with no edits to **Drawing Overlay**.
_Avoid_: "drawing mode" alone (ambiguous with chart pan/zoom modes), "tool" alone (overloaded across toolbar buttons).

2026-10-23 영역 선택: `select` 모드에서는 캔들 플롯의 우측 드래그로 그리기를
선택한다. 5px 이동부터 사각형·강조를 미리 표시하고 놓으면 선택을 교체한다.
2026-10-24 후속 요청으로 드래그 중 선택 개수 문구는 표시하지 않는다.
Shift를 누르고 시작하면 기존 선택에 추가한다. 가격축·시간축·다른
pane은 제외하며 시작한 차트 창의 scope만 변경한다. 잠긴 항목도 선택할 수 있지만
편집·이동·삭제는 계속 보호된다. 다중 선택은 기존 속성 패널의 일괄 편집·삭제,
좌측 드래그 이동·키보드 복제·실행취소를 공유한다. 우측 클릭과 활성 그리기 도구의
우클릭 취소는 유지하고, 영역 선택 중 Escape·포인터 취소·포커스 상실은 확정 전
선택을 보존한다. 입력 소유권은 `drawing/useRightDragSelection.ts`에 있다.

**Drawing Property Panel**:
The floating DOM affordance (`frontend/src/chart/DrawingPropertyPanel.tsx`) that appears when a **Drawing** is selected in `select` mode, lets the user change the selected Drawing's color, stroke width, and line style, and provides a delete button. Sibling of the **Drawing Overlay** in `LiveChartRoot`; both subscribe to `useDrawingsStore` but the overlay handles canvas hit-testing/drag and the panel handles DOM popovers, the property edits, and panel drag-in-DOM. **Visibility gate**: `activeTool === 'select' && selectedId != null` — both clauses required so the panel hides when the user switches to a drawing tool to draft a new shape (the previously-selected drawing's panel must not linger over the draft). The initial/default position is the chart's top-center, 8px from the top. A dedicated grip moves the single- or multi-selection toolbar within the chart; its chart-relative position is remembered per chart window across selection, Code/timeframe changes and chart-component remounts until page reload. No browser storage persists the position. Resizing clamps the visible toolbar without overwriting the remembered position. Double-clicking the grip or pressing Home resets it to the default; arrow keys move the focused grip, and Escape cancels an active drag. See ADR-0108's 2026-10-17 update. Three independent popovers (color = the shared indicator palette (`MA_COLOR_ROWS`, 8 columns × 4 shades), with the same round swatches and theme-aware selected outline/check mark, thickness = list of `STROKE_WIDTHS = [1,2,3,4,5]`, line style = list of `LINE_STYLES = ['solid','dashed','dotted']`); at most one popover open at a time, dismissed by outside mousedown or `Escape`. Property edits dispatch `update(id, patch)` and `setDefaults(patch)` so the chosen color/width/style become the **Drawing Defaults** seeded into the next new Drawing of any kind. The post-commit halo + selected state that makes the panel point at a freshly-drawn shape (instead of clearing selection) is the part of ADR-0030 that ADR-0032 supersedes; the empty-click-deselects companion from ADR-0030 is preserved. See ADR-0032.
_Avoid_: bare "panel" (collides with **Cursor Sidebar** which is _Avoid_'d on its own as "panel"; always qualify), "property bar" or "inspector" (Figma terms — this codebase has its own term), "drawing toolbar" alone (collides with the **Drawing Menu**, which is the tool-picker dropdown, not the per-drawing editor).

**Drawing Lock**:
A per-**Drawing** freeze (`Drawing.locked?: boolean`, absent = unlocked) that makes the store refuse `update` and `remove` for that drawing; the only patch it accepts is one whose key set is exactly `{locked}` — the unlock transition. `clearAll` skips locked drawings, so "모두 지우기" reports and deletes only the unlocked ones. Toggled from the 🔒/🔓 button in the **Drawing Property Panel**, which is the one control there that stays enabled while locked — selection is therefore deliberately still allowed on a locked drawing, since the panel is the only unlock route. The **Drawing Overlay**'s pointer-events gate hit-tests against `unlockedOnly(drawings)`, so it stays `'none'` over a locked shape and the chart pans through it normally (and the cursor stays lightweight-charts' own crosshair); selecting a locked drawing is consequently *not* `selectTool`'s job but the window-level `mousedown` listener's, whose pure decision is `resolveSelectModeMouseDown` (`'deselect'` / `'select-locked'` / `'none'`). **Both sides key on the same question the gate asks** — `selectTool` picks via `ToolCtx.hitTestUnlockedAt` and the listener returns `'none'` whenever an unlocked drawing is under the cursor — so territory splits exactly at the gate: `'auto'` ⇒ the overlay acts on the topmost *unlocked* shape, `'none'` ⇒ the listener may select a locked one. Letting them diverge is what made a locked shape lying over an unlocked one swallow the click without grabbing or panning. The filter is applied to the LIST before hit-testing, never to the winner after — `hitTestDrawings` returns the topmost match, so a locked shape drawn over an unlocked one would otherwise mask it. A locked drawing *fully* covered by an unlocked one is therefore unclickable; the menu's `모두 잠금 해제` is its escape hatch. Enforcement lives in `state/drawings.ts` (single choke point for all six mutation entry points) and the lock check sits **before** `recordHistory`, or refused edits would pile up no-op undo snapshots and silently clear the redo stack. Undo / redo / restore / import bypass the lock — they replace the array wholesale, so per-item gating is not expressible. A Ctrl+D duplicate is born unlocked, and endpoint/corner handles are not drawn on a locked selection (the halo still is). Every locked drawing carries a small vector padlock on the canvas (`lockBadgeAnchor` + `drawLockBadge` in `drawing/render.ts`, drawn for selected and unselected alike) so "which of these are locked?" is answerable at a glance; the **Drawing Menu** carries a single bulk item whose label states the next action (`모두 잠금` / `모두 잠금 해제`), backed by `setLockedAll(scope, locked)` — **one** undo step, a no-op when nothing would change, and unlocking deletes the field rather than writing `locked: false`. No storage schema bump: absence of the field means unlocked, so pre-existing drawings stay valid. See ADR-0164.
_Avoid_: "freeze" (collides with the `/freeze` skill and with pane-freeze vocabulary), "readonly drawing" (the drawing is still selectable and still renders normally), "pin" (suggests position anchoring, which is what `paneId` + realMs already do).

**Drawing Defaults**:
The sticky `{color, width, lineStyle}` triple the **Drawing Property Panel** seeds into the next new **Drawing** of any kind. Lives as a single slice on the `useDrawingsStore` (`state.defaults`); every property edit through the panel (`update + setDefaults`) updates it, and every drawing-tool constructor in `chart/drawing/tools.ts` reads it for the initial value of a new Drawing. Persisted globally to `localStorage["replay.drawingDefaults.v1"]` (no per-**Code** scoping — the user's color preference is a tool preference, not a per-stock annotation). Debounced 250ms on write, same pattern as the per-Code Drawing persistence. On absent or unreadable key, falls back to `INITIAL_DEFAULTS = { color: '#14B8A6', width: 2, lineStyle: 'solid' }`.
_Avoid_: "default style" alone (ambiguous with `DESIGN.md`'s system tokens), "last-used settings" (overloaded with chart **ChartViewPrefs** carry-over), "sticky settings" (technical jargon).

**Live Capture**:
The operational mode that captures the **Live Set** stocks' quote/trade/broker data during the **Live Session**, via **키움(Kiwoom) WebSocket push** (호가 + 체결 **Live Tick** 스트림; 회원사(거래원)는 ADR-0111 이후 `BrokerRestPoller`가 KIS REST 폴링으로 합성 Live Tick을 키움 스트림에 주입), downsampled in-process to 10-second **Live Snapshot**s for storage. *(2026-06-05 live-kis-websocket spec → 구현; 2026-07-17 ADR-0118 PR-G — KIS WebSocket 계층(`ws_client.py`) 삭제, 실시간 호가·체결 수집=키움 전담: `hoga/live/kiwoom_*`·`stream.py`. KIS는 캔들·거래원 REST 전용으로 존치.)* Distinct from **Full Capture** in two axes — *time* (Live Capture is intraday/online; Full Capture is post-hoc/offline once the Data Window is closed) and *source* (Live Capture goes through 키움 WS; Full Capture goes through `hogaplay.com`'s `first.php`). The write path stays JSONL append-only to `<data_dir>/live_kiwoom/{date}/{code}.jsonl` (ADR-0038의 hot-path invariant 유지 — 핫패스는 JSONL만 쓴다); the **Promotion** step converts that JSONL into the captures Parquet artifacts under the `kiwoom_live` source subfolder. Lives in `hoga/live/*`; sister to `hoga/api/captures.py` (single-module per ADR-0006) — see ADR-0037.
_Avoid_: bare "live" (overloaded with UI affordances like the "Live" badge), "real-time capture" (표시 엣지는 sub-second지만 *저장*은 10초 다운샘플 — 캡처 산출물은 여전히 스냅샷 단위), "polling capture" (2026-06-05 전환 후 호가·체결 캡처 전송은 WS push — REST 폴링 캡처는 rest30(비-Live Set 호가, ADR-0098)과 거래원 BrokerRestPoller(ADR-0111)에 한정), "intraday capture" alone (ambiguous with future analyses that consume intraday data).

**Live Capture readiness**:
전용 수집 프로세스의 최근 연결 증거와 현재 설정의 반영 완료를 구분하는 상태다.
현재 epoch의 신선한 계정 연결·수신은 설정 동기화 중에도 보존하지만 `syncing`은
`capture_healthy=false`이며 새 종목의 구독 준비 완료를 뜻하지 않는다.
`collector_unavailable`은 수집 상태 유실, `storage_error`는 필수 저장 실패다.
상태 만료·자식/IPC 종료에서는 과거 연결을 현재 연결로 재사용하지 않는다.
ADR-0174의 2026-10-12 개정과 개선 계획을 따른다.
_Avoid_: 설정 반영 대기를 연결 단절과 동일시하는 표현; 연결 수만으로 수집 정상 판정.

**Live Snapshot**:
The **10-second storage unit** Live Capture writes per (Code, t_ms) — one entry in the JSONL feed of the form `{t_ms, kind, ...}`. *(2026-06-05 WS 전환 spec → 구현 완료; 2026-06-25 Continuous Trade Volume Distribution artifact 보강)* After the WS 전환, `kind ∈ {"ob", "trade", "fill", "broker"}`. `kind="fill"` stores the 10-second side totals (`buy_qty` / `sell_qty`) used by FillStrength. `kind="trade"` is not raw per-tick tape; it stores the same 10-second window grouped by `(price, side)` so Promotion can write `trades.parquet` with the `price` column required by **연속체결 매물대 분포 (Continuous Trade Volume Distribution)**. Distinct from **Live Tick** (the per-message WS receive unit, memory-only) — the 10초 다운샘플러가 다수의 Live Tick을 하나의 Live Snapshot으로 접는다; 디스크에 도달하는 것은 Live Snapshot뿐이다. Also distinct from the orderbook **snapshot** rows in the Parquet `orderbook` table. On Promotion: `kind="ob"` → `snapshots.parquet`, `kind="trade"` → `trades.parquet`, `kind="fill"` → `fills.parquet`, `kind="broker"` → `brokers.parquet` — i.e., Live Snapshot is *write-path-only* terminology and never appears in Wire Models.
_Avoid_: "tick" (that is **Live Tick** — a Live Snapshot is the downsampled *stored* unit), "sample" (too generic), bare "snapshot" alone (collides with the orderbook **snapshot** in the Parquet table — qualify as Live Snapshot or orderbook snapshot).

**Live Tick**:
One 키움(Kiwoom) WebSocket push message for one **Code** — 호가 / 체결 중 하나 (회원사(거래원)는 ADR-0111 이후 `BrokerRestPoller`가 KIS REST fetch_brokers 결과를 동일 형태의 합성 Live Tick으로 `on_tick`에 주입) — received by the 키움 WS client, normalized to the LiveBuffer entry shape, fanned out to the browser for sub-second display, and **never persisted** (per-tick 원본은 폐기; 저장은 10초 **Live Snapshot**으로 다운샘플). *(2026-06-05 spec → 구현 완료)* Memory lifetime: time-based ring(보존 기간 > 2× Today Promotion 주기 — 봉합 사이징 불변식) in the backend LiveBuffer, mirrored by the browser-side buffer. Distinct from **Price Tick** (hogaplay's 3-field heartbeat row — 다른 소스·다른 스키마) and from the stored **Live Snapshot**.
_Avoid_: bare "tick" (ambiguous with **Price Tick**), "WS message" (transport jargon — the domain unit is the Live Tick), "event" (overloaded with SSE/queue events).

**Capture Candidates**:
The ordered, deduped set of **Code**s that may be stored by live KIS capture, formed from the union of **모든 Watchlist Folder**`.member_codes` (폴더 단위 옵트인은 ADR-0150 으로 제거), then filtered to valid symbol-master Codes and ordered by the first folder position in Watchlist display order. **Storage Policy** decides how this set is written: WS-only stores the WS-capacity prefix as `kis_live`, WS+REST stores the WS-capacity prefix as `kis_live` and the remainder as `kis_api`, and REST-only stores the whole set as `kis_api`. Distinct from the **Watchlist** (all organised Codes) and from the **Live Set** (the WS-capacity prefix only).
_Avoid_: "Watchlist" when you mean the live-storage candidate subset; "REST candidates" (in WS-only mode the same set feeds WS); "selected groups" without naming the resulting Code set.

**Storage Policy**:
The data-dir scoped live-write mode that decides how **Capture Candidates** are stored: `ws_only` (`WS만 저장`) writes only the WS-capacity prefix as `kis_live`; `ws_plus_rest` (`WS 우선 + 나머지 REST 저장`) writes the WS-capacity prefix as `kis_live` and the remainder as `kis_api`; `rest_only` (`REST만 저장`) disconnects WS and writes all Capture Candidates as `kis_api`. Distinct from **Source Preference**, which is a read/display priority over already-written **Source**s.
_Avoid_: "source setting" (read/write ambiguity), "default data source" when discussing writes, "REST toggle" for the global mode.

**Live Set**:
The top **≤(`_PER_ACCOUNT_MAX` × n_configured) Code**s of the current **Capture Candidates** (계좌당 W=`_PER_ACCOUNT_MAX`(현재 19) — 1계좌 19, 4계좌 76), taken in the Watchlist Panel's **display order** (v3: `folders[].order` 순 → 모든 folder 의 `member_codes` 순 평탄화 → **첫 등장으로 dedup**(다중 소속 Code 는 가장 위 folder 위치가 rank) — 이제 `display_ordered_codes` 와 같은 입력이다(캡처 토글 필터가 사라졌다)). **Dynamic-N** partitions the Live Set across N KIS WS connections(account k = display순 W-슬라이스 `codes[k*W:(k+1)*W]`; 코드 있는 파티션만 연결) — 종목당 2등록(호가+체결; 거래원은 ADR-0111에서 WS 제외·REST 폴러 대체), **연결(appkey)당 등록 상한 41**(OPSP0008 실측 2026-07-10, ADR-0101), 예산 `KIS_WS_MAX_REGISTRATIONS`(39) // `TRS_PER_CODE`(=`len(ws_fields.TRS)`, 단일진실원) → W=19. *(이력: 2026-06-05 1계좌 13 → 06-10 3계좌·W=10(30 ceiling 시절) → 07-10 등록 상한 41 실측·39 예산·W=13(ADR-0101) → 07-15 거래원 TR 제외로 종목당 3→2·W=13→19(ADR-0111); 2026-06-22 capture toggle spec narrows the input from whole Watchlist to Capture Candidates.)* In storage mode **WS만 저장**, the Live Set is the whole live-storage target and Codes beyond WS capacity are not stored live; in **WS 우선 + 나머지 REST 저장**, Codes outside the Live Set but inside Capture Candidates are stored through the **KIS API Source** (ADR-0098 이후 10호가만 — 체결·거래원은 WS 종목 전용); in **REST만 저장**, Live Set is empty and WS is disconnected. The **Viewed-Code Poll** remains display-only and does not create a Source.
_Avoid_: "subscription set" / "subscription" (**Watchlist**의 기존 _Avoid_와 브라우저 탭 구독(`subscribeLive`) 양쪽과 충돌), "top-19" (구현 상수 노출 — TR 구성이 바뀌면 한도도 바뀜; 실제로 ADR-0111이 3→2 TR로 13→19 변경), "live watchlist" (Watchlist의 부분집합이지 별도 리스트가 아님).

**Live Session**:
The Regular Session-spanning window during which Live Capture is gated to run — 09:00 KST start, **15:30 KST stop** (`ws_capture_window`), one per **Stock-Date**. *(2026-06-05 WS 전환 spec → 구현 완료: 장후 시간외(15:30–16:00) 라이브 캡처는 의도적 회귀 — 가격 고정 구간이라 정보가치가 낮고 hogaplay 일배치가 post-hoc per-tick 보완.)* Sanctioned compound despite the bare "session" being _Avoid_'d (mirrors the **Symbol Master** precedent where bare "symbol" is _Avoid_'d but the compound is canonical). After the WS 전환 the Live Session coincides with the Regular Session span — the 30-minute After-Hours extension was poller-era behavior. Half-Day Sessions *should* truncate to 12:30, but `ws_capture_window` is pure-clock and does not yet know early closes (알려진 갭 — spec §11/plan 최종리뷰 I3-d에서 보류). The stream's run/stop state is owned by the Live Session lifecycle; consumers query `GET /api/live/status` to read it.
_Avoid_: "session" alone (the existing _Avoid_ remains in force — Live Session is sanctioned only as a compound), "polling session" (loses the day-scoped semantics), "capture session" (collides with **Full Capture**'s implied session).

**Source**:
The label identifying *how* a captured artifact was produced — `"hogaplay"` (paged scrape of `hogaplay.com`'s `first.php`), `"kis_live"` (KIS WebSocket live capture promoted to 10-second snapshots), or `"kis_api"` (KIS REST API 30-second sampled capture). Stored as `meta.json`'s `source` field and as a directory level in the captures tree — `<data_dir>/parquet/{date}/{code}/{source}/*.parquet` (see ADR-0037). Different sources can coexist for the same Stock-Date; the **Source Preference** setting picks which one is rendered when several exist (preference + fallback, see ADR-0039 and the 2026-06-22 capture source policy spec). Sources are *not* equivalent in resolution: hogaplay captures every per-event tick (with `seq`/`global_seq` continuity); kis_live captures 10-second promoted live snapshots; kis_api captures 30-second REST samples. The frontend therefore shows the Source label as a chart badge so the user is not misled about resolution.
_Avoid_: bare "source" in domain prose (overloaded with import/data-source / upstream-source / news-source meanings; always qualify as "data Source", "the kis_live Source", "Source label"), "provider" (financial-industry overload), "feed" (collides with SSE/event feeds elsewhere in this codebase), "origin" (too abstract).

**Source Preference**:
The user-tunable display priority owned by the global `useSourcePreferenceStore` (single per-user value, not per-tab / per-page) that the read path consults when multiple **Source**s exist for one Stock-Date. Three user-facing policies: `hogaplay 우선` (`hogaplay → kis_live → kis_api`), `KIS WS 우선` (`kis_live → kis_api → hogaplay`), and `KIS API 우선` (`kis_api → kis_live → hogaplay`). The semantic is *preference + fallback*, never strict filter — a Stock-Date is excluded from a RangeBundle only when no Source in the policy can satisfy the request. Surfaced in `/live`'s `LiveSettingsModal` as **데이터 표현 기준**; persisted in localStorage and applied to `/api/range` / spot endpoints. Both normal `/live` data paths consult it: (a) `/live`'s historical backfill path (`useLiveBundle` → `useRange` → `/api/range`) reads promoted Parquet and honors the preference, (b) `useLiveCursor` (spot reading on hover) likewise threads it. **저장 학습뷰** snapshot restore does not consult the current global Source Preference while hovering a restored view; it uses only the Source and detail data already persisted in the saved snapshot JSON. Save/update-time detail enrichment uses the Source captured in the saved snapshot segment when known; legacy save requests without segment Source may fall back to the save request's source preference and then the existing hogaplay-preferred behavior. Browser live buffers are not a Source until promoted/written into the source tree. **The ladder resolves per dimension, not per Stock-Date** (ADR-0121): the orderflow winner (`resolve_source_result`) and the candle winner (`resolve_candle_source`) can differ for the same Stock-Date, because Sources do not all carry every dimension — `kis_live`/`kiwoom_live` never write `candles.parquet` (ADR-0040/0043) and `kis_api` no longer serves orderflow (2026-07-17). Reading candles off the orderflow winner is what hid healthy hogaplay candles and ADR-0109 repair candles behind a candle-less realtime promotion.
_Avoid_: "source filter" (the semantic is preference + fallback, not filter), "source toggle" alone (loses the fallback semantic), "data preference" (too generic).

**KIS Venue**:
The concrete trading venue requested from KIS candle endpoints for **Live Candle Backfill** — `KRX` maps to KIS `FID_COND_MRKT_DIV_CODE=J`, `NXT` maps to `NX`, and `UN` maps to KIS's integrated KRX+NXT venue. This is not **Source** (`hogaplay` vs `kis_live`) and not the Symbol Master/Screener `market` field (`KOSPI`/`KOSDAQ`). The UI may label the setting as `KRX`, `NXT`, `통합`, `자동`, but code and docs should call the concrete KIS endpoint choice a **KIS Venue**.
_Avoid_: "market" for KRX/NXT/UN (collides with KOSPI/KOSDAQ symbol markets), "source" (collides with captured artifact Source), manually summing KRX+NXT to mean `UN` (KIS `UN` is the authority).

**Venue Routing Policy**:
The `/live` user setting that chooses how **Live Candle Backfill** selects a **KIS Venue**. Explicit policies `KRX`, `NXT`, and `통합` map directly to `KRX`, `NXT`, and `UN`. `자동` is an intraday minute-candle policy: KRX owns the full **Regular Session** (`09:00:00` through `15:30:00`, including opening/closing auction boundaries), and NXT owns eligible extended minutes outside that range within the NXT display/fetch window (`08:00~20:00`). Calendar candles (D/W/M) cannot split one daily bar by intraday venue, so `자동` uses KIS `UN` and should surface that as an automatic-daily integrated fallback. **Scope is the user's open browser tabs** (2026-08-07 결정, `state/crossTabSync.ts`): the selection lives in localStorage `live.venue.v1` and a `storage` subscription mirrors a change into every open tab without a reload, so comparing two venues by keeping two tabs side by side is **not** a supported workflow — switch with the toolbar picker instead.
_Avoid_: treating `자동` as a **Source Preference** (it can mix KRX/NXT by time inside one Stock-Date; Source Preference remains Stock-Date-level preference+fallback), implying NXT real-time hoga support (current hoga panes and WS live data remain KRX/Parquet until a separate NXT WS plan).

**Promotion**:
The conversion step that turns Live Capture JSONL artifacts (`<data_dir>/live/{date}/{code}.jsonl`) into captures Parquet artifacts (`<data_dir>/parquet/{date}/{code}/kis_live/{snapshots,trades,brokers}.parquet` + `meta.json`). Two variants share the JSONL→records parsing logic but differ in trigger, idempotency, and side-effects (see ADR-0038 + ADR-0043):

- **Daily Promotion** — the original 17:00 KST batch run owned by the **Daily Scheduler** (ADR-0034). Walks `<data_dir>/live/{date}/*.jsonl` for **all dates except today**, calls the idempotent `promote_one` (skips if `kis_live/meta.json` already exists), and `shutil.move`'s the source JSONL into `<data_dir>/live/_archive/{date}/` upon success. The today-skip guard prevents collision with Today Promotion. See ADR-0034 — Daily Promotion is a Scheduler-owned step that does not touch the Capture Queue and therefore does not violate the queue-client invariant.
- **Today Promotion** — the in-session N-minute-interval run owned by the `start_today_promoter` asyncio task (ADR-0043). For each active **WatchlistEntry** Code, calls `promote_today(data_dir, *, code)` which re-reads today's full JSONL and **overwrites** the Parquet quartet (atomic_write tempfile + rename). **Does not move the JSONL to `_archive`** — the file is still being appended by **Live Capture**. Default interval `HOGA_LIVE_TODAY_PROMOTE_INTERVAL_S=300` (5 min); kill-switch `HOGA_LIVE_TODAY_PROMOTE_ENABLED=false`.

Both variants make the Stock-Date readable through `/api/range` with `source=kis_live` once they complete. Invariant: the two variants are responsibility-disjoint by date — Today Promotion handles today only, Daily Promotion's loop skips today. Midnight handoff is atomic via `shutil.move` and the next sleep cycle of Today Promotion picks up the new today_kst. Promotion produces snapshots/trades/fills/brokers Parquets only — never candles; the candle dimension of the `kis_live` Source is served by **Live Candle Backfill** through a separate cache (see below and ADR-0040). **Encoding contract**: Live Snapshot `t_ms` (Unix ms per ADR-0003) is converted to HHMMSSmmm packed-decimal at Promotion write time and stored in the `ts_ms` column, so kis_live promoted Parquet honors the same on-disk encoding invariant that hogaplay Parquet does (ADR-0010 — series-builder SQL decodes HHMMSSmmm via `hhmmssms_to_intra_ms_sql("ts_ms")`; ADR-0049 — writer-side normalization).
_Avoid_: "rollup" (collides with frontend aggregation like StockDateGroup rollup), "compaction" (suggests merging multiple Parquet files — Promotion is JSONL→Parquet, not Parquet→Parquet), "finalization" (overloaded with capture COMPLETE phase), "archival" (suggests data is being moved offline — Promoted Parquet is the *active* artifact), bare "promote" alone in domain prose (qualify as Daily Promotion or Today Promotion since the side-effects differ).

**Live Merged Cache (라이브 병합 캐시)**:
브라우저 React Query에 보관하는 국내 분봉·범위 지표의 병합 이력. 종목 전환 후에도
최근 사용한 최대 64개 닫힌 종목을 재사용하며, 공용 추정 payload 예산은 512MiB다.
열린 차트가 소비 중인 identity는 용량 회수와 idle GC에서 보호한다. 사용이 끝나면
기존 2시간 gcTime이 적용되고, 지표 병합본은 최대 128개를 보관한다(현재 소비 중인
항목은 예외). 용량은 배열 표본 기반 추정이며 브라우저 전체 heap 상한이 아니다.
갱신 주기와 보관 수명은 별개이며 새로고침을 건너뛰는 영속 저장은 하지 않는다.
개발 모드 `window.__liveCacheStats()`로 추정 크기·보호 항목 수·회수 사유를 확인한다.
원본 `range` 캐시도 별도 추정값으로 표시한다. 병합본과 객체를 공유할 수 있으므로
두 추정값을 합산해서 브라우저 heap 사용량으로 해석하지 않는다.

**Live Candle Backfill**:
`/live` 페이지가 KIS REST 를 직접 호출해서 받아온 OHLCV 캔들. 두 KIS endpoint 를 사용한다:
- **분봉** (1m/3m/5m/10m/15m/30m timeframe): `GET /api/live/past-candles` → KIS `inquire-time-dailychartprice` (TR_ID `FHKST03010230`). 응답은 1분봉, 백엔드가 **KIS Candle Cache** 에 임시 보관한다. 250-day hard cap (payload 보호 — 1년치 일봉을 분봉으로 보내면 ~5MB). 프론트는 3m/5m/.../30m 을 1분봉에서 client-aggregate. 분봉의 cache hit/fetch fanout/AUTO venue merge/rate-limit warning orchestration 은 `hoga/live/live_candle_backfill.py` 의 `LiveMinuteCandleBackfill` 이 소유하고, FastAPI route 는 request validation + wire envelope 만 맡는다.
- **분봉 비거래일 빈 결과**: KIS 거래일 캘린더가 휴장일로 아는 Stock-Date 는 캔들이 없는 정상 결과로 간주한다. 이는 누락(missing)이 아니라 커버된 날짜(covered date)라서 NXT/AUTO venue fallback 이 KRX 로 재조회하지 않는다.

- **일봉** (D/W/M timeframe): `GET /api/live/past-daily-candles` → KIS `inquire-daily-itemchartprice` (TR_ID `FHKST03010100`, period_div_code='D'). 응답은 일봉, 백엔드가 **KIS Candle Cache** 에 임시 보관한다. cap 없음 (KIS 보유 기간 ~20-30 년이 자연 상한). 프론트는 D 를 그대로, W/M 는 client-aggregate. 일봉의 venue fallback/AUTO integrated warning/KIS scheduling orchestration 은 `hoga/live/live_daily_candle_backfill.py` 의 `LiveDailyCandleBackfill` 이 소유하고, gap/cache/today tri-state walkback 은 investor-net 과 공유되는 `batched_daily_walkback` 을 주입받아 사용한다.

현재 키움 분봉의 수정계수(수정/원 일봉)는 각각 거버너 대기표를 얻은 뒤 동시에 조회하며, 같은 종목의 여러 창은 완성된 계수 테이블을 공유한다. 일별 투자자 조회는 최신 과거 gap에 당일을 함께 요청해 별도 당일 왕복을 줄인다. 당일 행은 과거 배치에서 제외하고 기존 60초 TTL에만 저장하며, 긴 walk에서는 첫 페이지 시점부터 나이를 계산해 필요하면 다시 갱신한다. 캘린더가 확실히 휴장일로 아는 gap은 빈 커버리지로 캐시하고, 달력이 모르는 날짜는 계속 조회한다. 선행 워밍은 추가하지 않는다(ADR-0103).

키움 REST 거버너의 HTTP 실행 상한은 기본 12개이며, 그중 background 실행은 최대 4개로 제한한다. 기존 폴링의 동시성을 유지하면서 종목 전환의 `user_visible` 조회가 사용할 슬롯 8개를 확보한다. 초과 background는 워커 안에서 기다리지 않고 공용 우선순위 큐에 남는다. 대기 요청의 승격·중복 병합, 준비된 다른 TR 통과, `(앱키, TR)`별 발사 간격은 기존과 같다. 12는 유량 상한이 아닌 HTTP 동시성 상한이며 벤더 제한을 우회하지 않는다. 화면 조회가 계속되면 background가 기다릴 수 있다는 기존 우선순위 정책도 유지한다.

계정 선택은 TR 버킷뿐 아니라 private/market이 공유하는 읽기 예산의 다음 허용 시각도 확인한다. 모든 준비된 계정의 시각은 동률로 취급하고 현재 실행 수가 적은 계정을 고른다. 토큰을 비동기로 읽는 동안 아직 공용 예산을 예약하지 못한 서로 다른 TR이 첫 계정에 몰리는 것을 막는다. 예산에 막힌 요청은 큐에 남기며 실제 예산 획득은 기존 클라이언트에서 수행한다. 계정 확인 후 같은 계정의 provider가 예산을 합치는 정책, read/write 분리와 기존 간격은 유지한다.

둘 다 **Live Capture** (10초 폴링으로 snapshot/trade/broker raw 이벤트 수집) 와 다른 호출 — KIS 의 *pre-aggregated candle* endpoint 만 사용하는 on-demand 호출. 두 캐시는 서로 독립 (한쪽이 분봉, 다른쪽이 일봉이라 같은 데이터가 양쪽에 중복될 수 없음). `/api/range` 의 promoted Parquet 호출과도 독립 — promoted Parquet 은 snapshots/trades/brokers 만 담고 candle 은 안 담기 때문. ADR-0040 (분봉) + ADR-0048 (일봉) 두 결정으로 둘 다 *별도 cache + 별도 endpoint* 를 갖는다. 두 endpoint 모두 KIS 가 `EGW00201` ("초당 거래건수 초과") 을 반환하면 **KisClient** 가 (1s, 2s, 4s) 지수 backoff 으로 자동 재시도 — handler 까지 `KisRateLimitError` 가 도달하면 그건 이미 client retry 가 exhausted 됐다는 신호이고 해당 (date | gap batch) 만 `kis_rate_limit` warning 으로 surface (ADR-0050).
_Avoid_: "past candles" 단독 (소스를 잃음 — KIS-specific), "historical candles" (replay candle wire 와 중첩), "candle backfill" 단독 ("Live" 페이지 scope 누락), treating a known non-trading Stock-Date as missing data.

**KIS Candle Cache**:
**Live Candle Backfill** 이 KIS REST candle 재호출을 줄이기 위해 프로세스 메모리에만 보관하는 임시 cache. 사용자 보존 데이터나 공식 chart **Source** 가 아니며, disk artifact 가 아니다. Cache hit 는 `/api/live/past-candles` / `/api/live/past-daily-candles` 가 KIS 재호출 없이 응답하는 근거가 되고, **KIS REST Bypass** 중에는 memory cache hit 만 표시하고 cache miss 는 `kis_rest_bypassed` warning 과 빈 구간으로 남긴다. Process restart, eviction, server deploy 로 cache 가 사라져도 데이터 손실이 아니며 **Inventory**, **DiskState**, **Source Preference**, `/api/range` completeness 는 변하지 않는다.
_Avoid_: treating KIS Candle Cache as a **Source**, putting it under the official `parquet/<date>/<code>/<source>/` tree or any new disk-cache namespace, expecting `/api/range` to read it, or describing restart/eviction loss as data loss.

**Hogaplay Candle Fallback**:
`/live` 이 **Live Candle Backfill** 을 사용할 수 없거나 사용하지 않기로 한 경우, promoted hogaplay Parquet 의 captured candle rows 를 `/api/range` 로 읽어 현재 **Timeframe** 의 chart candles 로 쓰는 대체 candle source.
_Avoid_: calling it KIS candle integration, treating it as a **KIS Candle Cache** hit, or expecting it to fetch KIS REST.

**Live Investor Net**:
`/live` 일봉(D) 차트의 외국인/기관 **순매수 수량** 보조지표. KIS `investor-trade-by-stock-daily` (TR_ID `FHPTJ04160001`, [0416] 종목별 일별동향) 를 `GET /api/live/past-investor-net?code=&from=&to=` 로 호출 — Live Candle Backfill 의 sibling 이고 **임의 장기 구간**을 받는다: KIS 가 `FID_INPUT_DATE_1`(기준일) + ~30영업일을 `output2` 로 주면, 기준일을 (page oldest − 1) 로 옮기며 `from` 까지 뒤로 페이징(일봉 `fetch_past_daily_candles` 의 cursor walk-back 과 동일). 응답은 일봉과 동형 `{code, from, to, points:[{t_ms, foreign_net, institution_net}], cached_batches, fresh_batches, data_warnings}`; `foreign_net`/`institution_net` 은 부호 있는 순매수 *수량* (양수=순매수, 음수=순매도; KIS raw `frgn_ntby_qty`/`orgn_ntby_qty` 를 `output2` 에서 정규화). `t_ms` 는 일봉과 **동일한 09:00 KST 앵커** (`_daily_anchor_t_ms`). KIS scheduling + row conversion 은 `hoga/live/live_investor_net_backfill.py` 의 `LiveInvestorNetBackfill` 이 소유하고, 캐시·gap/today tri-state 로직은 일봉과 같은 `PastDailyCandlesCache` + `batched_daily_walkback` 을 재사용한다(별도 투자자 캐시 없음; 당일 행은 ~15:40 이후 가집계라 today tri-state 로 잠정 처리). 프론트는 `RangeBundle.investorPoints[]` 별도 배열로 싣고 (`Candle` 에 안 넣음 — 분봉이 null 보유 회피), 외국인/기관 각각 별도 히스토그램 pane 으로 부호색 (순매수 빨강 `--price-up` / 순매도 파랑 `--price-down`) 렌더. **D(일봉) 전용** — 투자자 점이 일별 앵커라 W/M 집계 segment 와 정렬 안 됨. ADR-0055.
Representative Index 의 시장 단위 투자자 순매수는 sibling endpoint `GET /api/live/index-investor-net?index_id=&from=&to=` 로 분리한다. `KOSPI`/`KOSDAQ` 처럼 `investor_scope="market"` 인 index 만 지원하며, KIS `inquire-investor-daily-by-market` (TR_ID `FHPTJ04040000`) 을 `LiveIndexInvestorNetFetcher` 가 KIS Capacity Scheduler 를 통해 호출한다. Unsupported index 는 422 `unsupported_index_investor_net`.
_Avoid_: "수량" 과 "금액" 혼동 (KIS 는 `_ntby_tr_pbmn` 금액도 주지만 본 지표는 *수량* `_ntby_qty` 만), `inquire-investor`(FHKST01010900) 와 혼동 (그건 30일 고정 API — 본 지표는 장기 `FHPTJ04160001`).

**Pane Legend**:
`/live` 차트의 각 pane 좌상단에 얹는 **라벨 + 색상 + 커서 시점 값** readout row. `PaneLegendOverlay` 가 렌더하며, Drawing Overlay 의 `chart.panes()` 좌표 패턴(`chartCoordinates.paneTopY`)을 재사용한다 — per-pane HTML 컨테이너는 없고, pane Y-오프셋을 누적해 차트 위에 절대배치한 단일 HTML 오버레이다. 값은 커서(real Unix-ms)를 따라가며 series 별 nearest-bar lookup 으로 해석(공유 정수 index 아님 — series 마다 sampling cadence 가 다름). 아이콘: ✕ = 지표 끄기(보조지표 popover 토글과 양방향 연동), 눈(👁, 이동평균선만) = MA 선 일시 숨김(`movingAverageHidden`; 설정 유지). MA row 는 고정 4개가 아니라 `store.movingAverages`(가변 슬롯, 최대 8) 를 순회한다.
_Avoid_: bare "Legend" (Capture form 의 status legend `calendarStatus.ts::legendLabel`/`LEGEND_ORDER` 와 충돌) — 항상 "Pane Legend" 로 한정. "범례" 단독도 마찬가지.

**KisClient**:
`hoga/live/kis_client.py` 의 단일 async HTTP wrapper — Live Capture 영역의 모든 KIS Open API 데이터 fetch 가 통과하는 *single ingress*. 토큰 발급/갱신 (`get_access_token`, 1-per-minute reissue cool-down), account별 15 calls/sec 토큰 버킷 (`_RATE_LIMIT_CALLS_PER_SEC`; 런타임 주입은 `kis_runtime._account_rate_limiter` — 계정마다 rate 15/capacity 4 전용 버킷, ADR-0100), EGW00201 자동 retry ((1.0, 2.0, 4.0)s backoff, `_RATE_LIMIT_BACKOFF`) 세 가지를 메서드 호출자에게 투명하게 제공한다. **Invariant (ADR-0050)**: KIS endpoint 를 직접 hit 하는 production 코드는 추가하지 않는다 — `httpx.AsyncClient` 로 `openapi.koreainvestment.com:9443` 을 직접 부르는 새 코드가 review 에 등장하면 본 ADR 위반. 진단/probe 같은 합법적 single-shot 케이스는 `_get(..., retry=False)` opt-out 으로 명시적으로 표기한다. `KisClient` 싱글턴은 `account_id`별 dict(`kis_runtime._kis_clients`)로 관리되고, "한 앱키 = 한 버킷"은 account별로 보존된다. 기존 `kis_access.kis_for_role("foreground"|"background")` 의 role→account 라우팅은 **KIS Capacity Scheduler 이전의 compatibility path** 다: 새 capacity 모델에서는 "사용자가 기다리는가"를 account role 이 아니라 scheduler priority(`user_visible`/`background`)로 표현하고, account 선택은 **KIS Capacity Scheduler** / account pool 이 소유한다. migrated route 에 dual allocator/feature flag 는 두지 않고, 기존 role routing 은 아직 migrate 되지 않은 caller 전용 compatibility path 로만 남긴다. 기존 별칭 `ensure_kis_client_from_env`/`get_kis_client()`는 account 0.
_Avoid_: "the KIS client" 라는 모호한 표현 (이 코드베이스엔 단 하나, 항상 capital `KisClient`), "KIS HTTP layer" (HTTP 외에도 토큰 lifecycle + retry 정책을 담음).

**KIS REST Access**:
KIS REST caller 가 건너는 capacity-aware 실행 seam (`hoga/live/kis_access.py`). Public direction 은 `run_with_capacity(..., endpoint=KisRestEndpoint.*, priority=..., key=..., cooldown_scope=..., fetch_fn=...)` 로 semantic KIS request 를 제출하는 것이다: caller 는 "어떤 KIS REST request 인가" 와 user-visible/background priority 만 말하고, account 선택·healthy filtering·scheduler vs compatibility Adapter 선택은 이 Module 뒤에 숨긴다. `KisRestEndpoint` 는 scheduler cooldown key, `/api/live/status` snapshot, logs/tests 에 남는 안정 값이라 raw string 을 받지 않는다. `kis_for_role` / `fetch_for_role` 은 **KIS Capacity Scheduler** 로 아직 migrate 되지 않은 caller 를 위한 legacy compatibility Adapter 다; 신규 production caller 는 `KisClient` 를 직접 빌리는 대신 KIS REST Access 를 통과해야 한다. 이 Module 은 공통 KIS execution/classification 을 소유하지만, `/quotes` 의 빈 결과·`/past-candles` 의 `data_warnings`·Screener skip/log 같은 wire/degradation policy 는 각 domain Module 이 소유한다.
_Avoid_: "KIS client resolver" (client lease 를 public Interface 로 오해시킴), raw endpoint strings (`"past-daily"` 등 — `KisRestEndpoint` 사용), "KIS service" (Module/Interface/Adapter 용어 사용).

**KIS REST Bypass**:
The data-dir scoped, persisted user setting that forbids **KIS REST Access** data requests and forces cache/stored-data fallback for KIS REST-backed surfaces. It lives with the other `/live` write-policy settings in `<data_dir>/live_settings.json`, so it survives app restart until the user explicitly turns it off. It does not disable **KIS WebSocket** live capture, **Live Set** subscriptions, or the WS approval-key request needed to establish a KIS WS connection; those require a separate future "KIS 전체 차단" decision.
Runtime suppression wins over **Storage Policy** execution without mutating the stored **Storage Policy** value: `rest_only + KIS REST Bypass` means no new live storage until bypass is turned off, but the `rest_only` intent remains saved for later.
It also does not mutate **Source Preference**: already-written `hogaplay`, `kis_live`, and `kis_api` **Source** artifacts remain displayable through normal preference+fallback rules because bypass controls new KIS REST data calls, not stored-data eligibility.
_Avoid_: "KIS API 우회" in domain prose without clarifying REST-data scope, treating bypass as a **Storage Policy**, using it to mean **Source Preference**, or assuming it deletes/invalidates cached KIS data.

**KIS Capacity Scheduler**:
KIS REST 계정을 capacity pool 로 보고 `KisClient` 위에서 semantic KIS request 를 조율하는 프로세스 로컬 async scheduler. `hoga/live/kis_capacity_runtime.py` 가 `data_dir` 기준 process-wide scheduler lifecycle 을 소유해서 `/api/live/*` route 와 screener/background caller 가 같은 capacity pool 을 공유한다. Scheduler worker 수와 `KisAccountPool` 계정 목록은 생성 시점 기준 기본 `clamp(configured_accounts * 8, 4, 64)` / configured account ids 로 고정하고, `HOGA_KIS_CAPACITY_MAX_WORKERS` 로 worker override 가능하다; account 수/env 변경은 hot reload 하지 않으며 app restart 또는 `aclose_kis_capacity_scheduler(data_dir)` 후 recreate 때 반영한다. worker 는 동시 실행 슬롯일 뿐 rate-limit 권한자는 아니며 15 calls/sec 제한은 **계정(앱키)별** `_account_rate_limiter(account_id)`(계정마다 전용 토큰버킷, `kis_runtime.ensure_kis_client`)가 소유한다 — KIS 는 app key 단위로 ~15 calls/sec 를 집행하므로(실측 2026-07-10, ADR-0100) configured 계정 수에 비례해 REST 콜레이트가 늘어난다(3계정 실측 3.03x). Pending capacity 는 기본 1000 unique scheduled request key(`HOGA_KIS_CAPACITY_MAX_PENDING`)로 제한하고, 이미 존재하는 key 로 coalesce 되는 waiter 는 이 limit 을 소모하지 않는다; 초과 시 `KisCapacityOverloaded` 로 user-visible route 는 `capacity_overloaded`, polling/background route 는 graceful fallback 한다. `snapshot()` 과 `/api/live/status` 는 configured/healthy account count, `max_workers`, `max_pending_requests`, queued/inflight, cooldowns, background deferral counters, overload counter 를 노출한다. FastAPI shutdown 은 `aclose_kis_capacity_scheduler(data_dir=None)` 를 `aclose_kis_client()` 전에 호출해 scheduler worker 와 in-flight shared request 를 먼저 정리한다. 동일 request key 를 coalesce 하고, `user_visible` 요청을 `background` 보다 우선하며, 건강한 계정 중 least-loaded 계정을 lease 해서 그 계정의 `KisClient` 로 실행한다. queued `background` request 에 같은 key 의 `user_visible` waiter 가 붙으면 request 를 `user_visible` 로 promote 한다(이미 running 이면 중단하지 않고 같은 future 만 공유). 새 capacity 모델에서 account 0/1/2/... 자체의 foreground/background 역할은 동일하고, 사용자 보호는 account identity 가 아니라 scheduler priority 와 background reservation 으로 표현한다: healthy 계정이 2개 이상이면 `background` 는 해당 request cooldown key 기준 마지막 usable account 를 점유하지 못하고, `user_visible` 요청이 queue 에 있으면 새 background 요청을 시작하지 않는다(단일 계정 설치는 예외적으로 공유). Background aging 은 두지 않는다 — user-visible 이 계속 오면 background starvation 을 허용하고, 대신 `background_deferred_due_to_user_visible` / `background_deferred_due_to_reserved_capacity` counters 로 원인을 관측한다. Reserved-capacity deferral 은 scheduler 내부에서 즉시 requeue 하지 않고 `KisAccountPool.reserved_background_capacity_available(...)` 이 해당 cooldown key 에 대해 실제 여유 capacity 를 보고할 때까지 wait/requeue 하며, quotes/investor 같은 polling route 는 route-level timeout 으로 빠르게 fallback 한다. 이 route-level timeout 은 `asyncio.shield(...)` 로 scheduler shared future 를 감싸 HTTP 응답만 포기하고 coalesced scheduled request 자체는 취소하지 않는다. `LiveRestPoller` 와 `Rest30sRecorder` 는 `ScheduledLiveRestCaptureClient` proxy 를 통해 background request 를 제출한다 — **ADR-0098 이후 기본은 `live-orderbook`(10호가) 만**이고, `Rest30sRecorder` 는 코드 간 동시 디스패치(`concurrency=10`, bounded gather)로 계정별 합산 REST 예산(~15콜/s×계정수)을 채운다. `capture_aux=True` 일 때만 `live-trades`/`live-brokers` 3콜을 복원한다(체결 실시간·저장은 WS 관심종목 전용). `BrokerRestPoller`(source `live-broker-poller`, ADR-0111)도 같은 proxy 로 live_set 종목의 `live-brokers`(거래원) 를 background 로 30초 폴링해 WS member TR(H0STMBC0) 제외분을 메운다(76종목@30s ≈ 2.5콜/s). Screener EOD gap catch-up 과 one-time raw/adjusted daily backfill 은 `SCREENER_DAILY`, Screener intraday overlay 는 `QUOTES` background request 로 같은 pool 을 쓴다. `KisClient` retry 가 exhausted 된 `KisRateLimitError` 이후에는 `(account_id, endpoint, venue_or_scope)` 단위 cooldown 을 걸어 해당 계정만 잠시 제외한다. **Rate 상한(재정정, ADR-0100):** KIS REST limit 은 **앱키(계정)별 독립 ~15/s**다(2026-07-10 재실측: 3계정 45/s 지속 송신 EGW00201 9.0% 평탄·goodput 40.5/s·3.03x; 2026-07-07 '명의 단위' 실측은 재현 실패, 측정 오염 추정). 코드는 `_account_rate_limiter(account_id)`로 계정마다 전용 버킷을 준다. 계정 풀은 WS 등록 슬롯·레이트리밋 페일오버·워커 동시성에 더해 **REST 콜레이트도 계정 수에 비례 증설**한다. 키당 15/s 송신 시 EGW00201 ~9%는 KisClient `(1,2,4)s` backoff 가 흡수한다. 일일 누적 쿼터는 미검증이며, 07-07 재발 대비 `_SHARED_BUCKET_KEY=0` 롤백 노브로 전역 클램프를 1줄 복원할 수 있다(ADR-0100). HTTP 호출, auth/token lifecycle, 계정별 15 calls/sec token bucket, EGW00201 `(1,2,4)s` retry 는 계속 **KisClient** 소유다(ADR-0050 invariant 유지).
_Avoid_: "KIS queue", "KIS job queue", "Capture Queue" 와 혼동되는 표현. Capture Queue 는 (Code, Stock-Date) **Full Capture** 작업 큐이고, KIS Capacity Scheduler 는 KIS REST 요청 capacity 관리기다. 공개 문서/테스트에서는 "job" 보다 "request" / "scheduled request" 를 사용한다.
`/api/live/index-candles` 는 대표지수 일봉/분봉을 `INDEX_DAILY`/`INDEX_MINUTE` user-visible scheduled request 로 제출하고, route-owned cache/windowing policy 는 유지한다.
Production KIS REST caller 는 `run_with_capacity` 에 real scheduler 를 넘겨야 한다; `scheduler=None` fallback 과 `kis_for_role` / `fetch_for_role` 은 legacy compatibility test 또는 emergency fallback 전용이다.

**REST Supervisor Degraded**:
A component-local health state on KIS REST supervisor loops such as `LiveRestPoller`, `Rest30sRecorder`, and `ProgramTradeCollector`, meaning that the component's last cycle saw one or more KIS REST or local processing failures. It is distinct from REST-degraded account health: it does not mark any `account_id` unhealthy, does not affect **KIS Capacity Scheduler** account eligibility, and clears when the component completes a zero-error cycle.
_Avoid_: using component `degraded` status to mean `account_health.is_rest_degraded(account_id)`, changing scheduler account selection from a supervisor status field.

**Screener**:
`/screener` 페이지·기능 — 전 시장 일봉 코퍼스를 사용자가 **빌트인 조건 카탈로그**(거래대금·신고가·신고거래량·등락률·현재가 범위·이동평균)에서 고른 **조건**들을 A·B·C로 참조하는 **AND/OR·괄호 조합식**으로 걸러 캡처할 가치가 있는 **Code** 를 찾는다. 이 조합은 이름 붙여 **저장된 조건검색(SavedScreener)** 으로 저장/조회한다(2026-05-31 Saved Screener spec). 조회 연산은 동사 **scan**(`run_scan`); 결과 클릭은 **activeCode** 를 설정해 `/live` 호가 차트로 점프한다(Watchlist Panel 과 같은 jump-to-chart 패턴). 데이터는 `<data_dir>/screener/` 하위의 전 시장 일봉-OHLCV 코퍼스 — **원주가 아카이브**(`daily_unadjusted.parquet`, append-only 진실원천; dev-tradingview TimescaleDB 1회 시드 + KIS 일봉 append)와 거기서 split-보정으로 파생한 **수정주가 store**(`daily_adjusted.parquet`, scan 대상). 기본 API basis 는 `eod`로 호환을 유지하며, 풀페이지·드로어의 `basis="auto"`는 서버가 최신 적용 가능한 기준을 선택한다. 장중에는 키움 `ka10095`의 OHLCV row를 query-time overlay로 `daily_adjusted` 위에 얹고, 실제 기준 시각을 응답한다(시세 실패 시 확정 데이터 대체). per-Stock-Date 캡처 산출물과 구별된다 — Screener 코퍼스는 전역·일봉 입도·다년·읽기전용 scan 대상이고, **Source**(hogaplay/kis_live) 분류 밖이다. 수정주가 SSOT 는 KIS 공식 수정주가(`FID_ORG_ADJ_PRC=0`, /live 와 동일) — 오프라인 보정의 의심 종목만 KIS 값으로 교차검증·교체한다.
_Avoid_: "scanner" (dev-tradingview 차용어 — hoga 는 **Screener** + 동사 **scan**); 원주가 store 를 "raw" 로 (이미 `raw/{date}/{code}` = 파싱 전 hogaplay Page 의미와 충돌 — **원주가/unadjusted** 사용); 상태 파일을 `meta.json` 으로 (Stock-Date 캡처 meta.json 과 충돌 — Screener 는 `status.json`); `ohlcv_daily` (Timescale 테이블명 누수 — `daily_unadjusted`/`daily_adjusted`).

**Lookback Window (N)** / **Record Period (M)**:
Screener 신고가/신고거래량(**Breakout**) 조건의 두 거래일 파라미터. **Record Period (M)** = 어떤 날이 신고로 인정받으려면 넘어야 하는 직전 윈도우("500일 신고가"). **Lookback Window (N)** = 그 신고가 얼마나 최근에 일어났어야 하는가("최근 200일 내"). 한 **Code** 는 *최근 N거래일 중 하루라도 M일 신고를 낸 적이 있으면* 매치. 둘 다 달력일이 아닌 **거래일**; 이식한 scan SQL 이 `lookback`/`period` 로 그대로 부른다. `period > lookback` 은 정상(헤드라인 "200일내 500일").
_Avoid_: N 을 "recency" 로 (초기 반쪽 명명 — **Lookback Window**); 달력일 해석(둘 다 거래일 카운트).

**주기별 기간내 신고거래량**:
화면의 모든 주기별 조건은 진행 중 봉을 항상 포함한다(2026-10-19 사용자 요청).
선택 체크박스는 없으며 기존 `include_open_bar=false` 저장본과 로컬 초안도 화면에서
불러올 때 true로 전환한다. 이전 완료봉 전용 결과 스냅샷은 재사용하지 않는다.
API의 기존 false 지원은 호환을 위해 유지하며, 전환된 조건은 저장 시 true를 기록한다.
이전 false 조건으로 제외한 발생 건은 true 조건에도 적용한다. 기존 제외 ID·복원 이력은
그대로 유지하고 조건의 주기·비교값·발생 봉 범위는 넓히지 않는다.
진행 중 봉은 조회 시점까지의 값이므로 종가·이평·등락률 판정은 장중 바뀔 수 있다.
`new_high_vol`의 최근 방식은 `timeframe`(1/3/5/10/15/30/60분, D/W/M)과
`include_open_bar`를 받는다. 미지정은 기존 D·진행 중 포함이며 기존 일봉 SQL 의미와
저장·제외 키를 유지한다. 다른 주기의 N/M은 선택 주기의 **봉 수**다. M은 후보 봉을
포함하며 동률을 인정한다. W/M은 실제 거래일 일봉을 ISO 주/달력 월로 합산한다.
새 날짜 방식은 `record_period.unit="bars"`이며 봉 시작 날짜를 발생 범위로 고르고,
종료일 이후 데이터를 사용하지 않는다. 기존 일봉 년/거래일 날짜 조건도 유지한다.
분봉은 KRX 정규장·벤더 원본 거래량, D/W/M은 기존 보정 일봉 거래량 기준이다.
진행 중 봉은 조회 시점까지의 누적값이다. 관심종목·히트맵 범위를 선택한 진행 중 포함
1분봉 `new_high_vol`·`new_high_vol_today` 감시는 서버 소유 모니터가 종목별 과거 이력을
공유하고, 기존 KRX 구독의 collector 측 절대 거래량 상태를 별도 IPC로 받아 갱신한다.
준비는 동시 4개 작업으로 계속 진행하며 화면 조회 주기를 기다리지 않는다. 이력은
15초 만료 없이 재사용하고 API는 최초 준비·누락 복구·5분 대조에 사용한다. 결과 조회는
지원하는 1분봉 이력의 REST를 유발하지 않는다. 다른 조건을 섞으면 해당 조건의 기존
갱신 시점을 따른다. 준비·수신·복구·이력 부족·미수신과 범위 오류를 표시한다.
연결 세대 변경·15분 재전송 범위를 넘는 공백은 재검증 전 판정을 보류한다. 부분 현재
봉은 거래량 하한만 인정하며 불완전한 비교 봉으로는 판정하지 않는다. 완료 API 봉은
15초 정착 후 하향 정정도 반영한다. 거래 없는 0봉을 만들어 채우지 않는다.
모니터 heartbeat는 30초, lease·중지 후 메모리 재사용은 5분이다. 서버 재시작 시 다시
준비하며, 512종목·250,000봉·보수적 64MiB 예약 한도를 넘으면 명시적으로 거절한다.
장 종료 후 반복 조회는 멈춘다. 범위를 선택하지 않은 전 시장 조회와 다른 분봉 주기는
기존 경로를 유지하며 전 시장 동시 실시간 감시로 안내하지 않는다.
분봉 REST는 페이지별 거버너·요청 예산·메모리 캐시를 사용한다. 예산 초과·누락·달력
미확인은 `bar_coverage`로 알리고 확인된 발생 건만 반환한다. 전 시장 동시 틱 감지는
보장하지 않는다. 발생·제외는 `bar_start_ms`를 보존해 같은 날의 서로 다른 봉을 구분한다.
_Avoid_: N/M을 주기와 무관하게 거래일로 해석; 일봉 거래량 보정을 분봉에 복사;
진행 중 봉의 누적 거래량에 스냅샷을 중복 합산; 미확인 이력을 미충족으로 단정.

**스크리너 수동 갱신**: `/api/screener/update`는 `ka10099` 종목 목록을 강제 갱신하고
신규 종목을 로스터에 즉시 추가한 뒤 종목별 과거 일봉의 앞부분·중간·최근 누락을
거래일 달력과 상장일(`regDay`)로 확인한다. 상장 전·확인된 상장폐지 이후·확인된
거래정지 기간은 수집 대상으로 세지 않는다. 달력보다 이전의 상장 구간도 공급자에
한 번 조회하며, 공급자 응답에 없는 날짜를 거래정지라고 추정하지 않는다.
원주가·수정주가 쌍과 수정계수를 검증하고 기존 원주가·수정주가를 모두 보존할 때만
누락 행을 추가한다. 실패 종목은 격리하고 다음 갱신에서 재시도한다.
`refresh_report.json`에 보충 행 수·신규 종목 수·오류·공급자 미제공 내역을 남기고,
`status.last_refresh`와 완료 이벤트로 화면 재접속 후에도 결과를 복원한다.
자동 EOD 작업은 기존 전역 날짜 캐치업을 유지하며 수동 요청이 합류하면 이후
종목별 보충까지 수행한다. 진행 중 요청은 단일 서버 소유 job을 공유한다.
설정의 종목 목록은 개수·조회 시각·상태만 보여 주며 별도 Update Now 버튼은 없다.
일반 갱신은 스크리너에서 하고, 종목 검색창의 목록 복구용 갱신은 유지한다.


2026-10-20 장중 분봉 거래량 확장: 최근 방식의 `new_high_vol`·`new_high_vol_today`는
REST 비교 봉 준비 후 부모 LiveBuffer의 KRX 체결 누적거래량으로 진행 중 봉을 갱신한다.
기준 도달·봉 교체 이벤트를 100ms로 모아 보내고 페이지/실행 중 감시 패널이 250ms로
모아 재조회한다. 정기 조회·숨김/장마감 게이트는 유지한다. 새 브로커 구독은 만들지 않는다.
중간 수신의 거래량 하한은 `volume_is_lower_bound`/`최소 N주`로 표시하고, 불완전한
종료 봉을 비교 최대값으로 사용하지 않는다. IPC gap·분 경계 누락은 REST 확인 대상으로
남긴다. 감시 상태는 512개/250,000봉·5분 만료이며 전 시장 동시 감지는 지원하지 않는다.
`bar_coverage.realtime`의 prepared/receiving으로 요청 조건의 준비·최근 체결 반영 종목
수를 구분한다. 화면의 조건 요약은 `1분봉 · 최근 5봉 이내 · 100봉 신고거래량`이다.
설계·전 시장 슬롯 산술·검증 한계는 [장중 거래량 계획](docs/plans/2026-10-20-screener-live-volume.md) 참조.

**스크리너 결과 UI**: 종목명·코드 검색, 정렬, 현재 시세/조회 당시 보기, 종목 열기와 관심종목을 제공한다. 결과 선택 체크박스·선택 해제·CSV 내보내기는 제공하지 않는다.

`bar_coverage.complete`는 검색에 걸린 종목 수가 아니라 필요한 전체 봉 이력을
확보한 종목 수다. 달력 부족·상장 전 구간·상장폐지 이후 구간·확인된 거래정지·
공급자에 존재하는 일봉의 수집 누락·원인 미확인을 나누고 원인별 고유 종목 수와
부족 날짜를 표시한다. `<data_dir>/screener/history_evidence.json`은 수동 갱신 및 명시적 운영
조사에서 출처·확인 시각과 함께 기록한 사실만 읽는다. 스캔 중 원격 조사는 하지
않으며, 최초 관측일을 상장일로, 최신 마스터 부재를 상장폐지로 추정하지 않는다.
누락 날짜 보충은 벤더 원주가·수정주가 쌍을 검증하고, 새 계수로도 기존 수정주가가
모두 동일하게 재현되는 경우에만 기존 원주가·수정주가를 보존하며 추가할 수 있다.
기존 과거 일봉 수집의 불일치 거부 정책은 유지한다.

**주기별 가격 조건과 최신 봉 신고거래량**:
`new_high_today`·`new_high`·`new_high_vol_today`·`high_off_peak`·`ma`도 조건마다
`timeframe`(분·일·주·월)과 `include_open_bar`를 저장한다. 누락은 D/true이며
기존 일봉 SQL과 발생 제외 키를 보존한다. 기간 숫자는 선택 주기의 봉수다.
신고가·신고거래량의 최신 변형은 최신 선택 봉 하나, 기간내 신고가는 최근 N봉을
각각 자기 시점의 후보 포함 M봉과 비교한다. 고가 근접도는 현재 **봉 고가**를
최근 M봉 최고가와 비교하며 기존처럼 보유 이력으로 판정하되 부족분은 커버리지에 남긴다.
이동평균은 선택한 OHLC 기준가격과 같은 가격의 M봉 SMA를 비교하며 풀윈도우가 필요하다.
주·월 OHLC는 보정 일봉의 첫 시가·최고 고가·최저 저가·마지막 종가로 집계한다.
분봉은 KRX 정규장 원주가를 받아 모든 과거 페이지에 동일한 최신 기준일의 수정계수를
적용하고, 분봉 거래량은 원본을 유지한다. 계수 미확인 구간은 가격 비교에 사용하지 않는다.
가격 발생의 `bar_price_match`에는 주기·기준가격·평가값·비교값·창 시작·진행 상태·조회 시각을
보존하며 봉별 제외에도 전달한다. 조건 간 AND는 종목 교집합, OR는 종목 합집합이며 발생 시각 일치는 요구하지 않는다.
조합식 미지정은 기존 전체 AND다. 괄호가 먼저, AND가 OR보다 우선하며 미참조 조건은 평가하지 않는다.
_Avoid_: 분봉 가격 보정을 페이지별 `base_dt`의 벤더 수정 옵션으로 대체;
분봉 거래량에 가격 계수를 적용; 고가 근접도를 종가 근접도로 변경; 진행 중 이평 충족을 영구 발생으로 고정.

**장중 일봉의 거래일과 확정 데이터 대체**:
키움 복수시세에는 거래일이 없으므로 KST 기준 09:00 전·주말·확인된 휴장일에는
장중 일봉을 만들지 않는다. 달력 커버리지 밖도 날짜를 추정하지 않고 별도 경고와 함께
확정 데이터를 사용한다. 시세를 받지 못한 종목은 SQL 일봉뿐 아니라 D/W/M 봉 조건도
같은 전일 확정 기준으로 평가한다. 분봉 조건은 이 대체와 독립적으로 실제 시각을 유지한다.
백그라운드 달력 갱신은 장 시작에 재확인하고, 장중 오늘이 미확인이면 1분 간격으로
확인될 때까지 갱신한다. 확인 후 기본 6시간 간격으로 돌아가며 조회 경로에 벤더 호출을 추가하지 않는다.
_Avoid_: 자정 이후 전날 OHLCV를 새 날짜 봉으로 추가; 시세 일부 누락을 주·월봉 조건 미충족으로 처리.

**스크리너 자동 조회 기준**:
화면의 기준 선택은 제거하며 페이지·드로어·감시·제외 후 재조회는 `basis="auto"`를 쓴다.
서버가 장전·휴장·달력 미확인에는 확정 데이터, 장중(KRX 재개장 포함)에는 시세를 고른다.
장 종료 후 당일 확정 코퍼스가 준비되면 확정 데이터를 쓰고, 준비 전에는 마지막 당일 시세를 유지한다.
API의 기존 `eod` 기본값과 명시적 `intraday`는 호환을 위해 유지한다.
`basis_at_ms`는 실제 평가 기준 시각이며 확정 일봉은 해당 거래일 15:30, 장중 시세는
실제 취득 시각(TTL 재사용 시 최초 취득 시각), 분봉/총잔량은 평가 시각이다.
일부 종목에 확정 데이터를 쓰면 `fallback_basis_at_ms`도 전달하고 화면은 두 시각을 범위로 표시한다.
기준은 조회 유니버스에서 구하므로 빈 결과에서도 제공하며, 일봉 아카이브 최신일·조회 완료
시각(`scanned_at_ms`)·과거 조건 발생일과 구별한다. 오래된 저장 결과는 기록된 날짜만
표시하고 시각을 만들어 넣지 않는다. 결과 저장·발생 제외 후 재조회도 같은 기준을 보존한다.

**주기별 거래대금·기간내 거래대금·등락률**:
`trade_value`·`trade_value_period`·`change_pct`에도 조건별 주기와 진행 중 봉 포함을
저장한다. 기존 생략값 D/true 및 전일 종가 대비 등락률은 기존 SQL·제외 키를 유지한다.
거래대금은 OHLCV 기반 **추정치**다. 분봉은 원본 OHLC 평균가 × 원본 거래량,
일봉은 기존 일별 추정치, 주·월봉은 **일별 추정치 합계**이며 집계 OHLC로 재추정하지 않는다.
최신 거래대금은 최신 선택 봉, 기간내 거래대금은 최근 N봉 중 개별 봉의 기준금액 도달을
본다. N봉 전체 합계나 신고거래대금 조건이 아니다. 날짜 방식은 봉 시작 날짜로 고르고
종료일 이후 데이터는 차단한다. 주기 없는 기존 일봉 날짜 방식의 보충 수집은 유지한다.
등락률의 `change_reference`는 `previous_day`(기본, 전일 종가), `previous_bar`(직전
선택 봉 종가), `bar_open`(현재 봉 시가)이다. 모두 최신 선택 봉 종가와 비교한다.
주·월봉의 전일 기준은 그 봉 마지막 거래일의 직전 거래일 종가다. 분봉 전일 기준은
직전 실제 거래일의 원주가 종가를 분봉과 같은 최신 기준일의 수정계수로 보정한다.
누락 시 더 오래된 종가로 대체하지 않는다. 기준가 0·누락·계수 미확인은 비교 불가다.
`bar_trade_value_match`는 금액과 추정 방법, `bar_change_match`는 등락률·비교 기준·
종가·기준가·기준 시각을 보존한다. 두 근거 모두 주기·진행 상태·조회 시각을 포함하며
봉별 제외를 지원한다. 진행 중 등락률은 충족·해제될 수 있다.
_Avoid_: 원본 분봉 거래량에 보정 가격을 곱해 거래대금 계산; 주·월 합계와 기간내 개별 봉
도달 혼동; 분봉 등락률을 전일 대비와 구분하지 않고 표시; 주·월 등락률을 ±30%로 제한.

**날짜 범위 신고거래량**:
발생 시작일·종료일 사이에 한 번 이상, 해당 거래일 기준 비교 창의 최대 보정 거래량을 달성한 종목을 찾는 조건이다. 비교 창은 당일 포함 거래일 수 또는 달력 연수이며, 연수 창은 과거 경계일을 제외하고 당일을 포함한다(2월 29일의 과거 경계는 해당 연도 2월 말일).
_Avoid_: 달력 2년과 500거래일을 동의어로 사용; 다른 조건도 동일한 과거 발생일에 평가된다고 해석.

**과거 일봉 보충 수집**:
날짜 범위 조건을 평가하는 데 부족한 일봉을 확보해 이후 검색에서도 재사용하는 작업이다. 비교 이력 부족·공급자 미제공은 조건 미충족과 구분하며, 충분한 비교 창에서 확인된 충족 기록만 결과로 인정한다.
_Avoid_: 최초 관측일을 실제 상장일로 단정; 일봉 결손을 거래량 0으로 치환.

**Breakout (돌파)**:
Screener 의 신고 사건 — 어떤 날의 값이 직전 **Record Period** 최대를 **달성(`>=`, 동점 포함)** 한 것. 신고가(high)·신고거래량(volume)이 공유. `wc = period` 가드로 상장 M일 미만 Code 는 제외(짧은 윈도우 가짜 신고 차단). 두 변형 — **당일**(`new_high_today`/`new_high_vol_today`, Lookback Window **N=1** 고정 → 최신일이 곧 신고, param 은 `period` 1개)과 **기간내**(`new_high`/`new_high_vol`, N 사용자 설정, param 2개). 당일은 기간내 컴파일러를 N=1 로 재사용한다(SQL 무복제).
_Avoid_: 일반 개념을 "신고가" 단독으로 (거래량도 포함 — **Breakout**); strict `>` 해석(동점 포함 `>=`); **거래대금**(가격×거래량)을 Breakout 으로 (그건 임계값 가족 — **거래대금** 참조).

**Condition (조건)** / **빌트인 조건 카탈로그**:
Screener 가 제공하는 **빌트인 조건 타입**의 파라미터화된 인스턴스. 카탈로그 9종 — `trade_value`(거래대금), `trade_value_period`(기간내 거래대금), `new_high_today`(신고가/당일), `new_high`(기간내 신고가), `new_high_vol_today`(신고거래량/당일), `new_high_vol`(기간내 신고거래량), `change_pct`(등락률), `price_range`(현재가 범위), `ma`(이동평균). 사용자는 같은 타입을 **중복 추가**할 수 있고(기간내 신고가 200·500 AND 20·60), A·B·C 문자와 **AND/OR·괄호 조합식**으로 결합한다(미지정은 전체 AND). 평가 기준은 **수정주가**·**거래일**. `basis=eod` 에서는 수정주가 store 의 최신 거래일 행이 기준이고, `basis=intraday` 에서는 당일 KIS OHLCV overlay row 가 있으면 그 row 가 최신 거래일처럼 참여한다. 대부분 조건은 **최신 거래일 행**에 대해 평가하지만, **돌파 가족**(신고가/신고거래량)은 **Lookback Window** 내 **Breakout** 이력으로, **`trade_value_period`** 는 최근 N거래일 또는 시작일·종료일을 지정한 날짜 범위 내 임계값 도달 이력으로 평가한다. 최근 거래일 방식에서는 "당일"=N=1 과 "기간내"=N≥1 두 변형을 갖는다. 백엔드는 조건별 **Code**·실제 발생일을 보존하고 제외된 발생 건을 제거한 `cond_i` CTE의 종목 존재 여부를 조합식으로 결합한다(기존 미지정 AND는 SEMI JOIN 유지). 조합식이 참인 종목만 결과 상한에 포함하며, `occurrences`에는 남은 전체 발생일을 반환한다. **전역 사전필터**(시장·ETF제외·거래정지제외)는 조건이 아니라 코퍼스를 제한하는 별도 축이며, intraday overlay KIS fetch 전에 먼저 적용된다.
_Avoid_: 시장/ETF/정지 필터를 "조건" 으로 (그건 **전역 사전필터**); "factor"·"지표" 같은 모호어 (— **Condition** + type 키); 라벨 "신고가"/"신고거래량"(=당일, N=1) 과 "기간내 …"(N≥1) 혼동.

**전역 사전필터 (Universe) / 약칭 "사전필터"**:
Condition 과 별개로 **scan 대상 코퍼스 자체를 좁히는 축** — `ScreenerUniverse{markets, exclude_etf, exclude_halted}`. 백엔드는 `stk` 조인의 WHERE 로 적용한다(조건의 `cond_i` CTE SEMI JOIN 과 **다른 경로**). 두 하위 축으로 갈린다 — **시장 선택**(어느 market 소속인가)과 **종목 제외**(`is_*` 불리언 플래그 집합 — ETF·거래정지·향후 경고종목 등, 확장 가능). 각 **SavedScreener** 가 자기 universe 를 함께 영속한다(조건검색마다 다른 사전필터). 약칭 "사전필터"는 동의어 — 별도 우산 개념 아님.
_Avoid_: **시장(market)** 과 **지수(index)** 혼동 — `KOSPI`/`KOSDAQ` 는 시장(`stk.market`)이지만 `KOSPI200`/`KRX300` 은 지수다(코퍼스에 구성종목 데이터 **없음** → 지수 필터·신규 `is_*` 제외 플래그는 모두 **backlog**, 별도 시드 필요).

**등락률 / 현재가 범위 / 이동평균 (신규 조건 타입)**:
- **등락률(`change_pct`)** — **최신일** 전일대비 `(close/prev_close-1)*100` 에 `gte`/`lte`/`between` 적용. (기간 내 등락률 아님 — 최신일 1일.)
- **현재가 범위(`price_range`)** — 최신일 `close` 가 [min,max] 원 안. 최신일은 수정주가 보정계수=1 이라 **실제가와 일치**.
- **이동평균(`ma`)** — 최신일 `close` vs `SMA(close, period거래일)`. `above`=`close≥SMA`(동점 포함), `below`=`close≤SMA`. `wc=period` 풀윈도우 가드(상장 N일 미만 제외). v1 은 위/아래만(상향돌파·이격% 임계값은 backlog).

**볼린저밴드 돌파 (Bollinger Breakout)**:
스크리너의 `bollinger_breakout_today`는 최신 선택 봉, `bollinger_breakout`는 최신 봉을 포함한 최근 `lookback`봉 중 한 번 이상의 바깥 방향 교차를 찾는다. 일봉의 최근 N봉은 N거래일이다. 비교가격(`source`)과 밴드 계산가격(`band_source`, 기본 종가)은 독립적으로 시·고·저·종가를 선택한다. 밴드는 당해 봉을 포함한 `period`봉 SMA ± `multiplier` × 모집단 표준편차이며 기본 20봉·2배다. 상단은 직전 선택가격 ≤ 직전 상단이고 현재 선택가격 > 현재 상단, 하단은 직전 선택가격 ≥ 직전 하단이고 현재 선택가격 < 현재 하단일 때 충족한다. 같은 값 접촉·이미 바깥에 머무른 봉은 새 돌파가 아니다. 각 발생 봉의 당시 밴드를 계산하며 직전 밴드까지 풀윈도우가 필요하다. 데이터 부족·결측은 커버리지로 알린다. 기존 가격 봉 경로의 수정주가·주기·장중 일봉 대체·발생 제외 규칙을 공유하고 `bar_price_match.reference`에 돌파 시점의 밴드값을 보존한다.
_Avoid_: 최근 N일을 달력일로 해석; 현재 밴드값으로 과거 발생을 재판정; 밴드 밖 상태를 매 봉 새 돌파로 처리; 밴드 계산가격과 돌파 비교가격 혼동.

**볼린저밴드 위·아래 (Bollinger Position)**:
`bollinger_position_today`는 최신 선택 봉, `bollinger_position`는 최신 봉을 포함한 최근 `lookback`봉 중 한 번 이상 선택가격이 상단 밴드 초과 또는 하단 밴드 미만인지 찾는다. 직전 봉 위치와 무관하므로 바깥에 연속으로 머문 봉도 각각 충족하고, 같은 값 접촉은 제외한다. 비교가격·밴드 계산가격·주기·진행 중 봉 정책·기본 20봉/2배와 발생 기록·제외는 볼린저밴드 돌파와 공유한다. 각 봉 자체의 밴드 계산 창만 필요하며 직전 밴드 창은 요구하지 않는다.
_Avoid_: 바깥 위치 조건에 직전 봉 교차 요구; 현재 밴드로 과거 봉 재판정; 최근 N봉을 달력일로 해석.

**거래대금 (trade value) / 기간내 거래대금**:
하루 **거래대금 = `(open+high+low+close)/4 × volume`** (평균가 × 거래량). 코퍼스에 거래대금 컬럼이 없어(OHLCV 뿐) 매 거래일 산출한다 — 종가×거래량 아님(평균가가 일중 체결가에 더 근접). 두 조건이 임계값 가족을 이룸 — **`trade_value`**(거래대금): 최신일 거래대금 ≥ `min_eok`억. **`trade_value_period`**(기간내 거래대금): 최근 **Lookback Window N**거래일 중 **하루라도** 거래대금 ≥ `min_eok`억(돌파/신고 아님 — 단순 임계값 도달). 임계값이라 **`wc` 풀윈도우 가드 없음** — 상장 N일 미만 종목도 보유 거래일 중 도달하면 매치(가짜 신고 위험이 없으므로). 최근 거래일 방식은 `{lookback, min_eok}`를 사용한다. **날짜 범위 방식**은 시작일·종료일을 모두 포함해 하루라도 일별 추정 거래대금 기준을 충족하면 매치하며, 지정 기간 이전의 비교 이력은 필요하지 않다. 누락 일봉은 부분 이력으로 표시하고, 가장 최근에 확인된 충족일과 추정 거래대금을 충족 기록으로 삼는다(기간 합계나 최대거래대금 신고가 아님).
_Avoid_: 거래대금을 종가×거래량으로 (— 평균가×거래량); 기간내 거래대금을 "거래대금 신고/돌파" 로 (Breakout 아님 — 임계값 도달 이력).

**스크리너 계산 정책**:
정책 부재는 `legacy_v1`이며 기존 원주가·수정주가·factor·저장 조건·발생 제외의 의미를 유지한다.
명시적으로 생성하거나 복사한 `separate_bases_v2`는 기준일을 고정한 공급자 수정 가격,
독립 검증한 주식 수 단위 보정 거래량(`share_adjusted`, 신규 D/W/M 기본), 실제 거래량(`raw`, 선택)을 구분한다.
분봉은 raw이며 현금 이벤트는 수량을 바꾸지 않는다. 수량 이력 미확인은 1배나 raw로 추정하지 않는다.
거래대금은 공급자 실제치 또는 원주가 OHLC 평균 × 원본 거래량이며 W/M은 일별 합계다.
기존 금액·거래량 설명은 legacy에 적용된다. 새 결과에는 정책·스냅샷·수량/금액 근거를 보존한다.
`series_v2`의 불변 객체와 baseline을 사용하며 새 조건·제외는 별도 v2 파일에 쓴다.
기존 id의 정책 전환은 거절하고 새 사본을 만든다. 일반 화면 캐시와 영구 실행 보존은 다르다.
확정 D/W/M 실행만 입력·대상 종목·제외·달력·코드 버전을 고정해 정확 재실행할 수 있다.
수량 자료는 출처·검증 구간을 명시해 import하며 전 종목의 자동 검증 소스로 간주하지 않는다.

**스크리너 명시적 복구**: 고정 종목 목록·필요 구간·수정 기준일·비교 요청으로 복구 계획을
보존하고 `/api/screener/recovery/{plan_id}/run`으로 서버 소유 작업을 시작한다. 기존 REST
클라이언트·페이지별 background 거버너를 공유하며 원주가·수정주가·계수·저장 조건·제외는
덮어쓰지 않는다. 응답을 먼저 불변 객체로 보관해 재개 시 재사용하고, 취소·기준일 변경·
기존 입력 변경에는 중단한다. 원본 충돌은 해당 비교 구간에서 격리하며 수량 이력 미확인은
관측 수집 완료와 별개다. 기존 갱신 보고의 실패 건수를 자동으로 지우지 않는다.
명령·실측·비교 범위는 [10종목 시범 복구](docs/diagnostics/2026-10-24-screener-recovery-pilot/README.md) 참조.
확정 복구 확장: KRX 공급자 전체 일봉과 15:30 정규장 종가를 구별하며, 과거일 22시 이후
간격을 둔 두 독립 관측이 일치해야 새 확인 관측으로 사용한다. 현재 v2 계약을 구형 writer가
확인 자료 없이 낮출 수 없다. 원문 근거가 있는 역산 오류·전체 분봉 누적 일치만 특정 v2
버전의 정정 선택으로 공개하고 baseline·관측·근거를 묶는다. 원본과 이전 판정은 보존한다.
정정 전/후 raw와 수량 보정을 별도로 비교한다. [세션·확정·정정 구현](docs/plans/2026-10-24-screener-confirmed-recovery.md).
검토 전용 `review-plan`은 기존 관측·이전 판정을 재공개 없이 현재 코드로 인계받고 근거 입력과
시작 snapshot을 고정한다. 전체 정정 묶음을 한 manifest CAS로 공개하며 수집 시작은 거부한다.
공개 후 작업 상태 저장 중단에는 동일 묶음을 검증해 재공개 없이 상태만 복구한다.
사건 전 수정 OHLCV가 원본으로 들어간 경우에는 독립 결정 공시·실제 거래 단위 적용일,
legacy 계수 1, 전체 수정 OHLCV 일치와 정확한 비율식을 별도로 검증한다. 수량 인증과는
구분하며 [535개 운영 반영](docs/diagnostics/2026-10-24-screener-review-535/README.md)에 전후 비교를 보존한다.
[ADR-0057 개정](docs/adr/0057-screener-kis-authoritative-factor-store.md),
[구현·검증 범위](docs/plans/2026-10-24-screener-bases-implementation.md).

**저장된 조건검색 (SavedScreener)**:
이름 붙은 `{conditions, universe}` 의 영속 사본 — 사용자가 빌더에서 만든 조건검색을 저장/목록/이름변경/삭제(CRUD)한다. 목록에서 선택하면 빌더에 **로드만** 되고(자동 조회 X), `조회` 로 실행한다(스테이트리스 — `/scan` 에 현재 빌더 상태 POST; `/saves/{id}/run` 없음). 영속은 **Watchlist 패턴**(파일=SSOT, `<data_dir>/screener/saves.json`, `atomic_write_json` + `asyncio.Lock` + `schema_version` + 손상 격리). `SavedScreener.id` 는 서버 uuid4(이름변경과 무관)이고, 각 조건 leaf 의 `id` 는 프론트 React key/저장 라운드트립용 클라이언트 nanoid 로 **별개**다.
_Avoid_: "프리셋"·"필터 저장" 단독 (— **저장된 조건검색/SavedScreener**); `SavedScreener.id` 와 조건 leaf `id` 혼동.

호가주문 설정 재사용(2026-10-28): 마지막으로 변경한 유효한 주문 설정을 브라우저의
`hoga.order.settings.last.v1`에 별도로 보관한다. 새 호가주문창은 이 설정을 복사하며,
기존 창은 독립적이다. 모든 주문창을 닫거나 브라우저를 다시 열어도 재사용하고,
오래된 창을 나중에 닫는 동작은 마지막 변경값을 덮어쓰지 않는다. 이전 버전의 창은
별도 저장값이 없을 때 추가/닫기 시 한 번 이어받는다. 계좌·현재 입력 수량·손익 표시
모드·주문 실행 상태는 포함하지 않는다. 설정 백업의 주문 설정 제외 정책은 유지한다.

차트·체결·뉴스 설정 재사용(2026-10-28): 종류별 마지막 설정을 localStorage의
`hoga.{chart,trade,news}.settings.last.v1`에 보관한다. 체결은 마지막 유효 최소 금액
(0 포함), 뉴스는 연결 필터를 새 창에 복사한다. 차트는 열린 차트 복사를 우선하고,
없으면 마지막 편집 창의 봉·표시·주식/지수 지표 및 modal 버킷을 함께 복원한다.
사용자 편집·초기화·되돌리기만 기억을 갱신하며 닫는 순서나 프리셋 불러오기로
최신값을 덮어쓰지 않는다. 프리셋의 명시적 값이 우선이고 런타임 조회 상태는 제외한다.
모든 창을 닫은 명시적 빈 배치는 새로고침에도 유지한다. 손상된 창 목록의 기본 배치
폴백과 사용자가 선택한 기본 배치 초기화는 기존대로다. ADR-0152 개정 참조.

**전체 호가 (Full Price Ladder)**:
호가주문창의 선택적 가격 탐색 모드. 기존 수량 입력 줄에서 켜면 확인된 당일 상·하한가
사이의 주식/ETF/ETN 유효 호가단위가 연속으로 이어진다. 가격열 드래그·사다리 휠·
키보드로 탐색하며 수신 시세는 탐색 가격을 이동시키지 않는다. `현재가`는 모드를 유지한 채
현재 가격을 중앙으로 옮긴다. 10호가 밖과 잔량 없는 가격도 지정가 주문·정정 대상이지만
기존 계좌·수량·호가 신선도·고액 확인은 유지한다. 빈 잔량은 표시하지 않으며 관측되지 않은
잔량을 0으로 추정하지 않는다. 종목·시장·세션·거래일 전환에 기본 10호가로 돌아간다.
_Avoid_: 전체 가격의 잔량을 수신한다는 표현; Floating을 창 분리 기능으로 해석하기.

**열람 호가 상태 (Viewed Orderbook Availability)**:
2026-10-30: KRX 사다리는 다음 평일 08:30에 초기화한다. NXT 미지원 종목은 선택값이
통합이어도 유효 KRX 기준이며, 당일 0E 잔량이 먼저 오면 전일 사다리를 즉시 내린다.
0E는 사다리 없이 표시하고 0D는 수신 즉시 현재 사다리로 전환한다. KRX 평일
08:30–20:00에는 날짜 없는 REST/저장 사다리로 다시 채우지 않는다. 장 종료 후·주말에는
기존 마지막 호가 열람을 유지하며 호가주문의 상시 출처·시각·시장·거래일 미제공 줄을
제거한다. 조회·저장 실패 및 열람 전용 주문 차단은 유지한다. ADR-0167 개정 참조.

10호가·호가주문 마지막 호가 열람(2026-10-24): 표시 가능한 기존 사다리가 없으면
`/api/live/last-orderbook`의 키움 `ka10004`를 종목·유효시장별 공유 조회한다.
유효한 REST 사다리만 디스크에 보존하며 빈 응답·실패 시 마지막 정상값을 복원한다.
응답에는 거래일이 없으므로 10호가창에는 호가 시각·출처·시장과 거래일 미제공을 표시한다.
조회 시각을 호가 발생 epoch로 만들지 않고 신규 주문은 열람 전용으로 차단한다.
기존 실시간 사다리가 도착하면 우선한다. 호가가 없어도 상세정보는 본문에 유지한다.

10호가·호가주문의 종목/유효시장별 표시 상태. 열람 요청 접수, 증권사 등록 ACK,
실제 호가 수신은 서로 다른 사실이다. `/api/live/status`의
`kiwoom.view_subscriptions`는 활성 열람 참조의 연결 대기·슬롯 대기·등록 중·등록 완료를
현재 수집기 세대에서 관측하며 `observed_at_ms`를 함께 보낸다. 재시작/동기화/낡은
수집기 상태에서는 이전 등록·수신 증거를 무효화한다. FE는 공유 상태 조회와 현재
호가 스냅샷을 합쳐 안내하고, 앱 표시 참조 한도 거절은 현재 브라우저 구독 수명에
따라 별도로 관리한다. 체결 수신은 호가 수신의 증거가 아니다. 표시 상태는 신규
주문의 기존 30초 신선도 검사나 저장 여부를 바꾸지 않는다.

호가 표시·복구(2026-10-23): `sharedLiveSeries`가 WS와 REST의 현재 호가 후보를
종목·날짜·venue별로 선택한다. REST는 더 새로운 호가 시각만 채택하며 같은 초는
순번·재연결 검사를 통과한 WS 값을 우선한다. 표시용 최신값과 지표용 순서 이력은
합치지 않는다. 오래된 이벤트 시각만으로 수신 장애를 확정하지 않고 서버의 호가 수신,
브라우저의 실제 WS 호가 수신, 선택한 호가 시각을 구분한다. 브라우저 재연결은 이전
수신 증거를 지운다. 서버가 최근 수신 중인데 화면 호가가 오래된 경우에만 동일
종목·날짜·venue의 창들이 복구 예산을 공유해 30초 간격으로 최대 3회 재조회한다.
진행 중인 조회는 취소하지 않고 합류하며 실제 최신 호가로 회복하면 시도 예산을
초기화한다. 자동 확인 이후에도 수동 재조회를 제공한다. 서비스 상태에는 선택 시점의
종목·venue·수신 시각을 전달하되 전역 장애 건수와 혼합하지 않는다.
이미 표시한 호가가 오래됐거나 이벤트 시각만 갱신되지 않았더라도 확인된 오류가
없으면 안내 상자·연결/재조회 버튼을 숨기고 마지막 호가 시각만 보조 글씨로 남긴다.
상태 관측의 부재·만료도 오류로 단정하지 않는다. 실제 상태/호가 조회 실패·API/WS 오류·
연결 복구·화면 전달 지연은 기존 안내를 유지한다. 내부 진단·복구 예산·오래된 호가의
표시 구분과 주문 신선도 검사는 유지하며, 조용한 표시는 거래 가능이나 수신 정상의 확정이 아니다.

장후 거래 제외 안내(2026-10-22): KRX 애프터마켓(16~20시)에는 확인된 제외 사유를
지연 경고보다 우선해 중립 안내한다. ETF·ETN은 상품 분류, 투자경고·위험·관리·단기과열
등은 `/api/live/aftermarket-exclusion`의 최신 키움 `ka10100` 종목 상태를 사용한다.
동적 지정은 종목·날짜별 60초 메모리 캐시로 공유하며 실패·낡은 결과·다른 종목의
사유를 현재 사실로 사용하지 않는다. 일반 투자주의·예고·해제, 현재 호가 무수신이나
NXT 미상장은 제외 증거가 아니다. 정규장·과거 커서·실효 NXT/통합 시장에는 이 안내를
적용하지 않으며, 사유가 비어 있어도 거래 가능 판정은 아니다. 세부 근거와 관측 한계는
[장후 제외 조사](docs/research/2026-10-22-aftermarket-exclusions.md)를 따른다.

## Relationships

- A **Stock-Date** has exactly one **Data Window** and exactly one **Full Capture**.
- A **Stock-Date**'s **Regular Session** sits inside its **Data Window**.
- A **Full Capture** is built from N **Pages**; consecutive Pages may overlap.
- The collector captures the entire **Data Window**; UI and analysis default to the **Regular Session** but can extend to the **Data Window**.
- Each Parquet table has one **Entity** type (for the parser write path) and one **Wire Model** type (for the API read path). Both live in the same `hoga/tables/*.py` module.
- A **Stock-Date Range** contains N consecutive **Stock-Date**s (N ≥ 1). The **RangeBundle** is its sole read-path Wire Model; the prior single-day `SessionBundle` was retired in ADR-0013 in favor of unifying the read path on RangeBundle. Each in-range **Stock-Date** appears as one element of `RangeBundle.segments` carrying that day's **Regular Session** bounds; series data is concatenated across segments on a stitched virtual axis.
- The **Live Set** is the order-prefix (top ≤ `_PER_ACCOUNT_MAX`×n_configured, W=19/계좌) of the **Capture Candidates**, partitioned across N WS connections (dynamic-N) — reordering across a W-boundary(계좌 간) 또는 (W×N)-boundary(WS↔REST)는 Live Set을 재정의하고 KIS WS 구독을 스왑한다. *(이력: 2026-06-05 1계좌 13 → 06-10 W=10/계좌(30 ceiling)+3계좌 → 07-10 W=13(등록 상한 41 실측, ADR-0101) → 07-15 거래원 TR 제외 W=19(ADR-0111) — `refresh_live_stream`/`partition_live_set`)*
- Many **Live Tick**s fold into one 10-second **Live Snapshot** (the downsampler); only Live Snapshots reach disk. A **Live Tick** lives only in the LiveBuffer ring + browser buffer.
- A **Drawing** belongs to one **Code** — the `useDrawingsStore` is keyed by `byCode.get(code)`. Switching the `/live` page's active **Code** swaps the **Drawing Overlay**'s render list and resets `selectedId`.
- The **Drawing Property Panel** is visible iff `activeTool === 'select'` and a **Drawing** is selected. Editing color / width / line style through the panel writes simultaneously to that Drawing (per-Code persistence) and to **Drawing Defaults** (global per-user persistence), so the next new Drawing inherits the style. **Drawing Defaults** is the only piece of Drawing-related state that does not live under a `byCode` slice.

## Flagged ambiguities

- "session" was used ambiguously to mean both **Regular Session** (info.tsv's `session_open`/`session_close` fields) and **Data Window** (collector loop range, scrubber range) — resolved 2026-05-19: these are distinct, use the precise term.
- "cursor" was used in early Capture UI mockups to label the collector's progress marker; this clashes with the API/UI **Cursor** — resolved 2026-05-21: in-flight progress is **Capture Frontier**, **Cursor** is reserved for read-path API/UI use.
- "symbol" was used as a bare noun in early `symbols.py` code and the 2026-05-22 KRX env spec — clashes with the **Code** glossary entry that _Avoid_'s "symbol" — resolved 2026-05-22: bare "symbol" remains _Avoid_'d (use **Code** for the 6-digit ticker), but the compound **Symbol Master** is sanctioned as the catalog/lookup-layer term, mirroring the **SessionBundle** precedent. Class names `SymbolHit`, `SymbolsAllResponse`, `SymbolSearch`, `useSymbols` are sanctioned compounds — not renamed.
- "raw" was about to be reused by the 2026-05-31 Screener spec to name its unadjusted (split-unadjusted) daily-price store — clashes with the established `raw/{date}/{code}` directory (unparsed hogaplay capture Pages, the pre-parser **Full Capture** artifact) — resolved 2026-05-31: the Screener store is **원주가/unadjusted** (`daily_unadjusted.parquet`); bare "raw" stays reserved for the capture-Page meaning. See **Screener**.
- "meta.json" basename: the Screener spec initially wrote its observability state to `screener/meta.json`, colliding by basename with the schema-fixed per-Stock-Date capture `meta.json` (read by `DiskState.classify_from_meta`, the **Invariant** catalog, `full_capture_count`) — resolved 2026-05-31: Screener state file is `screener/status.json` (typed `ScreenerStatusFile`); `meta.json` stays reserved for Stock-Date capture metadata.
- "streaming capture" was _Avoid_'d on **Live Capture** with the rationale "this codebase intentionally uses REST polling" (ADR-0038 era) — the 2026-06-05 live-kis-websocket spec **reverses the transport decision** (sub-second는 REST로 물리적 불가, 15콜/초 한도). Resolved 2026-06-05 (그릴링): **Live Capture** 정의를 WS 기준으로 개정(이행 표기 포함), per-tick 수신 단위는 신설 용어 **Live Tick**, 10초 저장 단위는 **Live Snapshot**(의미 축소), WS 구독 13종목 집합은 **Live Set**. "tick"의 _Avoid_는 유지하되 의미가 이동 — 이제 bare "tick"은 **Price Tick**과의 충돌 때문에 피하고, WS 수신 단위는 Live Tick으로 부른다.
- "등락률" was about to be reused by the 2026-06-12 high/low-extreme-labels spec for its `(현재가 − 가시 극값)/극값` metric — clashes with the **Live Quote** 등락률 (vs 전일종가) and the **봉대비** convention (vs 직전봉). Resolved 2026-06-12 (그릴링): the new metric is **극값 대비율 (Extreme Gap)**, measured vs a *viewport-relative* high/low; bare "등락률" stays reserved for the 전일종가 metric. Three references now coexist by distinct names: 등락률(전일) / 봉대비(직전봉) / 극값 대비율(가시 극값). See **High/Low Extreme Labels**.
- "peak / 고점" was about to be reused by the 2026-06-13 hoga-peak-basis spec for "the bar's intra-minute maximum" — clashes with **총잔량 급증**'s intraday *running peak* and **당일 매도 최대벽** (Day Ask **Peak**)'s day high-water mark. Resolved 2026-06-13 (그릴링): the new basis is **분봉 내 최댓값 기준 (Intra-Bar Max)**; bare "peak/고점" stays reserved for the surge running-peak and the Day Ask Peak. The same grilling decided **Day Ask Peak's Intra-Bar Max mode deliberately reverses** its documented "sub-bucket transient correctly skipped" rationale (opt-in, default close) — recorded in ADR-0076. See **분봉 내 최댓값 기준 (Intra-Bar Max)**.
- "체결가격 기준 최대벽" previously meant "the wall price appears anywhere in the Stock-Date trade-price set", but this failed same-price repeated-wall scenarios. Resolved 2026-07-05 (그릴링) into **사후터치 / 사후미터치 최대벽** — "touched by any *later* tick" (ADR-0084). That rule marked a wall as filled when price merely revisited its level hours later, which is not what the overlay claims. Re-resolved 2026-08-21: the canonical term is **동일분 터치 최대벽** (touch must land in the wall's own 1-minute window), the untouched family is **deleted**, and legacy wire names keep `traded_*`. See ADR-0156.

스크리너 일반 자동 갱신(2026-10-24): 22시 정기 원주가 요청에 최근 5거래일 재검사를
합친다. 당일 값은 잠정 원장에 보존하고, 다음 날짜의 독립 관측과 일치한 없는 날짜만
추가한다. 기존 행·마감 후 관측의 불일치는 원본을 덮어쓰지 않고 조건·날짜별로 격리한다.
가격만 쓰는 조건에 거래량만의 충돌을 전파하지 않으며 v2 수정 OHLC·수량 이력의 독립
계약을 유지한다. 기존 파일·SavedScreener·승인 정정 선택을 자동 이관하지 않는다.
[자동 갱신의 확인·부하 예산](docs/plans/2026-10-24-screener-automatic-daily-ingest.md)을 따른다.
최종 공시로 확인한 종료 종목은 별도 원문 해시·검토 이력으로 관리하고 정기 요청에서 제외한다.
종료 전 미확인 이력은 보존하며, 빈 응답만으로 종료 판정을 하지 않는다. 종료 종목의 미확인 수와
실제 재시도 가능한 미확인 수를 구분해 종료 이력 때문에 전체 재시도가 반복되지 않도록 한다.
일반 ‘갱신’ 버튼은 정기 자동 갱신과 같은 최근 일봉 검증 경로를 사용한다. 종목 목록 갱신·
깊은 누락 보충은 ‘과거 데이터 복구’로 분리한다. 두 경로의 계획과 시작은 한 서버 작업으로
직렬화하며 일반 갱신 클릭이 과거 복구를 암묵적으로 요청하지 않는다. 낮 한 번의 시도 후에는
밤 22시 확인의 예산을 남기고, 잠정·독립 확인·충돌 격리와 기존 저장 조건은 유지한다.
2026-10-30: 서버 시작 직후와 KST 날짜가 바뀐 첫 스케줄러 틱에도 일반 갱신을 점검한다.
전날 잠정 일봉을 다음 밤까지 미루지 않고 독립 확인하며, 같은 날 재시작에도 원장 예산과
공유 작업을 따른다. 완료된 낮 점검은 매분 반복하지 않고 밤 22시 정기 갱신은 유지한다.

주문·정정 접수음(2026-10-28): 기존 `orderReceiptSound` 설정과 음원을 신규 주문 및
가격·수량 정정에 함께 사용한다. 한 번의 묶음 드래그는 모든 응답 처리 후 접수된 건이
있으면 한 번만 울리고, 접수 확인된 건 없이 모두 실패·결과 불명확이면 울리지 않는다. 일부 실패의
건수·재시도 안내는 유지한다. 첫 접수된 하위 명령 ID로 중복 재생을 막고, 실패한
하위 주문만 재시도해 새로 접수되면 그 재시도에 한 번 알린다. 취소 접수는 대상이 아니다.

데스크톱 설정 진입점(2026-10-28): 앱 전체 설정은 우측 레일의 알림 아래 마지막
톱니바퀴 버튼에서 연다. 기존 중앙 설정 모달과 다른 패널의 열림 상태는 유지한다.
Electron에서만 「데스크톱」 섹션에 현재 서버·서버 선택·새 작업 창·배율 조절을 제공한다.
일반 우클릭의 서버 선택/새 창/배율 메뉴는 제거하고 편집·외부 링크 메뉴는 유지한다.
Ctrl+Alt+S와 로컬 연결 실패 화면은 계속 복구 진입점이다. 원격 UI의 bridge는 제한된
명령만 제공하며 main에서 활성 서버의 등록 창·main frame·허용 URL을 검사한다.

내 체결내역(2026-10-28): `account-fills`는 시장 체결창과 별개인 계좌 창이다. 호가주문의
「내 체결」로 열며 `sourceOrderId`의 선택 계좌를 따라간다. 다른 호가주문의 계좌 변경에는
반응하지 않고, 원래 창을 닫으면 마지막 계좌·종목을 유지한다. 계좌/연결·필터·배치는
탭 워크스페이스에 보관하되 레이아웃 프리셋에는 계좌 식별자·종목을 담지 않는다.
시세 venue·차트 커서와 독립적으로 당일 계좌 전체 거래소의 주문별 체결 누계를 표시한다.
`GET /api/trading/v2/execution-history`가 계좌를 검증한 토스/키움 조회와 계좌·날짜에
묶인 연속조회 키를 제공한다. 첫 페이지에 진행 중 부분체결도 포함하며 체결 후 취소된
주문의 체결분을 보존한다. 수량은 증권사 명시값만 사용하고 취소 확인 행을 더하지 않는다. 정정 주문의 체결은
해당 주문 식별자로 표시하며 부모·자식의 체결수량을 추정 합산하지 않는다. 토스 평균체결가와 키움 체결단가를 구분하며 주문시각·확인시각을 체결시각으로
대체하지 않는다. 최신 페이지만 주기/주문 이벤트로 조회하고 이전 페이지는 요청 시에만
추가한다. 읽던 내역은 자동 이동하지 않고 새 체결·갱신 안내로 최신 위치에 복귀한다.
