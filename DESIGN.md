# Design System — hoga-ops

2026-10-28 사용자 요청 — 호가주문 설정의 「호가·잔량 구분선」을 켜면 가격과
매도·매수 잔량 셀 하단에 같은 `border` 토큰의 1px 선을 이어 표시한다. 일반 호가와
전체 호가에 함께 적용하며 전체 호가의 빈 잔량 셀도 포함한다. 주문 입력 열·체결
정보·종목 상세 통계는 기존대로 두고, 24px 행 높이·잔량 막대·숫자 정렬은 유지한다.

2026-10-28 사용자 미리보기 승인 및 후속 수정 — 호가주문창 상단의 수량·평단가·손익은
별도 배경색 없이 항목 사이에 `border-strong`의 1px 세로 구분선 두 개만 표시한다.
기존 숫자 열·8px 간격·정렬·라벨 없는 표시를 유지하며 묶음 안쪽 여백은
상하 2px·좌우 6px이다. 미보유·미수신 값은 대시와
수량 0을 숨기되 공간·구분선은 유지한다. 보유 중인 실제 손익 0은 표시하며
금액/% 전환·툴팁·보유 클릭의 매도 가능 수량 입력 동작은 유지한다.

2026-10-28 사용자 승인 — 스크리너의 모든 숫자 조건은 편집 중 빈칸·음수 부호·
소수점을 보존한다. 기본값 복원과 범위 자동 보정은 하지 않으며 Enter·포커스 이탈 시
필수값·숫자 형식·정수·허용 범위 오류를 입력칸 아래 기존 error 토큰으로 안내한다.
잘못된 입력이 있으면 조회·자동 재조회·조건 저장을 막고, 수정하거나 조건을 제거하면
해제한다. 최저가·최고가의 한쪽 빈칸은 기존대로 제한 없음이며 양쪽 빈칸이나 뒤집힌
가격·등락률 범위는 안내 후 실행을 막는다. 저장본 복원 시 편집 중인
텍스트와 오류도 초기화하며 기존 글꼴·크기·간격·단위·포커스 표시는 유지한다.

2026-10-26 사용자 후속 승인 — 텍스트 선택 방지 범위를 라이브 작업 창에서 앱 전체로
확장한다. 메뉴·설정·툴팁·목록·시세 등 일반 UI는 드래그로 선택되지 않는다. 전역
`body`의 기본값을 사용해 포털에도 적용하며 입력칸·텍스트 편집 영역·상태/오류 안내와
`select-text` 콘텐츠는 선택·복사를 허용한다. 뉴스 기사·차트/앱 오류 상세·복기 문서는
같은 예외를 쓰며, 클릭·키보드·드래그·편집 동작은 유지한다.

2026-10-26 사용자 요청 — 캔들 차트 설정의 토글·하위 가격선 스타일 설명은 상시 문장
대신 설정 이름의 공통 `AppTooltipHost` 툴팁으로 표시한다. 500ms 호버 지연·키보드
포커스·포털 배치·테마 스타일·해제 동작을 기존 툴팁과 공유한다. 설정 이름은 포커스할
수 있고, 다른 앱 설정·보조지표·주문 설정의 기존 설명 방식은 유지한다.

2026-10-26 사용자 요청 — 저장뷰 리스트의 행·기간 정보·그룹명에 표시하던 마우스
호버 툴팁을 제거한다. 기존 두 줄 표시·접근성 이름·메모 편집·클릭·드래그는 유지한다.

2026-10-26 사용자 요청 — 앱 설정의 `가격 표시 → 고저 극값 라벨`과 그 세부 설정을
각 차트 헤더의 `차트 설정 → 가격 표시`로 옮긴다. 고저 라벨과 고가·저가·이전일 고가·
이전일 저가선의 표시·색상·두께를 해당 차트에만 즉시 적용·저장한다. 세부 설정은
기존 공통 접기·펼치기 UI와 기본 접힘 상태를 유지한다. 종목·봉 변경 후 유지하고,
새 창의 포커스 창 복사·되돌리기·프리셋·설정 백업을 공유한다. 기존 차트 설정에
고저 필드가 없으면 종전 전역값을 한 번 이어받고, 이미 저장된 창별 값은 보존한다.
앱 설정 본문·검색에는 이 항목과 하위 가격선·스타일을 노출하지 않는다.

2026-10-26 사용자 승인 — 차트 설정의 `캔들 · 지표`에 기본 끔인
`거래량을 캔들에 겹쳐 표시`를 추가한다. 켜면 기본 거래량의 별도 pane을 제거하고
캔들 뒤·동일 시간축의 하단에 숨은 독립 축으로 표시한다. 후속 사용자 요청으로
세부 설정은 켜졌을 때만 공통 `세부 설정` 접기·펼치기 UI로 제공하고 기본은 접힌 상태다.
투명도 65%(0~100), 표시 높이 25%(10~40), 상승·하락 색상은 테마 추종이
기본이다. 공통 팔레트와 테마 색상 복귀를 제공한다. 창별 즉시 저장·되돌리기·새 창
복사·프리셋·백업을 공유하고 초봉·분봉·D/W/M에서 같은 창의 설정을 유지한다.
가격축 로그·반전과 독립적으로 거래량은 아래에서 위로 표시하며, 반전 시 색상 교환은
기존 옵션을 따른다. 레전드·툴팁의 수량은 원본이고 거래량 드로잉은 겹치기 동안 숨겨
별도 pane 복귀 시 복원한다. 기존 pane 순서·병합·봉별 높이는 변경하지 않는다.
반복 추가한 거래량은 별도 pane을 유지한다. 사용자 후속 요청으로 거래량의 누적
체결강도 시리즈·설정·구 저장값의 적용은 제거한다. 독립 체결강도 지표는 유지한다.

2026-10-26 사용자 미리보기 승인 — Electron 배율 조절 시 해당 업무 창의 화면 정중앙에
`화면 배율 N%`만 표시하는 투명 팝오버를 잠깐 띄운다. 테마의 `--bg-card`를 35%로
혼합하고 8px 블러·옅은 1px 경계·8px 모서리를 사용한다. 라벨은 `--text-sm`, 배율은
`--text-lg`·500·tabular-nums이며 기존 글자색 토큰을 따른다. 마지막 입력 후 1.8초 뒤
150ms로 사라지고 연속 입력은 같은 팝오버의 값·타이머만 갱신한다. 클릭·휠·포커스를
가로채지 않으며 복원·새 창·동기화된 다른 창에는 표시하지 않는다. 새 줄·조작 버튼은 없다.

2026-10-26 사용자 승인 — Electron 업무 앱의 화면 전체 배율을 Ctrl/Cmd + + 또는 =,
Ctrl/Cmd + -, Ctrl/Cmd + 0으로 조절한다. 우클릭의 `화면 배율 N%` 하위 메뉴와 네이티브
보기 메뉴에도 확대·축소·100% 복귀를 제공하고 기존 메뉴 행 숨김을 유지한다.
50~300%의 단계 배율은 연결 서버별로 저장해 같은 서버의 다른 창·새 창·새로고침·재실행에서
공유·복원한다. 차트 Ctrl+휠과 서버 관리 앱은 변경하지 않는다. 기존 연결 설정·실행 경로와
샌드박스를 유지하며 Electron 메인 코드 반영에는 업무 앱의 완전 종료·재실행이 필요하다.

2026-10-26 사용자 승인 — 호가주문 설정의 `호가 표시`에 `내 평단가 표시` 다음으로
`호가 가격 구분선`(기본 끔)과 `호가 등락률 표시`(기본 켬)를 제공한다. 해당 창에만
즉시 적용·저장하며 기존 저장값은 기본값으로 보완한다. 구분선은 중앙 가격·등락률 열의
각 유효 행 아래에 기존 `--border` 색의 1px 선으로 표시한다. 주문·잔량 칸과 빈 슬롯에는
선을 만들지 않으며 24px 행 높이·현재가 강조는 유지한다. 등락률을 끄면 숫자와 예약 공간을
함께 제거해 중앙 가격열을 줄인다. 두 옵션은 기본 10호가와 전체 호가에 동일하게 적용한다.

2026-10-26 사용자 후속 수정 — 호가주문 수량·프리셋·전체 호가·현재가·금액은 같은
입력 줄에 유지한다. 금액의 불필요한 18ch 예약 폭을 없애고 오른쪽 정렬한다.
실제 내용이 창 폭을 넘을 때만 입력 줄 안에서 가로 스크롤하며 글자·숫자를 생략하거나
금액을 다음 줄로 보내지 않는다. 기존 글자 크기·버튼·사다리 배치는 유지한다.

2026-10-26 사용자 미리보기 승인 — 호가주문 수량 입력 줄의 기존 빠른 입력 버튼 옆에
`전체 호가`와 `현재가`를 배치한다. 별도 조작 줄·상태 배너·범위 슬라이더는 추가하지 않는다.
전체 호가는 확인된 당일 상·하한가 안의 유효 호가단위를 연속으로 표시한다. 가격열 드래그와
사다리 휠, 포커스된 사다리의 방향키·PageUp/Down·Home/End로 탐색하며 `현재가`는
모드를 유지한 채 현재가를 중앙으로 이동한다. 새 시세는 탐색 위치를 바꾸지 않는다.
24px 행과 좌우 대칭 5열·가격/평단가 칩·테마 토큰을 유지하고 화면에 들어가는 행만 그린다.
관측된 매도·매수 잔량을 각각 같은 가격에 표시하며 잔량 없는 칸은 대시·0 없이 비운다.
모든 표시 가격에 기존 신규 주문·정정 대상을 제공하되 계좌·수량·호가 신선도·고액 확인을
유지한다. 전체 호가에서는 상세 통계를 기존 정보 팝오버로 열고, 기본 10호가에서는
기존 중앙 고정·체결·상세 통계 배치를 유지한다. 종목·시장·세션·거래일 전환 시 모드를 해제한다.

2026-10-26 사용자 승인 — 라이브의 모든 작업 창은 제목·라벨·시세·표의 표시값이
마우스 드래그로 선택되지 않게 한다. 공통 `.live-window`에 적용하며 입력칸·텍스트
편집 영역과 상태·오류 안내는 선택을 허용한다. 뉴스 기사와 차트 오류 상세도
`select-text`로 선택·복사를 유지하고, 추가로 복사가 필요한 영역은 같은 예외를 쓴다.
복기 노트 등 문서 화면의 기존 선택·편집은 유지한다. 창 이동·크기 조절·주문
정정·취소 드래그·더블클릭 주문·스크롤 동작은 유지한다.

2026-10-26 사용자 후속 요청 — 종목 뉴스의 기사 행은 제목·출처·시각·종목 연결 정보를
읽는 목록으로 표시한다. 본문을 제공하지 않는 행의 클릭·펼치기와 선택·호버 강조를
제거하고 텍스트 선택·복사는 유지한다. 날짜·필터·새 뉴스 반영과 하단 제공 안내는 유지한다.
같은 날 사용자 승인: `종목 연결만`은 기본 켬으로 시작하며, 해제하면 전체 조회 결과를
표시한다. 필터는 기존과 같이 제공 종목코드 또는 제목의 종목명 기준을 사용한다.

2026-10-25 사용자 요청 — 초봉에도 분봉과 같은 거래일 날짜 구분선을 표시한다.
기존 `DayBoundaryPrimitive`·`--chart-day-boundary`·1px 점선을 재사용하고 모든 패널에
이어 표시한다. 날짜 라벨은 기존 시간축이 담당하며 별도 토글·색 설정은 추가하지 않는다.

같은 날짜 후속 승인 — 초봉은 팬·축소 후 부족 범위를 연속으로 채우며 읽던 시점과
배율을 유지한다. 기존 하단 보조 글씨에서 저장된 과거 데이터 끝·선택 구간 시작·
64페이지 조회 한도·조회 실패를 구분하고 기존 추가 조회/재시도 버튼을 사용한다.

2026-10-25 사용자 승인 — Electron 서버 관리 창의 외부 실행 서버에도 서비스별 `중지…`와
전체 `모두 중지…`를 제공한다. 기존 서버 관리 창의 폰트·색·간격·버튼 스타일을 유지하며,
확인창에 사용자·PID·프로젝트 경로·명령·프로세스 수와 연결 중단 영향을 표시한다.
확인되지 않은 대상은 중지 불가 이유를 표시한다. 정상 종료 시간 초과 후에만 서비스 행에
`강제 종료…`를 제공하고 남은 대상과 작업 유실 가능성을 별도로 확인한다.

2026-10-25 사용자 승인 — 체결창의 분봉·초봉 커서 연동: 기존 표·폰트·테마를 유지하고
선택 날짜·시간 범위·시장과 실제 소스를 보조 글씨로 표시한다. hogaplay는 원본 체결,
WS는 `1초 집계`와 합산량·관측 건수로 구분한다. 집계에서는 개별 체결금액 필터와
대량 체결 강조의 일시 중지 이유를 표시한다. 최근 200행 미리보기와 추가 내역 존재를
알리고 커서 해제 시 최신으로 돌아간다. 초봉에도 같은 커서 연동 버튼을 제공한다.

2026-10-25 사용자 후속 승인 — 체결창 스크롤 탐색: 차트에서 체결창으로 포인터를 옮기면
선택 봉을 유지하고 첫 스크롤부터 `체결 탐색`으로 고정한다. 고정 헤더 아래 첫 온전한
체결 행의 봉을 기준으로 차트·10호가를 이동한다. 같은 봉의 남은 페이지를 먼저 읽고
같은 거래일의 이전 관측 봉을 아래에 이어 붙이며 읽던 위치와 차트 배율을 유지한다.
원천·시각·주기는 기존 보조 글씨, 복귀는 `최신으로` 버튼을 사용한다. 로딩·재시도는
목록 밖에 두어 행 위치를 보존하고 긴 목록은 가상화한다. 실제 차트 호버·연동 OFF·
조회 문맥 변경은 탐색을 종료한다. 날짜를 자동으로 넘기거나 빈 체결을 만들지 않는다.
2026-10-25 사용자 승인 — 초봉도 분봉의 공통 도구 모음·보조지표 편집·그리기·이미지
캡처·복기 노트 추가·레전드·호버 연동·패널 조절을 사용한다. 기존 아이콘·툴팁·좁은 창
줄바꿈·테마 토큰을 공유한다. 지표 편집의 현재 봉 표시는 `초봉`이며, 초봉 원본으로
계산하는 가격·거래량 지표만 목록에 표시한다. 설정과 패널 높이는 분봉과 분리해 저장한다.

2026-10-25 후속 구현 — 분봉 도구 행과 측정 속성 패널에 `초봉으로 확대`를 제공한다.
초봉의 선택 구간·해제·로딩·빈 관측·실패는 기존 상태 칩과 보조 글씨로 표시한다.
`현재 뷰 저장`과 저장뷰 기간 칩·초 단위 기간 표시는 공통 저장 UI를 사용한다.
저장뷰의 KRX 고정을 유지하며 다른 시장의 초봉 저장 버튼에는 비활성 이유를 알린다.
체결강도는 관측 매수·매도량의 기존 막대·방향색을 쓰고 미확인 방향·단일가·미수집
제외를 설정 설명에 명시한다. 초봉에는 당일 누적선·누락 수집 선택을 제공하지 않는다.

초봉 주기를 바꿀 때는 읽던 시각·기간을 유지하고 새 봉 경계에서만 조정한다.
과거 구간에서 최신으로 돌아가는 동작은 기존 날짜 칩의 `최근 시각으로 돌아가기`를
사용하며, 새 도구·색·간격을 추가하지 않는다.

2026-10-25 사용자 수정 요청 — 날짜별 복기 노트의 달력 아이콘을 앱 공통 SVG 선형 아이콘과
툴팁으로 표시한다. 날짜 입력과 아이콘 버튼을 테두리 있는 하나의 필드에 정렬하고 테마의
글자색·표면·포커스 토큰을 사용한다. 달력 버튼은 native 날짜 선택기를 열며 직접 입력도 유지한다.

2026-10-25 사용자 후속 요청 — 복기 캔버스 툴팁도 다른 페이지와 공통으로 사용한다.
편집기 네이티브 title·자체 호버 안내를 기존 useTextTooltip으로 연결하고 색상 버튼은
TooltipButton을 사용한다. 공통 표면·500ms 지연·키보드 포커스·Esc/누르기/스크롤 닫기를
재사용하며 도구명·단축키·색상 의미를 유지한다. 두 툴팁을 겹쳐 표시하지 않는다.

2026-10-24 사용자 수정 요청 — 복기 캔버스 안내: 성공·오류·충돌 안내를 본문 흐름에서
분리한 하단 겹침 패널로 표시해, 알림의 표시·닫기·재시도에서 캔버스 위치·크기를 유지한다.
기존 표면·경계·모서리·그림자 토큰을 쓰고 저장 상태는 상단에 유지한다. 저장 서버가
지원하지 않는 웹 임베드 도구는 노출하지 않고, 이미 생긴 초안은 주소를 링크 메모로 보존한다.


2026-10-24 사용자 후속 승인 — 날짜별 자유 캔버스 복기 노트: 좌측 날짜별 목록·이전/다음
기록·간단히/자세히 및 마지막 선택은 유지하고 본문을 자유 배치 캔버스로 전환한다.
빈 페이지에서 텍스트·이미지·메모·도형·화살표를 배치하고 연필·그린 선 전용 지우개·
선 색상·굵기·실행 취소를 제공한다. 정해진 복기 항목은 선택 템플릿이다. 기존 구조의
글·이미지는 한 번 캔버스로 펼치고 원문도 보존한다. 페이지는 캔버스 프레임이며,
Excalidraw의 기본 도구·속성·그룹·잠금·확대·실행 취소 UI를 함께 유지한다.
이 승인은 아래 날짜별 읽기 문서의 기본 본문·고정 입력 항목 결정을 대체한다.

2026-10-24 사용자 후속 승인 — 날짜별 복기 노트: 상단 「화이트보드」를 「복기 노트 작성」으로
바꾸고, 좌측 날짜별 목록과 중앙 읽기 문서를 배치한다. 목록은 날짜·제목·상태를 기본으로,
아이콘의 간단히/자세히 선택에 따라 종목·하루 결론을 표시하며 마지막 선택을 브라우저에
저장한다. 목록 폭은 `review-list-w`(14rem), 문서 최대 폭은 `review-document-w`(52rem)다.
기록이 있는 날짜를 따라 이전/다음으로 이동하며, 종목 기록은 썸네일·제목에서 개별/전체
펼치기를 제공한다. 읽기 화면에는 입력창 테두리를 표시하지 않는다. 오늘 작성·수정에서
일반 텍스트 입력과 이미지 첨부, 하루 결론·잘한 판단·바꿀 행동·다음 원칙을 기록한다.
완료 표시와 자동 저장 상태를 구분한다. 기존 자유 배치 보드는 별도 진입에서 유지한다.
이 결정은 아래 화이트보드의 기본 진입·목록 표시 결정을 대체하고 캔버스 편집 규칙은 유지한다.

2026-10-24 사용자 승인 — 화이트보드 「보드 목록 함께」: `/whiteboard`를 상단 캡처
오른쪽에 추가한다. 좌측 내 보드 목록, 중앙 보드 이름·저장 상태·이미지·내보내기·
새 보드, 남는 공간을 채우는 점 격자 캔버스를 사용한다. 목록 폭은
`whiteboard-list-w` 토큰(12rem)이며 좁은 폭에서는 접을 수 있다. 기존 우측 레일과
열린 패널, 현재 테마·밀도·폰트를 공유한다. 초기 화면은 빈 보드 안내이며 예시
주식 차트를 사용자 자료로 저장하지 않는다.

편집기는 Excalidraw의 기본 도구 모음·선택 시 속성 패널·실행 취소/다시 실행·
확대/축소를 유지하고 공식 스타일 변수로 테마를 연결한다. 시안의 간소화된 도구
모음과 이 부분은 다르다. 메모 추가는 보드 헤더에서 제공하고, 실제 객체 내용의
색·글자 크기는 문서 편집 값으로 저장한다. 보드 이름·저장 상태는 보드 소유이며
충돌/실패가 있을 때만 복구 안내를 표시한다. 삭제는 휴지통 이동과 복원을 제공한다.

2026-10-24 사용자 요청: 10호가·호가주문창은 실시간 사다리가 없으면 REST 마지막 호가와
유효한 저장본을 표시한다. 기존 보조 글씨로 출처·호가 시각·시장·`거래일 미제공`을
명시하고, 조회 시각을 신선한 호가로 해석하지 않는다. 조회·저장 실패만 짧은 안내와
재조회 동작을 제공한다. 사다리가 끝내 없어도 종목 상세정보를 본문에 유지하며,
넓은 창은 옆에, 좁은 창은 아래에 배치한다. 기존 폰트·테마·호가 행 높이와
주문 신선도 검사를 유지한다.

2026-10-23 사용자 후속 승인: 소프트 컴팩트를 앱 전체 툴팁에 적용한다. 네이티브
호버 안내는 `data-tooltip`과 앱 공통 호스트로 표시하며, 목록 가상화·포털·비활성 버튼도
같은 표시 경로를 사용한다. 제목·본문·단축키·색상의 의미는 유지한다. 기업 설명·캔들
시세·지수·옵션 및 시장 그래프의 전용 안내는 내용·행 구조·너비·위치 동작을 보존하고
`tooltip-surface`의 글자·여백·표면·경계·모서리·그림자만 공유한다. 제거한 제목줄
툴팁은 추가하지 않으며, 기존 국내 종목명 기업 설명 예외만 유지한다.

2026-10-23 사용자 승인: 캔들차트 도구 메뉴와 호가주문 툴팁을 소프트 컴팩트로 통일한다.
공통 텍스트 툴팁은 기존 테마의 불투명 `bg-card`·`fg`·`border-strong`, `radius-lg`(6px),
6×10px 여백, `text-sm`(11.5px), 줄높이 1.6, `shadow`를 사용하며 꼬리·장식·모션은 없다.
메뉴의 네이티브 `title` 툴팁은 같은 컴포넌트로 전환하고 500ms 호버·키보드 포커스,
Esc·누르기·스크롤·창 포커스 이탈 시 닫기와 실측 기반 화면 가장자리 보정을 공유한다.
비활성 메뉴의 이유 안내와 호가의 가격 방향색은 유지한다. 제목줄 툴팁 제거 및
국내 종목명 기업 설명 예외는 아래 기존 규칙을 유지한다.

2026-10-23 사용자 요청: 10호가·호가주문에서 표시 중인 호가가 오래됐더라도 확인된
오류가 없으면 갱신 대기/서버 상태 미확인 안내 상자와 연결·재조회 버튼을 표시하지 않는다.
마지막 호가 시각만 기존 `text-xs`·`text-fg-dim` 보조 글씨로 남긴다. 실제 조회 실패·
API/WS 오류·연결 복구·화면 전달 지연 안내와 주문 신선도 검사는 유지한다.

**Created:** 2026-05-20 via `/design-consultation`
**Project:** hoga-ops — Korean stock orderbook + trade replay analysis tool
**Approved mockup (original, at 1.0× base intent):** `docs/superpowers/designs/2026-05-20-replay-viewer.html`
**Approved commercial themes (2026-07-08):** `docs/superpowers/designs/2026-07-08-commercial-terminal.html` (Obsidian, dark) · `docs/superpowers/designs/2026-07-08-commercial-ledger.html` (Ledger, light)

**Trading Desk (2026-10-19, 사용자 승인):** 메인 페이지의 올리브 블랙·라임 컨셉을
실제 `/live`에 적용한다. `trading-desk` 팔레트를 기본값으로 추가하되 기존 저장된
테마·창 배치·지표 설정은 덮어쓰지 않는다. 기존 여섯 테마와 전역 테마 동기화는 유지한다.
배경 `#0b0f0b`, 창 `#121811`, 제목줄 `#182014`, 라임 `#c7fa79`, 상승/매수
`#f47f89`, 하락/매도 `#82b1fa`를 사용한다. 새 창 프레임 모서리 토큰은 9px이다.
라임은 조작·선택에, 빨강·파랑은 시세에 사용한다. 이동평균은 사용자가 지정한 색과
자동 명도 보정을 유지하며 저장된 지표 색을 미리보기 색으로 교체하지 않는다.

라이브 크롬은 `TradingDesk.css`에서 테마 선택에 따라 적용한다. 중성 경계선과
짧은 그림자, 일관된 제목줄·창 조작 버튼을 사용한다. 사용자 후속 요청(2026-10-19)에
따라 차트 제목줄은 종목명·현재가·등락률·창 조작 버튼을 한 줄에 배치하고,
현재가는 기존 `text-sm` 크기를 사용한다. 같은 날 후속 요청으로 현재가·등락률은
종목 코드 바로 오른쪽에 붙이고, 히트맵 그룹명은 기존 오른쪽 위치를 유지한다.
같은 날 승인한 균형형 배치는 종목명–코드 4px, 종목 정보–시세 8px,
현재가–등락률 4px을 사용한다. 시세 칸의 고정 폭을 제거하고 숫자 길이에 맞춰
배치한다. 현재가는 sm·600, 등락률은 xs·400으로 구분한다.
좁은 창의 메타데이터 생략과 버튼 우선순위는 유지한다. 드래그·리사이즈 좌표, 호가 20단과 숫자 폭,
행 높이, 주문·정정·취소, 창 연결·고정·프리셋은 기존 구현을 유지한다.
브랜드의 궤도선만 허용하고 차트 위 배경 장식·상시 발광·동작 애니메이션은 추가하지 않는다.

2026-10-22 사용자 승인: 대표지수 차트 제목줄에도 지수명·지수값·전일 대비 등락률을
같은 한 줄 위계로 표시한다. 지수값은 소수점 두 자리, 등락률은 부호와 기존 가격
방향 색을 사용한다. 전일 종가·등락 포인트·기준 거래일·시세/조회 시각은 키보드로도
접근 가능한 툴팁에 둔다. 장 종료 시 마지막 시세를 유지하고, 조회 실패·지연은
마지막 정상값 옆에 다시 조회 동작을 제공한다. 최초 미수신은 `—`다. 좁은 창은 기존
시세 생략 순서와 창 조작 버튼 우선순위를 따른다. 미국 지수는 뉴욕 거래일과
최신 분봉/완료 일봉 기준, 공급자 지연 미확인을 툴팁에 명시한다.

2026-10-23 사용자 요청: 모든 `/live` 창의 제목줄에서 네이티브·커스텀 호버 툴팁을
제거한다. 제목·그룹 번호·수집 상태·시세·경고·설정/축 상태·최대화·항상 위·종목 고정·닫기
모두 포함하며, 위의 지수 상세 툴팁과 아래 그룹/축 상태 툴팁 유지 규칙을 대체한다.
예외는 캔들 차트 제목줄의 국내 종목명이며, 히트맵의 Code별 330종목 설명을 공유해
500ms 뒤 2~3줄로 표시한다. 키보드 포커스도 지원하고, 종목 변경·포인터 누르기·창 닫기에는
해제한다. 설명이 없는 Code·지수·미국 종목은 툴팁을 표시하지 않는다. 버튼의 접근성 이름과
동작·메뉴·본문 툴팁은 유지한다.

**Trading Desk 피처 페이지 확장 (2026-10-19, 사용자 승인):** `/heatmap`·`/market`·
`/screener`·`/sentiment`·`/inventory`·`/capture`도 같은 브랜드·패널·조작 스타일을
사용한다. 공통 상단 메뉴는 라임 활성 밑줄과 궤도 마크를 공유하고, 피처 카드에는
`bg-card`·`border`·`radius-window`·짧은 그림자로 경계를 만든다. 기존 중앙 고정 폭,
열 배치, 표 행 높이와 가상 목록, 스크롤·키보드·드래그 계약을 유지한다.
히트맵 그룹의 온도 틴트와 옵션의 콜/풋 색 의미는 보존한다. 선택 버튼은 라임,
표 헤더와 필터는 올리브 보조 배경을 사용한다. 페이지 이름이나 테마 이름을 별도
장식 라벨로 반복하지 않는다. 다른 테마의 평면 스타일은 유지한다.
2026-10-22 사용자 승인: 히트맵 보드 종목명 호버에 간결형 기업 설명 툴팁을 표시한다.
종목명·코드와 핵심 사업·제품의 2~3줄 설명을 담고, 종목 코드별 설명을 모든 그룹에서
공유한다. 너비 20rem·본문 sm·안쪽 여백 md·모서리 lg·기존 표면/경계/그림자 토큰을
사용한다. 500ms 뒤 열고, 행 높이·클릭·드래그를 유지하며 키보드 포커스도 지원한다.
화면 가장자리에서는 위치를 보정하고 Esc·스크롤·드래그 시작에 닫는다. 기존 수집일
안내는 하단 보조 영역에 유지한다. 과거의 종목명 전체 호버 안내 억제는 이 승인으로 대체한다.
2026-10-20 사용자 요청: 공통 상단 메뉴 아래 구분선과 우측 상태 버튼의 외곽선을 제거한다.

설정 UI 정리(2026-10-21 사용자 요청): 「알림」 목차·본문과 알림 사용·기준 시각·
기준 최대값 대비 문턱·분봉 내 최대 매도 총잔량 판정 입력을 제거한다. 시그널 알림
패널에서도 해당 설정으로 이동하는 버튼을 제거한다.

## Product Context

**옵션심리 구조 중심 배치 (2026-10-19, 사용자 승인):** `/sentiment`은 기초자산·근월물·
계층별 관측 시각, 네 요약, OI·GEX·IV 공유 행사가 스택 순서로 읽는다. 우측에는 P/C
추이와 전체 체인 기준 미결제 상위 기여 표를 둔다. 세 차트의 선택 행사가를 공유하고
키보드 범위 입력으로도 비교한다. 기여 표 선택은 전체 축으로 전환해 극외가를 확인한다.
기존 ATM ±15%/전체 도메인, 수집·계산·폴링, 전수/ATM 시각과 지연, 결측값, 주간 범위,
콜·풋 색상과 GEX 중립색, 각 지표의 해석 한계를 유지한다. 좁은 폭에서는 패널을 쌓고
표만 내부 가로 스크롤하며 내비게이션은 시장 종합과 같은 반응형 셸을 사용한다.

**시장 종합 흐름 중심 배치 (2026-10-19, 사용자 승인):** `/market`은 지수 →
투자자 수급·업종 등락/수급 → 프로그램·거래대금·주변 자금 → 종목 탐색 순서로 읽는다.
기존 열 배치 유지 규칙은 이 페이지에서 새 승인 배치로 대체한다. 수급의 세 주체는
차트 위 요약 숫자로, 업종 등락과 세 주체 순매수는 한 표로 표시한다. 업종의 시장·
분류·정렬·전체 보기와 수급 미제공 행을 보존하고 두 데이터의 조회 기준을 구분한다.
2026-10-23 사용자 승인: 업종 표의 외국인·기관·개인 정렬 버튼을 제거하고 기본순·
상승순·하락순을 유지한다. 세 주체 열은 정렬과 관계없이 순매수 빨강·순매도 파랑
배경을 표시한다. 종합을 포함한 현재 표시 행의 세 열 전체에서 순매수 절대값의
최댓값을 공통 농도 기준으로 삼고 최대 혼합 비율은 기존 45%를 유지한다.
0과 수급 미제공 값에는 배경을 칠하지 않는다.
같은 날 후속 승인: 위쪽 기본순·상승순·하락순 버튼을 제거하고 다섯 열 헤더를
정렬 버튼으로 사용한다. 업종은 이름 오름차순→내림차순→제공 순서, 등락·세 주체는
값 내림차순→오름차순→제공 순서로 순환한다. 수급은 부호를 포함한 금액으로
비교하고 결측값은 양 방향 모두 마지막에 둔다. 다른 열을 누르면 그 열의 첫 정렬로
시작하며 활성 헤더에만 ▲·▼를 표시한다. 종합 행 고정과 세 열 공통 농도는 유지한다.
후속 요청으로 업종 표 위의 `12/24개 · 외국인 내림차순` 형태의 개수·정렬 상태
라벨을 제거한다. 정렬 방향은 활성 헤더의 ▲·▼로 표시한다.
순위 세 종류와 연속 매매 두 주체는 카드 안에서 전환하며 각 주체의 저장된 시장·방향을
유지한다. 중앙 최대 폭 1680px, 기존 테마·데이터 색상·기간·세션·결측값 의미는 유지한다.
좁은 폭에서는 행을 순서대로 쌓고 숫자 표만 내부 가로 스크롤한다.
사용자 후속 요청에 따라 프로그램 일별의 기간 합계는 카드 하단에 고정하고 날짜별
목록만 스크롤한다. 별도 `표본 N거래일` 라벨과 거래대금 카드 하단의 조회 시각·
누적 집계 안내 문장은 제거한다.
이어진 사용자 요청에 따라 카드의 기준일·조회/수신 시각·정상 수집 상태·저장 표본과
일별 목록 위 요청/제공 기간·단위 안내 문장을 제거한다. 업종의 수급/등락 기준일 행도
상시 표시하지 않는다. 조회 실패·수신 지연·파생 단위 미확정은 해당 상태일 때 표시한다.
추가 요청으로 업종 표 하단의 시세·수급 우선순위 설명도 제거한다. 프로그램 카드의
제목과 당일/일별·억원 표시는 한 줄로 배치한다.
2026-10-20 사용자 승인: 거래와 자금 세 카드는 헤더·필터·요약·차트·축·하단 정보의
공통 행으로 정렬한다. 차트는 7rem에서 9rem으로 키우고 카드 내부의 남는 공간을
줄인다. 주변 자금은 최신 잔고를 차트 위, 기간 증감을 아래의 3열 요약으로 배치한다.
투자자 수급·업종이 나란히 놓일 때 카드 하단선을 맞추고 업종 목록은 남는 높이를
채워 내부 스크롤한다. 좁은 화면의 세로 배치와 프로그램 일별 합계의 하단 고정은 유지한다.
같은 날 후속 승인: 거래와 자금 영역은 콘텐츠 컨테이너 60rem 이하에서 세 카드를
한 열로 쌓는다. 중간 폭의 2+1 배치와 마지막 카드의 전체 열 확장을 제거한다.
시장 카드의 안쪽 여백은 md, 주요 영역과 포함된 순위·연속 매매 본문의 간격은 sm으로
공통화한다. 헤더의 가로 간격은 sm, 줄바꿈 간격과 구분선 위 여백은 xs를 사용한다.
표 행 높이·숫자 크기·차트 9rem 높이·일별 합계의 하단 고정은 유지한다.
2026-10-23 사용자 요청: 주변 자금의 최신 잔고·차트·기간 증감은 고객예탁금·코스피
신용융자·코스닥 신용융자 순서로 표시한다. CMA와 신용융자 합계는 표시하지 않는다.
2026-10-21 사용자 승인: 투자자 수급 제목 바로 오른쪽에 단위를 xs 간격으로 한 줄에
표시한다. 코스피·코스닥의 당일·일별에는 항상 `억원`을 표시하며, 파생은 금액 단위가
확정되면 `억원`, 미확정이면 `계약 · 단위 미확정`을 표시한다. 단위의 작은 보조색
글씨를 유지하고, 좁은 폭에서는 제목·단위를 함께 둔 채 우측 조작부만 다음 줄로 옮긴다.
2026-10-23 사용자 요청: 전역 하단 시장지표 바의 수급은 코스피·코스닥·K200 선물
모두 외국인(표시명 외인)·기관·개인 순서로 표시한다.
후속 요청으로 수급 앞의 `순매수 · 억원` 라벨을 제거한다.
이어진 요청으로 하단의 `지수 ›`·`수급 ›` 전환 안내 버튼을 제거한다. 빈 영역 클릭과
10초 자동 전환·자동/정지 버튼을 유지하며, 푸터 포커스에서 Enter·Space로도 전환한다.
후속 요청으로 하단 지수 바에서 KRX100을 제거하고 코스피·코스닥·코스피200·코스닥150을 표시한다.

- **What this is:** Single-user local desktop tool that captures Korean stock orderbook + trade replay data from `hogaplay.com` and exposes it for analysis through a browser frontend.
- **Who it's for:** The single user (analyst/researcher) running the tool on their own machine. No external audience.
- **Space/industry:** Financial market microstructure analysis — KRX cash equities, orderbook replay.
- **Project type:** Local desktop web app, analyst workstation.
- **Memorable thing:** "A trading desk that feels modern, not 1990s — information density that stays readable."

## Scale Factor

The design system has a **single density dial** at `:root font-size`.

| Term | Meaning |
|---|---|
| **Base intent (1.0×)** | The pixel target captured in token rem values, calibrated against a 16px root. Reflects the original 2026-05-20 design intent. |
| **Default density (1.0×)** | What the app renders at browser zoom 100%. `:root { font-size: 16px }` — since 2026-08-07 the default *is* the base intent, so rendered px equals `baseIntentPx` and the two columns of the token tables coincide. (Was 1.125× / 18px from 2026-07-15.) |
| **Scale dial** | The `:root font-size` declaration in `frontend/src/styles/tokens.css`. Changing it shifts all CSS sizing uniformly. |

**Scope of the dial:**
- ✅ CSS-rendered chrome — fonts, spacing, layout widths, line-heights (all rem-based).
- ❌ `lightweight-charts` canvas — canvas cannot read CSS rem, so the constants live in TS. They *derive* from `RENDERED_ROOT_PX` (`util/chartScale.ts`, `chart/highLowLabelLayout.ts`) so a dial change reaches them, but charts read them at mount — a runtime toggle still needs a remount. **Two canvas constants stay deliberately pinned and do not follow the dial**: `CHART_LAYOUT_OPTIONS.fontSize` (12, see the note at that constant) and `PeakWallSegmentsPrimitive.LABEL_FONT_PX` (11). When adding a canvas text size, derive it — do not hand-compute the px.
- ❌ 1px borders, hairlines, small radii (2–6px), chart canvas internal coordinates — stay in px to protect anti-aliasing and pixel-grid sharpness.
- ❌ **고정 px 콘텐츠만 담는 레이아웃 트랙** — 트랙의 단위는 그 트랙이 보호하는 것의 단위를 따른다. 현재 사례는 하나 — `HeatmapRow` 의 캔들 글리프 열(`14px` = `CandleGlyph.W` 10 + 여유 4, 2026-08-19). rem 으로 두면 **배정만 다이얼을 따라 줄고 내용은 고정**이라 내릴수록 여유가 잠식되고(실측: `0.875rem` 은 root 16/14/12px 에서 14→12.25→10.5px), 셀이 `overflow-hidden` 이라 넘치면 **에러 없이 잘리기만 한다**. 이는 `--app-floor-min-w` 가 rem 인 이유(아래 Responsive floor)의 대우다 — 그쪽은 보호 대상이 전부 rem 기반이다. **텍스트에는 적용되지 않는다**(아래 🚫).
- 🚫 **타이포에 임의값 px 를 쓰지 않는다** (`text-[10px]` 류). 다이얼이 못 잡는 유일한
  DOM 표면이라 그 텍스트만 밀도 변경에서 낙오된다 — 2026-08-04 에 71곳이 그 상태였다
  (아래 결정로그).
  - **맞는 크기가 없으면 토큰을 신설한다.** 하드코딩은 게으름이 아니라 **스케일 공백의
    증상**인 경우가 많다. 71곳의 최대 무리(`10px`·`10.5px` 39곳)가 정확히 `badge`(9.56px
    렌더)와 `xs`(11.81px 렌더) 사이 빈 구간이었고, `text-2xs`(렌더 10.125px) 신설로
    시각 등가(±0.4px)로 흡수됐다. 공백을 놔둔 채 양옆 토큰으로 밀어내면 멀쩡한 텍스트가
    최대 +12.5% 움직인다.
  - **위계가 걸리면 근사 최단 매핑보다 위계가 우선.** 같은 파일에서 `11px`/`12px` 를
    나눠 쓰고 있었다면 그건 의도된 2단이므로 `xs`/`sm` 으로 갈라 유지한다.
  - **함정 (2026-08-07 에 성격이 바뀌었다 — 더 위험해졌다):** 1.125× 시절에는 표의
    **base-intent 열**을 px 로 박으면 렌더값과 어긋나(`xs` base 10.5px → 렌더 11.81px)
    화면에서 바로 티가 났다. 다이얼이 1.0× 가 된 지금은 **두 열이 같은 값**이라
    `text-[10.5px]` 를 박아도 오늘은 아무 증상이 없다. 규칙은 그대로다 — 다이얼이
    다시 움직이는 순간(아래 density 모드) 그 텍스트만 조용히 낙오하고, 이번엔 **직전
    화면과 비교할 근거조차 없다**. 값이 맞아 보이는 것은 우연이지 허가가 아니다.

**Future density modes (backlog):** A user-facing toggle would set `:root font-size` via `[data-density="..."]`. The app now ships at what that backlog called **Compact (1.0× / 16px)**; the remaining rungs are Comfortable (1.125× / 18px — the default until 2026-08-07) and Cozy (1.25× / 20px — the default until 2026-07-15). Both have shipped before, so the ladder is measured, not hypothetical. Blocker unchanged: canvas constants derive from `RENDERED_ROOT_PX` but charts read them at mount, so a runtime toggle needs a chart remount. Not in scope today.

## Aesthetic Direction

- **Direction:** Industrial/Utilitarian × Modern Professional ("Quiet Trading Terminal")
- **Decoration level:** Minimal-intentional — typography does the work. Single accent color. No patterns, textures, gradients, or decorative blobs.
- **Mood:** Serious. Information-first. The product should feel like a precision tool, not a SaaS dashboard. Closer in spirit to Linear than to a Y Combinator startup landing page.
- **Reference points:** TradingView (chart syntax), Linear (UI restraint), Vercel (typography), Bloomberg (data density — but without the 1990s color palette).
- **Density posture:** Ships at **1.0× — the original base intent** (`denser than typical SaaS`, Bloomberg-leaning), reached 2026-08-07 by walking the dial down 1.25× (until 2026-07-15) → 1.125× (until 2026-08-07) → 1.0×. The looser rungs stay reachable through a future density toggle. The product DNA is "Linear-like restraint" at the chosen density, not "must always be small" — the dial is the knob for that judgement, and it has now been turned three times, so treat it as tunable rather than settled.

## Typography

**Live window roles (2026-09-30, user-approved):** Use the investor estimate
window as the reference across `/live`: window titles, primary data, and controls
use `--text-sm` (11.5px); table headers, metadata, percentage readouts, legends,
and badges use `--text-xs` (10.5px). These roles are scoped to `.live-window`,
including shared sidebar cards mounted there. Preserve weight/color hierarchy,
the single-line candle header, and the same sizes in narrow windows. Existing
fixed canvas axis/primitive sizes remain governed by the canvas exceptions above.
2026-10-19 사용자 승인: 10호가·호가주문 창은 종목명 옆에 NXT 지원 여부 배지만
표시한다. KRX 배지는 생략하고 `NXT 지원`·`NXT 미지원`·`NXT 미확인`으로 구분한다.
지원 여부는 현재 종목 마스터 기준이며 시세·주문 거래소 선택과 독립적이다.
별도의 시세 거래소 선택 줄이나 정규장 라벨은 추가하지 않는다.
2026-10-16 사용자 승인: 창 헤더의 연결 그룹 배지는 `연결` 문구 없이 번호(1~10)만
표시한다. 기존 글자 크기·높이·색상·모서리를 유지하고, 두 자리 숫자가 들어가는
고정 폭을 사용한다. 그룹 변경 툴팁·접근성 이름과 번호 선택 메뉴는 유지한다.
2026-10-18 사용자 승인: 모든 `/live` 창은 최대화·항상 위·종목 고정 아이콘을 우선
노출한다. 제목은 남은 공간에서 말줄임하고, 짧은 제목의 최소 공간과 전체 버튼이
실제로 함께 들어가지 않을 때만 `…`으로 접는다. 체결창의 별도 설정 메뉴는 유지한다.
2026-10-20 사용자 요청이 위 접힘 규칙을 대체한다. 모든 `/live` 창의 제목줄에서
창 조작 아이콘을 항상 표시하고, 창 종류·종목명·시세·보조 정보가 먼저 줄어들거나
가려지게 한다. 설정이 있는 창은 오른쪽 아이콘 묶음의 맨 왼쪽, 최대화 앞에 같은
톱니바퀴 버튼을 둔다. 최소 창 폭 160px에서는 버튼 상자의 폭과 간격만 줄이며
글자·아이콘 크기와 창 좌표·리사이즈 계약은 유지한다. 180px 이하에서는 제목을
통째로 숨겨 글자 일부만 보이는 상태를 피한다. `…` 메뉴로 접지 않는다.
캔들 차트 설정 팝오버는 기존 설정의 `캔들 · 지표`·`격자 · 구분선` 여섯 토글과
행·설명·되돌리기 UI를 공유한다. 후속 요청으로 6개 값은 창별로 독립 적용·저장하며
헤더에 `이 차트에 적용`을 표시한다. 봉 주기·종목 변경 후에도 같은 창의 값을 유지한다.
기존 전역값은 각 창의 최초 이관에만 사용하고, 새 차트는 포커스 차트의 값을 복사한다.
워크스페이스 프리셋은 각 창의 설정을 함께 저장·복원하며, 되돌리기는 해당 창의
직전 변경에만 적용한다. 확장 규칙은 [창별 설정 지침](docs/agents/window-settings.md)을 따른다.
또한 이 여섯 항목과 두 소그룹은 기존 앱
설정의 본문·검색에서 제거하고 캔들 차트 헤더 팝오버에서만 표시한다. 체결창 설정도
같은 제목줄 버튼 위치를 사용한다.
2026-10-21 사용자 요청: 해외주식·해외지수 캔들 차트의 Y축 눈금·현재가 태그·크로스헤어 가격은
소수 둘째 자리로 표시한다(분·일·주·월 공통). 같은 날 후속 요청으로 툴팁·시가·고가·
저가·종가와 가격 지표·극값 라벨도 소수 두 자리를 항상 표시한다(120 → 120.00).
Y축 눈금·현재가 태그·크로스헤어 가격에도 천 단위 쉼표를 적용한다(1234567.89 → 1,234,567.89).
원본 OHLC 정밀도와 국내 종목·국내 대표지수 가격 표기는 유지한다.
2026-10-20 사용자 승인: `캔들 · 지표`에 기본값이 꺼짐인 `로그 스케일`과
`차트 거꾸로 보기` 토글을 추가한다. 분·일·주·월에서 함께 사용할 수 있고 기존과
같이 창별로 저장한다. 캔들 가격축과 같은 축을 쓰는 가격 지표·드로잉에 적용하며
거래량·하단 지표의 축, 실제 가격·등락률과 상승·하락 색상은 유지한다.
같은 날 사용자 후속 요청: 캔들 차트 제목 헤더의 설정 버튼 옆에 활성 상태인
`로그`·`반전` 배지를 표시한다. 배지를 누르면 해당 창의 차트 설정을 연다.
240px 이하에서는 한 줄 헤더와 창 조작 아이콘을 유지하기 위해 배지를 접고,
설정 아이콘의 선택 틴트와 툴팁으로 활성 상태를 안내한다.
같은 날 사용자 후속 승인: `차트 거꾸로 보기`의 세부 설정에 기본값이 켬인
`반전 시 캔들·거래량 색상 교환`을 추가한다. 반전과 이 옵션이 함께 켜졌을 때
캔들 몸통·꼬리 및 거래량 봉의 상승·하락 색상을 교환한다. 동시호가 회색과 실제
가격·등락률·거래량 수치는 유지한다. 이 결정은 위의 반전 시 색상 유지 규칙을 대체한다.
헤더의 반전 상태 툴팁은 캔들/거래량 색상 교환의 켜짐·꺼짐도 함께 안내한다.
2026-10-20 사용자 승인: `캔들 · 지표`의 `캔들이 항상 위` 바로 아래에
`잔량 히트맵을 캔들 위에` 토글을 추가한다. 기본은 끔(캔들이 위)이며 켜면
호가 잔량 히트맵을 캔들 앞에 기존 불투명도로 그린다. 두 항목 사이의 순서는
이 토글이 우선하며 `캔들이 항상 위` 설명에 별도 설정임을 명시한다.
기존 행·설명·스위치와 창별 저장·되돌리기·프리셋을 공유한다.
The calendar-chart “분봉으로” action sits directly after “그리기” in the toolbar,
with its label folded at narrow widths, rather than inside the More popup.

**One typeface, two figure styles.** Pretendard carries Latin + Hangul, prose and data alike. There is **no monospace face in the system** — column alignment comes from tabular figures (`tnum`), not from a monospaced typeface.

- **Display / Hero / Brand:** Pretendard 600–700 — neutral geometric sans, distinctive without being decorative.
- **Body / UI labels:** Pretendard 400–500 — same family as Display for visual continuity.
- **UI / Labels:** Same as body. Small-caps section headers use 10.5px / 600 weight / uppercase, **letter-spacing `normal`** — the system does not track type.
- **Data / Tables / All numbers:** Pretendard 400–600 via the **`font-data`** utility, which carries `font-feature-settings: "tnum"` automatically. Every numeric value uses tabular figures so columns hold their grid.
- **Code (future, if any):** no face reserved. Introduce one only with an explicit decision — do not reach for `monospace`.

- **Font tokens:** `--font-ui` / `--font-data` (theme-independent, defined on the base block in `tokens.css`; Tailwind `font-ui`/`font-sans` → `--font-ui`, `font-data` → `--font-data`). Both resolve to the *same* stack — they differ only in figure style. **Do not reference a font family by name in a component** — always go through the token.
  - **Canvas surfaces** (lightweight-charts axis text, chart drawing labels) cannot read CSS custom properties. They go through `CANVAS_FONT_STACK` in `styles/design-tokens.ts` — one literal, mirroring `--font-ui`, consumed by `util/chartScale.ts` and `chart/drawing/render.ts`. Do not add a third literal. Canvas 2D has no `font-feature-settings` equivalent, so canvas digits are proportional; `tnum` reaches DOM surfaces only.
  - `CHART_LAYOUT_OPTIONS` must be spread **inside** the chart's `layout` option, not at the options root. Spreading it at the root is silently ignored by lightweight-charts — that is how the axis kept the library's default font from v1 until 2026-07-21. Guarded by a nesting assertion in `LiveChartRoot.test.tsx`.
  - `font-mono` survives in `tailwind.config.ts` as a **deprecated alias** mapped to the same value. Do not use it in new code. It is kept mapped rather than deleted so a stray `font-mono` from an unmerged branch fails safe (deleting the key would hand it Tailwind's default monospace stack, whose digits are *not* guaranteed tabular).
- **Why tnum instead of a monospace face:** measured 2026-07-21 — Pretendard's digits are proportional by default (`1` is 7px narrower than `4` at 40px) and collapse to a single uniform width under `tnum`. With `tnum` disabled on a live orderbook, 20 nine-digit prices rendered at **18 distinct widths (3.12px spread)**; with it on, **1 width (0px spread)**. Alignment is therefore a property of the feature flag, not the face — which is why `tnum` is bound to the `font-data` utility rather than left to each call site.
- **Loading strategy:** Pretendard via jsDelivr `<link>` in `index.html` (preconnect + render-blocking stylesheet), `pretendardvariable-dynamic-subset`. Dynamic subset ships per-unicode-range woff2 chunks, so a cold load fetches only the ranges on screen instead of a multi-MB Hangul file. Render-blocking is deliberate: a swap would reflow every number column.
- **History:**
  - v1 speced Geist Sans/Mono but the `--font-ui`/`--font-mono` tokens were never defined, so the app silently rendered in the browser serif default (Times). Fixed 2026-07-08 by defining the tokens and switching to IBM Plex.
  - 2026-07-21: IBM Plex Sans KR + IBM Plex Mono → Pretendard single family; `--font-mono` → `--font-data`; letter-spacing dropped to `normal` throughout. See the decision log.

- **Scale (rem-based, single dial at `:root font-size`):**

<!-- BEGIN AUTO: tokens-typography -->
| Token | Base intent (1.0×) | Rendered @ default (1×) | Use |
|---|---|---|---|
| `badge` | 8.5px | 8.5px | Hierarchical badges (e.g., SymbolSearch market tag) |
| `2xs` | 9px | 9px | Dense chrome micro-labels (창 크롬 서브라벨·상태 칩) |
| `xs` | 10.5px | 10.5px | Small-caps labels, badges |
| `sm` | 11.5px | 11.5px | Table rows, secondary data values |
| `base` | 13px | 13px | Body / UI default |
| `md` | 14px | 14px | Section / page headings |
| `lg` | 16px | 16px | Brand text |
| `xl` | 22px | 22px | Current price (price strip) |
| `2xl` | 32px | 32px | Future hero numerics |
<!-- END AUTO: tokens-typography -->

## Color

- **Approach:** Restrained. Single UI accent per theme. Three mutually-exclusive color categories for UI state, status semantic, and price direction. All palettes share one token contract (see below) — components never branch on theme, they only read tokens.
- **Themes (seven, selectable):** the app ships seven full palettes behind `<html data-theme>`:
  - **Obsidian** (dark) — warm graphite surfaces + brass accent. The trading-terminal / live surfaces.
  - **Ledger** (light) — ivory paper surfaces + banker's-green accent. The review/research surfaces.
  - **Toss Light** (light, `toss-light`) — white cards on a grey floor + toss-blue accent. Benchmarked from tossinvest.com's live tokens (2026-07-22). The former default preference (2026-08-07 to 2026-10-19); existing saved preferences are preserved. See the Toss Light/Dark note below the token table for the accent-vs-price collision.
  - **Toss Dark** (dark, `toss-dark`) — lighter cards on a near-black floor + toss-blue accent. The dark counterpart of Toss Light, benchmarked from tossinvest.com's live dark tokens (2026-07-22). **Manual-select only.**
  - **Obsidian Pro** (dark, `obsidian-pro`, user-approved 2026-10-17) — cool graphite floor `#101216`, raised panels `#171a20`, amber UI accent `#e9b44c`, coral up `#ff747f` and blue down `#7aafff`. Live monitoring palette; dark moving-average defaults inherited from the base.
  - **Ledger Studio** (light, `ledger-studio`, user-approved 2026-10-17) — ivory floor `#f5f3ed`, paper panels `#fffefa`, forest-green UI accent `#28664d`, red up `#ba3a47` and blue down `#285eb3`. Review/research palette; light moving averages and paper elevation shared with Ledger.
  - **Trading Desk** (dark, `trading-desk`, user-approved 2026-10-19) — olive-black floor `#0b0f0b`, olive panels `#121811`, lime `#c7fa79`, coral up `#f47f89` and blue down `#82b1fa`. The default when no preference is saved. Live-specific chrome is described above.
  - The **preference** (`obsidian` / `ledger` / `toss-light` / `toss-dark` / `obsidian-pro` / `ledger-studio` / `trading-desk`) lives in `state/themePrefs.ts` (localStorage `ui.themePreference.v1`). **The preference IS the theme** — there is no resolution step and the route is not an input (the `auto` preference that made it one was removed 2026-08-30; see the History table). `subscribeThemeToDom` writes it to `data-theme` **synchronously inside the store's `set()`** — not from an effect, because React runs child effects before parent ones and the chart would otherwise read the old CSS variables (#1656); `index.html` sets it inline before first paint (FOUC + wrong-theme chart cache guard).
  - **Scope: the user's open browser tabs, not just one.** `subscribeToThemePreferenceStorage` (App.tsx, one subscription for every route since App is the layout route) mirrors another tab's change through the `storage` event, so a tab opened *before* the change follows without a reload — `/live` deep links open in new tabs, so stale tabs were the normal case. What travels between tabs is the **preference**, which since 2026-08-30 is the theme itself — every tab lands on the same value regardless of its route.
  - **Selectors:** `:root, [data-theme='dark'], [data-theme='obsidian']` carry the Obsidian palette + the scale dial + font + all size/spacing/layout tokens. Palette overrides live outside the generated base span. Trading Desk adds the approved live chrome above; density and saved workspace geometry stay theme-independent. Ledger Studio also matches the shared Ledger light-palette block before its own overrides. The `--color-scheme` token supplies `dark`/`light` for native controls such as the news date field, without component branches on theme names. Theme choices wrap inside narrow settings editors.

  > Table below shows the two primary themes (Obsidian/Ledger). **Toss Light** and
  > **Toss Dark**, **Obsidian Pro**, and **Ledger Studio** are extra palettes;
  > rather than widen every row, their values live in `tokens.css` and the
  > palette summaries in this section.

  | Token | Obsidian (dark) | Ledger (light) | Use |
  |---|---|---|---|
  | `--bg` | `#121216` | `#FDFCF8` | App background — 양 테마 모두 `--bg-card` 와 동일 톤(배경 통일, 2026-07-15 #636 다크 · #637 라이트). 카드 분리=4px gap+`--shadow-panel`(양 테마, borderless — feature-route 카드도 테두리 없음, 2026-07-15 통일; 라이트는 옅은 shadow 로 경계가 다크보다 약함). **Toss Light 예외**: `--bg #f6f7f9` ≠ `--bg-card #ffffff` — 토스식 층 구조를 되살려 명도차로 카드를 분리한다(아래 Toss Light 노트) |
  | `--bg-card` | `#121216` | `#FDFCF8` | Panes, cards, toolbars |
  | `--bg-subtle` | `#0E0E11` | `#F2EFE7` | 설정/지표 nav, 모달 내부 recessed 박스, recessed rows. **앱 셸 크롬에는 더 이상 쓰지 않는다** — `TopNav` 헤더·하단 시장지표 바·`/study` 워크스페이스 탭 바·`/live` price strip 에 이어 **우측 패널(RightRail·드로어 RailShell·드로어 sticky 그룹헤더)까지 `--bg` 로 통일**(2026-07-29, 배경 통일 완결). 새 셸 표면에 이 토큰을 쓰기 전에 아래 결정로그를 볼 것 |
  | `--bg-legend` | `color-mix(--bg-card 70%, transparent)` | 좌동 (파생) | 차트 위 pane 레전드 전용 반투명 surface — 유일한 반투명 배경 토큰. 차트 배경이 `--bg-card` 라 빈 영역에선 안 보이고, 캔들·거래량 바 위에 겹칠 때만 최소 대비를 남긴다. `--bg-card` 파생이라 테마 전환을 자동 추종 — **테마별 rgba 하드코딩 금지**. 앱 크롬 재사용 금지 |
  | `--bg-input` | `#101014` | `#FDFCF8` | Inputs, comboboxes, default tab |
  | `--bg-input-hover` | `#1A1A20` | `#F0EDE4` | Hover state |
  | `--border` | `#232329` | `#E4E0D3` | Default borders, dividers |
  | `--border-strong` | `#33333C` | `#C9C3B2` | Active borders, vertical dividers |
  | `--chart-pane-divider` | `#3a3a42` | `#bcb4a0` | Chart pane separators only (lightweight-charts `layout.panes`); `--border-strong` 근처 톤으로 pane 경계는 남기되 소음은 억제(2026-07-15 완화 — 이전 다크 `#63636f`/라이트 `#9a917c`는 화면 최강 선이라 "분리는 톤+간격" 규칙과 충돌) |
  | `--chart-day-boundary` | `#6d6d7b` | `#8a8271` | 분봉·초봉 차트의 거래일 경계 세로 점선(`DayBoundaryPrimitive`). **`--border` 계열을 재사용하지 않는다** — 아래 접근성 절 참조. `--bg-card` 대비 3:1 이상이 이 토큰의 계약이고(다크 3.67:1 / 라이트 3.71:1), 값을 바꿀 때 그 대비를 다시 잰다. 라이트는 종이 팔레트의 **따뜻한** 축을 따른다(차가운 슬레이트 블루 `#64748B` 가 겉돌던 것을 2026-08-27 에 교정) |
  | `--fg` | `#ECECF1` | `#1E2732` | Primary text |
  | `--fg-dim` | `#9A9AA8` | `#5C6673` | Secondary text, dim labels |
  | `--fg-dimmer` | `#63636F` | `#8B94A0` | **비활성(disabled) 요소와 장식 글리프 전용.** 3차 *텍스트* 에는 쓰지 않는다 — 아래 대비 규칙 참조 |
  | `--accent` | `#F0B429` (brass) | `#1F6F54` (green) | UI states only (buttons, focus, crosshair, active tab, primary CTAs) |
  | `--success` | `#2FBF71` | `#1F8A50` | UI 상태 semantic — 캡처 완료, 양호 상태, 체크리스트 done |
  | `--error` | `#F25C7A` | `#C13B52` | UI 상태 semantic — 실패, 에러 메시지, 비정상 상태 |
  | `--price-up` | `#F04452` | `#C4322E` | 시장 데이터 — 상승, 매수, KRX 빨강 컨벤션 |
  | `--price-down` | `#3485FA` | `#1E5FC1` | 시장 데이터 — 하락, 매도, KRX 파랑 컨벤션 |
  | `--grid` | `#1B1B21` | `#ECE8DC` | Chart grid lines, table row borders |
  | `--heat-hi` | `#F0B429` | `#1F6F54` | Heatmap high intensity (accent ramp) |
  | `--shadow` | `0 4px 12px rgba(0,0,0,0.5)` | `0 2px 8px rgba(30,39,50,0.12)` | Popover / tooltip elevation |
  | `--shadow-overlay` | `0 8px 24px rgba(0,0,0,0.4)` | `0 8px 24px rgba(30,39,50,0.16)` | Dropdowns, menus, small dialogs |
  | `--shadow-panel` | `0 18px 60px rgba(0,0,0,0.35)` | `0 2px 8px rgba(30,39,50,0.12)` | Page-level panes/cards (workarea, PageShell) |
  | `--shadow-modal` | `0 24px 80px rgba(0,0,0,0.45)` | `0 16px 48px rgba(30,39,50,0.2)` | Full-size modals (settings, indicators, search palette) |

- **Toss Light palette (2026-07-22, `[data-theme='toss-light']`):** a third, light,
  manual-select theme benchmarked from tossinvest.com's live design tokens. Key
  differences from Ledger (which it does NOT replace):
  - **Surfaces revive the layer step** (Ledger unifies `--bg`==`--bg-card`; Toss Light does not): `--bg #f6f7f9` (grey floor) with `--bg-card #ffffff` (white cards), so panels separate by luminance the way the reference does. `--bg-subtle`/`--bg-input-hover` `#f2f4f6`.
  - **Ink greys:** `--fg #191f28` · `--fg-dim #4e5968` · `--fg-dimmer #8b95a1`. Borders `--border #e5e8eb` · `--border-strong`/`--chart-pane-divider #d1d6db`. Day boundary `--chart-day-boundary #8b95a1` (grey500 — 3.04:1).
  - **Accent = toss blue** `#3182f6` (hover `#2272eb`, fg white). `--success #03b26c` · `--error #e42939` · `--warn #eb7300`.
  - **Price direction (KRX):** `--price-up #de2b39` (red) · `--price-down #1957c2` (blue).
  - **⚠ Sanctioned exception to the three-way color discipline — accent-vs-price blue collision:** Toss's brand accent is blue and Toss's "down" price is also blue; Toss has no "UI color ≠ price color" rule so it lets them overlap. We keep the toss-blue accent (it *is* the theme's identity) and instead push `--price-down` one tone **darker** (`#1957c2`, blue800) than the accent (`#3182f6`) so the two blues separate. accent rides SOLID-FILL contexts (buttons, active tab, focus, crosshair); down-price rides text/border. **The two blues being close is this decision, not a bug** — mirrors the pre-existing `--error`/`--price-up` both-red overlap. Not perfect on the highest-density surfaces (a blue crosshair over a blue down-candle can read close); accepted for this theme. Elevation/MA tokens reuse the Ledger paper values (both are light surfaces).

- **Toss Dark palette (2026-07-22, `[data-theme='toss-dark']`):** the dark counterpart of
  Toss Light, benchmarked from tossinvest.com's live *dark* tokens. Also manual-select only.
  - **Surfaces revive the layer step** (inverted from light): `--bg #101013` (near-black floor) with `--bg-card #17171c` (cards sit *lighter* than the floor), `--bg-subtle #0c0c0f` (chrome sunk below the floor), `--bg-input #202027` / hover `#2c2c35`.
  - **Off-white ink (NOT pure white):** `--fg #eceff5` — Toss's dark txt-primary is `rgba(242,246,255,0.9)`, deliberately avoiding `#ffffff` to cut glare. `--fg-dim #c3c3c6` (grey700) · `--fg-dimmer #7e7e87` (grey500). Day boundary `--chart-day-boundary #7e7e87` (grey500 — 4.44:1). Borders `--border #2c2c35` (grey100, kept subtle) · `--border-strong`/`--chart-pane-divider` `#4d4d59`/`#3e3f49`.
  - **Accent = toss blue** `#3182f6` (hover `#2562b9`, fg white). `--success #16bb76` · `--error #f65a68` · `--warn #fcb50c`.
  - **Price direction (KRX):** `--price-up #f5445a` (red) · `--price-down #56a3ff` (blue).
  - **⚠ Same sanctioned accent-vs-price exception, INVERTED direction:** on a dark surface a *darker* down-blue (Toss Light's fix) would sink into the background, so here `--price-down #56a3ff` is pushed **lighter** than the `#3182f6` accent instead. Separation direction is set by background luminance. Elevation/MA tokens reuse the Obsidian dark values.

- **Elevation rule:** components never hardcode `rgba(0,0,0,…)` box-shadows — always one of the four shadow tokens (Tailwind: `shadow-overlay`/`shadow-panel`/`shadow-modal`). Obsidian elevates with deep dark halos; Ledger elevates with faint ink-tinted paper shadows. A dark-tuned shadow reused on Ledger turns the ivory gaps between cards into grey trenches and visually deadens the main surface (fixed 2026-07-12).

- **Discipline rule:** Three mutually-exclusive color categories.
  - **UI state** (`--accent` — brass on Obsidian, green on Ledger): buttons, focus rings, active tabs, crosshair, primary CTAs. Never for data.
  - **Status semantic** (`--success`/`--error`): system feedback — capture complete/failed, error banners, calendar cell state, status dots. Never for market data.
  - **Price direction** (`--price-up`/`--price-down`): KRX convention — red = up/buy/positive delta, blue = down/sell/negative delta. Never for UI state or status.
  - This three-way separation prevents the "is this red because it failed, or because it's up?" ambiguity.

- **Tint backgrounds (alpha-tinted chip / hover):** each tracks its base color per theme — read the token, don't hardcode the rgba. Values below are the Obsidian defaults; `[data-theme='ledger']` redefines them against the Ledger accent/status/price colors.
  - `--tint-selection` — active nav, active tab, primary hover, **selected list rows** (tracks `--accent`)
    - **List-row selection rule:** selected rows use the background tint **only** — never add a left accent bar (`border-left: 2px solid var(--accent)` or `shadow-[inset_2px_0_0_var(--accent)]`). Inventory (`ListRow`) is the reference; all right-rail drawer rows (watchlist / heatmap / screener / ranking via `QuoteRow`, saved views) match it. Unified 2026-07-23 — do not reintroduce the accent bar.
  - `--tint-success` / `--tint-error` — completion / error chip background
  - `--tint-neutral` — 중립 칩 배경 (캡처 큐 대기/취소/건너뜀 phase 칩; 2026-08-04 신설 — rgba 하드코딩이 4테마를 못 따라가던 자리)
  - `--tint-success-border` / `--tint-error-border` — banner/chip borders
  - `--tint-price-up` / `--tint-price-down` — buy/sell depth bar, market chip (tracks `--price-*`)

- **10호가 잔량 숫자 (`--qty-ask` / `--qty-bid`, 2026-07-29):** 깊이 막대(`--bar-*`) 위에 얹히는
  잔량 **텍스트** 색. 별도 토큰인 이유는 두 가지 — (1) 막대는 알파 워시라 그 값을 텍스트에
  그대로 쓰면 대비가 무너진다, (2) 같은 행의 증감 뱃지(`priceDirClass`)와 **축이 다르다**:
  뱃지는 delta 의 부호(늘었나/줄었나), 이건 호가의 방향(매도냐/매수냐)이라 매수 잔량이 줄면
  빨간 숫자 옆에 파란 `−` 뱃지가 정상적으로 공존한다. 값은 **등락률 글자와 같은 방향색 2벌** —
  `--qty-ask: var(--price-down)`(매도 파랑) · `--qty-bid: var(--price-up)`(매수 빨강). 새 색이
  아니라 **별칭**이라 `:root` 한 곳 정의로 4개 테마가 각자 값으로 풀리고, 같은 패널 하단의
  총잔량 스트립(`text-price-down`/`text-price-up`)과도 자동으로 일치한다.
  **실측 근거(2026-07-29, tossinvest.com 주문 페이지):** 토스는 표면마다 톤 등급이 다르다 —
  종목 상세 본문 등락률 `blue600 #2272eb`/`red600 #e42939`, 우측 관심 리스트 `blue500 #3182f6`/
  `red500 #f04452`, 하단 지수바 `red700 #de2b39`. 우리 Toss Light 는 `--price-up #de2b39` /
  `--price-down #1957c2`(blue800) 로, 파랑이 한 톤 진한 것은 accent-vs-price 파랑 충돌의 승인된
  예외(위 Toss Light 항목)이지 드리프트가 아니다.

- **텍스트 대비 규칙 (2026-08-04):** **소형 텍스트에 `--fg-dimmer` 를 쓰지 않는다.** 실측
  대비가 배경 대비 **3.15:1(Obsidian) / 2.99:1(Ledger)** 로, WCAG AA 본문 기준(4.5:1)에
  못 미친다. 그리고 이 앱에서 "소형"은 예외가 아니라 기본이다 — AA 의 대형 텍스트 완화
  (18.66px bold / 24px)를 넘는 본문 토큰이 하나도 없어서 `xs`(11.8px)·`sm`(12.9px)·
  `base`(14.6px) 가 전부 *본문* 으로 판정된다. 3차 텍스트의 색은 **`--fg-dim`**
  (6.73:1 / 5.68:1, 양 테마 AA 통과)이다.
  - **`--fg-dimmer` 가 남는 자리:** (1) **비활성 요소** — WCAG 1.4.3 의 "Incidental"
    예외가 비활성 UI 컴포넌트를 대비 요구에서 빼 준다. 흐린 것이 여기서는 *기능* 이므로
    승격하면 비활성이 활성처럼 읽힌다. (2) **장식 글리프** — 창 헤더 드래그 핸들 `⠿`
    같이 텍스트가 아닌 것(`WindowFrame.tsx`). (3) `placeholder:` variant — 입력 힌트는
    별도 축이라 이번 승격 범위 밖이다. (4) 비거래일 캘린더 셀(`baseColorVarFor`) 처럼
    "선택 불가" 를 색으로 말하는 자리.
  - **"소형" 의 경계는 `base` 미만**이다 — `base`(14.6px) 가 "Body / UI default" 이므로
    `xs`(11.8px)·`sm`(12.9px) 와 그 대역의 임의값(`text-[10px]`~`text-[13px]`) 이 대상.
    2026-08-04 에 **142건 / 소스 71파일**을 승격했다. 이전에 아래 관심종목 그룹 헤더
    항목이 "≈3.9:1 로 AA 미달이지만 3차 텍스트로 의도된 트레이드오프" 라고 적어 둔
    자리도 여기 포함된다 — 그 트레이드오프는 폐기됐다.
  - **grep 만으로 판정하지 말 것.** 색이 클래스 문자열에 그대로 있지 않은 경로가 넷이고,
    2026-08-04 작업에서 넷 다 실제로 물렸다: (1) **부모-자식 분리** — 크기는 부모,
    색은 자식(`ResultTable` 정렬 헤더), (2) **멀티라인 className** — 크기와 색이 다른
    줄(같은 파일 `SortHeader`), (3) **변수·함수 반환값** — `toneClass` 삼항식
    (`WorkspaceShell`), `captureHealthPillColor()` 의 인라인 style(`.ts` 파일이라
    `*.tsx` 스캔에도 안 걸린다), (4) **임의값 문법** `text-[var(--fg-dimmer)]` —
    토큰 유틸리티가 있는데 우회한 형태(`StudyPage`·`StudyChartWindow`, 승격하며
    정규 클래스로 교정). **최종 판정은 렌더된 화면의 실측이다** — 라우트를 돌며
    `getComputedStyle` 로 대비를 계산하면 위 넷이 전부 드러난다(양 테마 0건 확인).
  - **`--border` 계열은 아직 미해결:** `--border` 1.20:1 / 1.29:1, `--border-strong`
    1.71:1 로 WCAG 1.4.11(비텍스트 3:1)에 못 미친다. 입력 필드 경계가 사실상 보이지
    않는다는 뜻이다. 텍스트 축과 별개 문제라 이번 승격에 포함하지 않았다.
    - **따라서 캔들 위에 그리는 선에 이 계열을 재사용하지 말 것.** 네 테마 실측:
      `--grid` 1.08~1.19 · `--border-strong` 1.46~2.14 · `--chart-pane-divider`
      1.46~2.01 — "테마 토큰이니 안전하다" 는 직관이 여기서 **반대로** 나온다.
      2026-08-27 에 날짜 구분선을 테마화하며 이 함정을 만났고, 전용 토큰
      (`--chart-day-boundary`, 3.04~4.44:1)을 새로 두어 피했다. 같은 상황이 오면
      기존 토큰을 고르지 말고 **전용 슬롯을 만들고 대비를 적어 둘 것**.

- **Semantic (banners / toasts):** read the token (values vary per theme).
  - Success: `--success`
  - Error: `--error`
  - Warning: `--warn`
  - Info: `--accent`

- **Price-direction heat ramp (히트맵 보드 전용):** `--price-up`/`--price-down` 을 |등락률| 비례
  가변 알파로 쓴다. **행 등락은 칩 배경이 아니라 `priceDirClass()` 텍스트 색 + 부호**로 표현한다
  (배경 워시 없음, `▲▼` 없음 — 색약 보조는 색+부호 2중; 우측 패널 `QuoteChange` 와 동일 컨벤션).
  **헤더 밴드는 `heatHeaderBg()`**(선형 램프, max α 0.5, 그룹 평균 등락 기준)로 틴트한다.
  `heatHeaderBg` 의 `linear-gradient(0deg, heat, heat)` 는 동색 2-stop 합성 idiom(시각상 단색)이라
  위 "no gradients"(장식 한정) 규율과 무충돌 — 기능적 gradient 선례 = depth bar.

- **Price-direction candle glyph (관심맵 행 전용):** `frontend/src/heatmap/CandleGlyph.tsx` 가
  당일 시·고·저·종을 1봉으로 그린다(고-저 심지 + 시-종 몸통). 색 = **종가 vs 시가**(strict):
  종가>시가 양봉 `--price-up`(적)·종가<시가 음봉 `--price-down`(청)·도지 `--fg-dim`. 이는
  *당일 시가 대비* 흐름으로 *전일대비* 등락칩(`change_pct`)과 다른 기준(다른 시간창). 가격
  방향 카테고리 준수(새 색 없음) — `heat.ts` 배경 확장의 캔들 버전.

- **Heatmap 폴더 surface 예외 (관심맵 보드 전용):** 신문형 멀티칼럼 고밀도 보드라 폴더 블록은
  `--bg-card` 카드(채움+테두리+라운드) 대신 **투명·평면**으로 둔다 — 그룹 경계는 헤더 밴드 +
  `--border-strong` 좌측 스파인(`border-l-2`) + 여백으로 잡는다. **헤더 밴드는 그룹 평균 등락 비례
  히트 틴트(`heatHeaderBg`, 선형 램프 max α 0.5)를 진다**; 폴더명은 `text-fg`, 평균값은 평면
  `text-fg-dim` 숫자. α 상향 금지(`text-fg-dim` 평균값의 틴트 밴드 위 대비 보호 — 원래 근거였던
  미분류명 `text-fg-dim` 분기는 ADR-0112 로 미분류가 폐지되며 소멸). 이 예외는
  **히트맵 폴더 한정**이며 드로어·차트·툴바 등 다른 카드는 `--bg-card` 유지.

- **Canvas theme reactivity:** `lightweight-charts` paints to a `<canvas>` and cannot read `var(--…)`, so chart colors resolve through `util/tokens.ts`. Use **`resolveTokensThemed(spec)`** (never the raw `resolveTokens` at module load) inside the projection/render function so a chart built under a different theme reads the live values. Projectors that embed color in cached per-point data (candle, volume, quoteTotals) carry the theme in their cache key; colors applied at series-options level use a thunk (`options: () => …`) resolved at `addSeries` time. `LiveChartRoot`'s `viewKey` includes the theme as a forward-safety net (a theme swap already coincides with an unmount in the shipped UX).
- **캔들 동시호가 색상:** KRX 캔들의 종가 동시호가 회색 표시는 캔들 조회 거래소를 기준으로 판단한다. 통합·NXT 캔들은 상승·하락 색을 유지한다. 종목의 현재 NXT 대상 여부로 실시간 venue가 KRX로 해석돼도 통합 1분봉의 19:50~20:00 색상을 회색으로 바꾸지 않는다(2026-10-16 사용자 요청).

- **Known limitation — MA / peak / drawing default colors:** the moving-average palette (`liveIndicatorsPersistence.ts`), peak-wall defaults, and drawing-tool colors are **user-selectable and persisted as hex in localStorage**, not theme tokens — so they do NOT change with the theme. As of 2026-09-08, the stock default MA-120 and new-slot palette use gray (`#6B7280`) instead of white for readability on light and dark surfaces. Persisted user colors stay unchanged. The style picker outlines its swatch and, when the selected hex color has less than 3:1 contrast against the current card background, offers an explicit gray replacement. `--ma-5` remains separate for token consumers.

- **No OS/system mode:** there is no "system/OS" auto-follow mode. `data-theme` is one of `obsidian`, `ledger`, `toss-light`, `toss-dark`, `obsidian-pro`, `ledger-studio`, or `trading-desk` at runtime (the legacy `dark` alias maps to Obsidian). There is no route-based mode either: the `auto` preference was removed 2026-08-30. All seven palettes are manual-select; Trading Desk is the default for new preferences (2026-10-19). (History: this was "both themes only, no third theme" until 2026-07-22.)

## Spacing

- 2026-10-19 사용자 일괄 적용 요청: 섹터 랭킹·봉 패턴·시그널 알림도 기존 행 구성·글자 크기·색·동작을 유지하며 실제 숫자를 수용하는 공통 열을 사용한다. 목록 폭 20rem 초과/16.25~20rem/16.25rem 이하에서 열 간격은 0.5rem→0.25rem→0.125rem, 레일 목록 좌우 여백은 0.75rem→0.5rem→0.25rem이다. 섹터 목록은 좌우 여백 0.5rem→0.375rem→0.25rem, 봉 패턴 썸네일은 5.25rem→4.5rem→4rem으로 줄이고 높이는 유지한다. 이름은 최소 6글자 폭을 보호하고 숫자는 오른쪽 정렬·줄바꿈 없이 전체 표시한다. 섹터의 목록/상세 전환·봉 패턴의 분포/수익률·알림의 반복 횟수와 두 줄 구조를 유지한다. 주요 지수는 기존 38.75rem 헤더 전환을 유지하고 26.25rem 이하에서 지수마다 이름·값·등락률 한 줄로 공통 열을 공유한다. 지수 차트의 오른쪽 축은 실제 눈금 폰트 폭을 측정해 긴 등락률과 확대 글자에서도 끝까지 표시한다. 매물대는 가격축의 고정 48px 대신 전체 가격 범위와 모든 구간 중간값의 실제 폰트 내재 폭을 예약하여 최대 거래량 구간이 바뀌어도 기준선이 움직이지 않게 한다. 가격축과 시간축은 같은 그리드를 공유하며 창 폭 30rem/20rem에서 좌우 여백을 0.75rem→0.5rem→0.25rem으로 압축한다. 모든 숫자는 생략·축약하지 않고 내재 최소 폭 이하에서만 해당 목록/요약 영역을 가로 스크롤한다.

- 2026-10-19 사용자 승인(균등 폭 배치에 대한 후속 변경): 일별 투자자는 **날짜당 한 줄·기존 글자 크기**를 유지하면서 실제 표기 자릿수로 열 폭을 배분한다. 모두 보기의 순매수·매수·매도를 각각 표 열로 분리해 날짜·누적의 기준선을 공유하며, 표시 순서는 공통 범례에서 한 번 설명한다. 창 본문 너비 40rem 이상은 날짜 4.5rem·숫자 좌우 여백 0.25rem, 30~40rem은 날짜 3.5rem·여백 0.0625rem, 30rem 미만은 날짜 3rem·여백 0.0625rem을 사용한다. 그룹 시작 여백은 0.125rem을 추가하되 30rem 미만에서는 생략한다. 순매수의 방향색·굵기와 날짜·헤더 고정은 유지한다. 긴 숫자는 줄바꿈·생략 없이 표의 내재 최소 폭까지 보호하며 그 이하에서 가로 스크롤한다.

- 2026-10-21 사용자 후속 요청: 일별 투자자의 금액도 수량처럼 숫자 전체의 오른쪽 끝을 맞춘다. 기존 금액 소수점 정렬 규칙을 대체하며 정수 뒤의 빈 소수 자리 예약을 제거한다. 모두 보기·단일 매매 기준·기관 상세와 누적 행에 동일하게 적용하고 기존 금액 단위·소수 자릿수·반올림·색상은 유지한다.

- 2026-10-19 사용자 승인(반응형 간격 후속 변경): 잠정투자자 표도 차수당 한 줄·기존 글자 크기와 숫자 오른쪽 정렬을 유지하면서 실제 표기 자릿수로 열 폭을 배분한다. 카드 너비 40rem 이상은 차수·시각 5.5rem·숫자 좌우 여백 0.5rem, 30~40rem은 5rem·0.25rem, 30rem 미만은 4.5rem·0.0625rem을 사용한다. 합산 왼쪽 추가 여백은 각각 0.5rem→0.25rem→0.125rem, 양 끝 여백은 0.625rem→0.375rem으로 줄인다. 합산의 500 굵기, 방향색, 원수량·금액 표기와 고정 헤더를 유지한다. 단위별 실제 표기에 맞춰 열 폭을 다시 배분하고, 줄바꿈·축약·생략 없이 내재 최소 폭 이하에서만 가로 스크롤한다.

- 2026-10-21 사용자 후속 요청: 잠정투자자 금액도 수량처럼 외국인·기관·합산 각 열의 숫자 전체 오른쪽 끝을 맞춘다. 기존 직접 텍스트의 오른쪽 정렬을 유지하고 소수 자리 예약을 추가하지 않는다. 정수·소수·0·값 없음(-)과 단위 전환·창 너비 변경에서도 같은 기준을 적용한다.

- 2026-10-19 사용자 승인: 프로그램 일별 표도 날짜당 한 줄을 유지하고 날짜·순매수·총매수·총매도를 독립 열로 배치한다. 날짜 폭은 40rem 이상 4.5rem, 30~40rem 3.5rem, 30rem 미만 3rem이며 숫자 좌우 여백은 0.25rem→0.0625rem으로 줄인다. 반복 점 구분자는 제거하고 실제 자릿수로 폭을 배분해 누적 행까지 숫자 오른쪽 끝을 맞춘다. 날짜·헤더·누적 고정, 순매수 강조와 기존 글자 크기·표기 단위는 유지한다. 당일 누적의 세 값도 한 줄을 유지하고 말줄임 없이 표시한다. 창 너비에 따라 본문 좌우 여백은 0.75rem→0.5rem→0.375rem, 값 사이 여백은 0.5rem→0.25rem→0.0625rem으로 줄이며 내재 최소 폭 이하에서는 숫자 요약 영역만 가로 스크롤한다.

- 2026-10-21 사용자 후속 요청: 일별 프로그램의 금액도 일별 투자자·수량처럼 숫자 전체의 오른쪽 끝을 맞춘다. 모두 보기·순매수·총매수·총매도와 누적 행의 빈 소수 자리 예약을 제거하며 기존 금액 단위·소수 자릿수·반올림·색상은 유지한다.

- 2026-10-21 사용자 후속 요청: 프로그램 당일 누적의 순매수·총매수·총매도도 금액·수량 모두 각 칸의 오른쪽 끝에 맞춘다. 항목 제목과 표시값의 오른쪽 기준선을 공유하며 기존 한 줄 배치·표기 단위·색상·글자 크기·반응형 간격과 긴 값의 요약 영역 가로 스크롤을 유지한다.

- 2026-10-19 사용자 승인: 거래원은 이름·궤적·순매수의 한 줄 구조를 유지하고 모든 행과 외국계 합계가 공통 열을 공유한다. 창 너비 40rem 이상/30~40rem/30rem 미만에서 열 간격은 0.5rem→0.25rem→0.125rem, 이름 폭은 4.875rem→4.625rem→4.5rem, 양 끝 여백은 0.625rem→0.375rem으로 줄인다. 궤적은 최소 4rem을 보호하고 숫자 열은 로드한 관측 전체와 같은 시각의 외국계 합계 극값을 실제 데이터 폰트로 측정한 내재 폭을 사용해 커서 이동으로 흔들리지 않는다. 숫자·이름·외국계 배지는 생략 없이 표시하고 최소 폭 이하에서만 가로 스크롤한다. 기존 글자 크기·방향색·규모 막대·행 순서·공통 시간축·합계의 하단 고정을 유지한다.

- 2026-10-19 사용자 승인: 체결 창은 시각·체결가·체결량의 한 줄 구조와 전체 시각(초 포함)을 유지한다. 헤더와 모든 행이 공통 열을 공유하며 창 너비 40rem 이상/30~40rem/30rem 미만에서 시각 폭은 4rem→3.5rem→3.25rem, 열 간격은 0.5rem→0.25rem→0.125rem, 양 끝 여백은 0.625rem→0.375rem으로 줄인다. 가격·수량은 실제 데이터 폰트의 내재 폭을 수용하고 같은 종목·거래소·날짜에서 관측한 최대 자릿수 폭을 유지해 표시 버퍼 이탈이나 빈 필터로 열이 줄어들지 않는다. 강조 배경은 수량 셀 안에 유지하고 헤더와 같은 안쪽 여백을 사용해 오른쪽 기준선을 맞춘다. 기존 글자 크기·가격/체결 방향색·강조 설정·최신순·과거 스크롤은 유지하고 숫자·시각을 생략하지 않으며 최소 폭 이하에서만 가로 스크롤한다.

- 2026-10-19 사용자 승인: 프로그램 체결 창도 일반 체결과 같은 공통 열·반응형 간격을 사용한다. 시간·현재가·순매수 증감의 한 줄 구조를 유지하고 시간 폭은 4rem→3.5rem→3.25rem, 열 간격은 0.5rem→0.25rem→0.125rem, 바깥 여백은 0.625rem→0.375rem으로 조절한다(40/30rem 경계). 증감은 +·− 부호의 실제 폭까지 확보하고 같은 종목·거래소·날짜에서 관측한 최대 가격·증감 자릿수 폭을 유지해 큰 값의 버퍼 이탈이나 빈 데이터로 열이 줄어들지 않는다. 초 단위 시간·전체 숫자·기존 글자 크기·헤더 고정·방향색·누락 현재가의 — 표기·최신순·과거 조회는 유지하며 최소 폭 이하에서만 가로 스크롤한다.

- 2026-10-19 사용자 미리보기 승인: 10호가의 중앙 가격축·좌우 대칭·22px 행 높이·매도/매수 각 10행을 유지하면서 주변 여백을 압축한다. 본문 531px 이상/400~530px/400px 미만에서 잔량 셀 좌우 여백은 0.5rem→0.25rem→0.125rem, 잔량·증감 간격은 0.375rem→0.25rem→0.125rem, 요약 라벨·값 간격은 0.75rem→0.375rem→0.25rem이다. 좁은 창의 좌우 최소 폭은 고정 112px 대신 실제 글꼴로 측정한 잔량·양/음 증감·최근 체결 가격/수량·체결강도의 공통 폭을 사용한다. 같은 종목에서 관측한 자릿수 폭은 유지하고 종목 변경 시 초기화하며, 증감은 기본 네 자릿수와 부호를 예약해 순간 배지가 없어져도 폭이 줄지 않는다. 최근 체결 9건은 공통 가격 폭과 오른쪽 정렬을 사용하고 수량·증감 말줄임은 제거한다. 넓은 창의 좌우 184px 하한과 531px에서 요약을 정보 팝오버로 옮기는 동작은 유지한다. 중앙의 아이콘–가격 4px·가격–등락률 2px·양쪽 최소 8px 및 글자 크기는 유지하며 내재 최소 폭 이하에서 가로 스크롤한다. 상세 팝오버의 요약은 4px 여백·간격으로 표시하고 주문창의 배치는 유지한다.

- 2026-10-19 사용자 승인: 호가 주문창도 중앙 가격·평단가·좌우 대칭 5열·24px 행·매도/매수 각 10행과 기존 주문 조작을 유지하며 간격을 반응형으로 압축한다. 본문 696px 이상/560~695px/560px 미만에서 잔량 좌우 여백·증감 간격은 6→4→2px, 상세 요약의 라벨·값 간격은 12→6→4px로 줄이고 시작 여백은 잔량과 맞춘다. 좁은 배치의 504px 고정 하한을 실제 글꼴로 측정한 잔량·양음 증감·체결 가격/수량·체결강도 폭으로 대체한다. 좌우 주문 열은 넓을 때 최소 72px, 그 외 최소 48px를 확보하고 주문 수량·처리 중 문구·방향별 합계와 건수가 길면 양쪽을 같이 늘린다. 같은 계좌·종목의 관측 자릿수 폭을 유지하고 계좌·종목 변경 시 초기화한다. 체결 가격·수량은 공통 열에서 각각 오른쪽 정렬하고 주문 수량·합계·증감을 생략하지 않는다. 공간이 부족하면 사다리 영역만 가로 스크롤하며 상세 통계의 560px 정보 팝오버 전환은 유지한다. 상단의 기존 보유 숫자 고정 칸은 유지하고 예상금액은 오른쪽 정렬한다.

- 2026-10-19 사용자 승인: 미체결 주문 목록은 종목·구분·가격·잔여·취소의 5열과 기존 글자 크기·방향색·종목 선택·취소 동작을 유지한다. 가격·잔여는 계좌의 필터 적용 전 전체 목록의 실제 표기(쉼표·소수 포함)를 데이터 글꼴로 측정해 헤더와 오른쪽 끝을 맞추고, 같은 계좌에서 관측한 폭은 주문 제거·빈 목록·방향 필터 전환에도 유지한다. 계좌 변경 시 다시 계산한다. 구분은 매수·매도의 공통 폭에서 가운데 정렬하고, 취소는 취소 중·확인 중·재확인 문구의 최대 폭을 예약한다. 종목 열은 최소 6em을 보호하고 남는 폭을 우선 배분하며 기존 긴 이름·오류의 줄바꿈을 유지한다. 패널 본문 폭 480px 이상/400~479px/400px 미만에서 숫자 좌우 여백은 4→2→1px, 본문 양 끝 여백은 10→6→4px로 줄인다. 숫자는 생략·줄바꿈 없이 표시하고 내재 최소 폭 이하에서 목록만 가로 스크롤한다. 보유종목 표의 배치는 유지한다.

- 2026-10-19 사용자 승인: 보유종목 목록도 좁은 창에서 카드로 바꾸지 않고 종목·수량·평단·평가금액·손익 5열을 유지한다. 실제 데이터 글꼴로 표시 자릿수를 측정하고 숫자·헤더의 오른쪽 끝을 맞춘다. 손익은 금액(11px)과 수익률(10px)의 두 줄을 유지하며 부호·원·%를 포함한 두 값 중 긴 쪽으로 열 폭을 확보한다. 수량·평단·평가금액·손익의 관측 표기 폭은 같은 계좌에서 시세 갱신·종목 제거·빈 목록·목록 전환·닫기/재열기에도 유지하고 계좌 변경 시 초기화한다. 숫자 부호 전환 공간도 예약한다. 종목에는 최소 6em과 남는 폭을 배분한다. 패널 본문 폭 480px 이상/400~479px/400px 미만에서 셀 좌우 여백은 4→2→1px, 본문 양 끝 여백은 10→6→4px이다. 기존 글자 크기·손익 방향색·평가 계산·시세 구독 범위·종목 선택을 유지하며 숫자는 생략·줄바꿈하지 않고 내재 최소 폭 이하에서는 목록만 가로 스크롤한다.

- **Base unit:** 4px (base intent = rendered, since the dial is 1.0× as of 2026-08-07; was 4.5px rendered at 1.125×)
- **Density:** Bloomberg-leaning — the dial sits at base intent (1.0×). Density is a spectrum, not a fixed point: the token system holds the whole ladder and the dial picks a rung. Looser rungs (1.125×, 1.25×) have both shipped as defaults before.
- **Scale (rem-based, single dial):**

<!-- BEGIN AUTO: tokens-spacing -->
| Token | Base intent (1.0×) | Rendered @ default (1×) | Use |
|---|---|---|---|
| `2xs` | 2px | 2px | Hairline gaps |
| `xs` | 4px | 4px | Pane gap, tight stacking |
| `tooltip-x` | 10px | 10px | Soft compact tooltip inline padding |
| `tooltip-y` | 6px | 6px | Soft compact tooltip block padding |
| `sm` | 8px | 8px | Card padding inside, gap between sidebar cards |
| `md` | 12px | 12px | Card padding default |
| `lg` | 16px | 16px | Section spacing, nav item padding |
| `xl` | 24px | 24px | Major section dividers |
| `2xl` | 32px | 32px | (rarely used) |
| `3xl` | 48px | 48px | (rarely used) |
<!-- END AUTO: tokens-spacing -->

- **Card padding:** 12–14px standard. Sidebar cards 12px. Pane bodies 4–6px (info density priority) (base intent — equals rendered at the current 1.0× dial).
- **Pane gap:** 8px between chart panes (base intent — equals rendered at the current 1.0× dial).
- **Sidebar width:** 320px base intent = 320px rendered (token: `--sidebar-w`). 유일한 소비처는 `/inventory` 의 master-detail 좌열(`pages/Inventory.tsx`) — 이름과 달리 사이드바 컴포넌트의 폭이 아니다. *(2026-07-29: `usage` 문자열이 가리키던 "replay viewer 의 Cursor Sidebar" 는 실재하지 않아 실제 소비처로 고쳤다.)*
- **Top nav height:** 32px base intent = 32px rendered (token: --h-top-nav).

## Layout

- **Approach:** Grid-disciplined hybrid — strict grid for the app shell, looser composition inside chart panes.
- **App shell:**
  - Top-level: **column** shell (2026-07-15) — `grid-template-columns: 1fr var(--rail-w)` plus an optional `var(--watchlist-panel-w)` before the rail when a right-rail panel is open. The **right panel (drawer + fixed rail) spans full viewport height** (top to bottom). The left column is a 3-row stack `grid-template-rows: var(--h-top-nav) minmax(0, 1fr) auto` (TopNav / page content / bottom market-index bar; bottom row `auto` collapses to 0 when the bar has no data). The top header therefore spans only the left column's width — it **yields the top-right corner to the full-height right panel**. The explicit row contract keeps content from growing the row (or the `/live` chart) past the viewport. TopNav itself is borderless `--bg` (see below) so the header merges into the page content. **앱 셸에는 이제 크롬 톤이 없다** — 우측 패널(레일 + 드로어 + sticky 그룹헤더)도 2026-07-29 (#911) 에 `--bg-subtle` → `--bg` 로 넘어가 셸 전체가 단일 `--bg` 면이다(`ui/RailShell.tsx` = `bg-bg`). `--bg-subtle` 는 셸 밖 recessed 표면에만 남는다: 모달 내부 박스(`CollectDialog`·`StudyViewSaveDialog`), 스크리너 조건 카드, 설정/지표 nav, 워크스페이스 창 헤더의 비포커스 톤 밴드, sticky 표 헤더(체결 열 헤더 — 거래원 합계행·잠정투자자 열 헤더는 2026-07-30 에 `--bg-card` 로 환원). *(이전 문장: "chrome tone (`--bg-subtle`) survives only on the right panel" — 2026-07-29 정정.)*
  - Main (page-content row): each route owns its own grid. **`/live`** (`frontend/src/live/LivePage.tsx`) is a **3-row** grid — `grid-template-rows: auto auto minmax(0, 1fr)` = `LiveStateBanner` (빈/에러 상태 매트릭스; 상태가 없으면 빈 `div` 로 접힌다 — `null` 을 반환하면 캔버스가 툴바 자리로 밀려 올라간다) / `WorkspaceLiveToolbar` (`--h-toolbar`) / `WorkspaceCanvas` (`1fr`). 열 축도 `minmax(0, 1fr)` 로 **명시해야 한다** — 비워두면 `grid-auto-columns: auto` 가 되고 그 트랙이 차트 캔버스의 min-content 폭에서 바닥을 쳐 `<main overflow-hidden>` 에 잘린다. 나머지 feature 라우트는 workarea 한 행뿐. (`/study` 가 2행 그리드를 갖던 항목은 ADR-0157 로 그 라우트와 함께 사라졌다.) *(History: 이 줄은 `grid-template-rows: 40px 60px 52px 1fr` (tabs + toolbar + price strip + workarea) 로 Replay Viewer 를 기술했다 — `/replay` 라우트·페이지·`state/replayLayout.ts` 는 모두 존재하지 않는다(`main.tsx` 의 라우트는 live·study·heatmap·inventory·screener·capture·settings 7개). 2026-07-29 정정.)*
- **Workspace canvas (`/live`):** 고정 grid 가 아니라 **자유 배치 창 캔버스**(ADR-0119, #706) — 창마다 프랙셔널 rect 를 갖고 자석 스냅 엔진이 배치한다. 창 사이 **2px 틈은 좌표가 아니라 렌더 인셋**이다(`frontend/src/workspace/WindowFrame.tsx` `GAP = 2`; 보이는 카드가 바깥 rect 에서 `GAP/2` 물러나 그려진다) — 스냅 좌표계는 틈에 영향받지 않으므로 간격을 바꿔도 스냅 불변식은 그대로다. *(History: 여기엔 Replay Viewer workarea `grid-template-columns: 1fr 12px <sidebarPx>` (chart + splitter + Cursor Sidebar) 와 `localStorage['replay.layout']` 기술이 있었다 — `state/replayLayout.ts` 와 `sidebar/CursorSidebar.tsx` 는 둘 다 이제 존재하지 않는다(전자는 이전에, 후자는 #916 에서 삭제). ADR-0022 의 트레이드오프는 역사로만 유효. 2026-07-29 정정.)*
- **Chart pane stack (`/live` 차트 창):** CSS grid 가 아니라 **lightweight-charts pane** 을 `setStretchFactor(spec.stretch)` 로 배분한다. 순서와 기본 stretch 는 `frontend/src/chart/paneSpecs.ts` 가 SSOT — candle 1.4 / volume 0.3 / quote-totals 0.4 / ratio 0.4 / fill-strength 0.4 / program-trade 0.35, 그리고 D 전용 투자자 pane 2개(각 0.3). 사용자 조정값(Pane Stretch, #703)이 스펙 기본값을 덮고, 높이가 모자라면 `usePaneFolding` 이 하위 pane 부터 접는다. 어떤 pane 이 뜨는지는 `paneSpecsForTimeframe.ts` 의 게이트(분봉 전용 호가 pane, D 전용 투자자 pane)가 정한다. *(History: `grid-template-rows: 1fr 0.5fr 1fr 0.6fr` (candles+vol / ratio / intensity / fill) — Replay Viewer 4-pane 시절. 2026-07-29 정정.)*
- **Max content width:** No cap. App fills the viewport (desktop-only).
- **Responsive floor (`--app-floor-min-w`, 2026-07-21):** the app has **one floor for every route**: `59rem` (944px @ the current 1.0× dial; was `57rem`/912px until 2026-08-21, and 1026px at 1.125×). **The floor is rem-based, so it moved with the 2026-08-07 dial change** — the shell now compresses ~114px further before it stops. That is the intended coupling (a denser shell needs less width), not a regression. Above it the shell compresses fluidly; below it the shell stops compressing and `#root` scrolls horizontally (`global.css`). There is **no zoom-detection code anywhere** — browser zoom *is* effective-viewport narrowing, so the width response covers zoom for free (`visualViewport.scale` branching is prohibited: it double-counts window resize vs zoom and doubles the test matrix).
  - **Why a single global value:** the floor is set by the **shell chrome every route shares**, not by page content. Content-light routes (`/settings`, `/capture`) would reflow narrower, but the chrome breaks first, so per-page floors add complexity with no gain. `App.tsx` wraps every route via `<Outlet/>`, so one declaration reaches all pages and a new route can't forget it.
    - 유도 실측(2026-07-21, **당시 밀도 1.125×**): TopNav 자연폭 939px + `--rail-w` 54px = **993px**, 토큰이 33px 여유를 더해 1026px. 이 993px 은 두 번 stale 이 됐다 — ① 2026-08-04 nav 한글화로 같은 절차 재측정 시 자연폭 **710px**(−229px)·필요폭 **764px**(`Screener` 8자 → `스크리너` 4자), ② **2026-08-07 다이얼 1.125×→1.0× 로 위 수치가 전부 옛 밀도 기준이 됐다**(크롬이 rem 기반이라 대략 ×0.889 이지만, 폰트 폭은 선형이 아니므로 추정치를 적지 않는다 — 필요하면 재측정할 것). **토큰은 그대로 57rem 을 유지한다**: 바닥은 nav 하나가 아니라 전 라우트가 공유하는 셸 크롬이 정하는데, nav 가 더 이상 병목이 아니게 됐을 뿐 *다음* 병목이 무엇인지는 측정된 바 없다. 내리려면 그 병목부터 실측할 것 — 지금 내리면 근거 없이 다른 크롬을 압축하게 된다. ③ **2026-08-21 에 nav 가 다시 병목이 됐다** — 상단바 정중앙 시계(`ClockLabel`, 138px `shrink-0`)가 들어오면서 nav 자연폭이 그만큼 늘었다. 실측(1.0×, `/browse`, 캡처 진행 중 `수집 3 · 대기 12` 상태 주입): **920px 에서 우측 클러스터가 nav 오른쪽으로 10px 넘치고 930px 에서 0**. 즉 필요 뷰포트폭 ~930px > 옛 바닥 912px 이라 **바닥에서 상태 텍스트가 레일 위로 밀려 나갔다**. 토큰을 `59rem`(944px)으로 올려 14px 여유를 둔다 — 위 규칙("내리려면 병목부터 실측")의 대우로, **올릴 때도 병목을 실측하고 올린다**. 캡처가 안 도는 평시 자연폭은 866px 이라 이 인상은 **캡처 진행 중 최악값**을 기준으로 한 것이다.
  - **Why rem, not px:** everything the floor protects (nav, rail, panel widths) is rem-based, so the floor must track the density dial — at a future Cozy 1.25× the chrome needs proportionally more room. This is why the floor is *not* on the fixed-px list (hairlines, small radii, and tracks whose content is itself fixed-px — see the dial-scope list above).
  - **시장 종합 예외 (2026-09-09 사용자 승인):** `/market`은 컨테이너 폭에 따라 카드 열을 재배치하므로 셸 가로 바닥을 해제한다. TopNav는 기존 최소 자연폭을 내부 가로 스크롤로 보존한다. 다른 페이지의 59rem 바닥과 세로 바닥은 유지한다. 시장 종합 버튼은 글자 밀도를 유지하면서 최소 1.5rem 클릭 높이를 사용한다.
  - **Why the scroll owner is `#root`:** if the document scrolls, the shell's `100vh` and the horizontal scrollbar trigger each other (scrollbar begets scrollbar). The shell is `h-full min-w-app-floor`, never `w-screen` — `100vw` includes the vertical scrollbar width, which would make the shell wider than the viewport at every width below the floor. Guarded by `App.test.tsx`.
  - **세로 바닥 (`--app-floor-min-h`, ADR-0122):** 폭과 **대칭**으로 `39rem` (624px @ 현재 1.0× 다이얼; 1.125× 시절엔 702px). `/live` 창은 캔버스 비율로 스케일하므로 캔버스가 계속 낮아지면 호가 단수가 조용히 잘린다 — 바닥 아래에서는 높이도 동결하고 `#root` 가 세로 스크롤을 갖는다. 줌인은 양축을 함께 줄이므로 가로 바닥만으로는 반쪽이다(실측: 줌 200% 에서 폭은 여유였고 **높이가 먼저** 하한에 부딪혔다). 셸은 `min-h-app-floor min-w-app-floor` 를 함께 건다(`App.tsx`).
  - **Re-deriving the floor:** measure the chrome, don't guess. `document.querySelector('nav').firstElementChild` → set `width:max-content` → read `getBoundingClientRect().width`, add the rail. Bump the token when the nav gains items. **라벨 텍스트가 바뀔 때도 재측정 대상이다** — 항목 수가 그대로여도 폭은 움직인다(2026-08-04 한글화가 그 사례).
- Dense tool panels use one outer surface with internal dividers; avoid nested cards inside sidebars, drawers, modals, and detail panels. (Exception: `/live` 상세 지표 카드는 승인된 예외 — Migration Status 참조.)
- **Border radius:** 고정 px **폐쇄 5단**(ADR-0011 — 다이얼을 따라가지 않는다).
  `tailwind.config.ts` 가 `theme.borderRadius` 로 Tailwind 스케일을 **교체**하므로
  이 5단이 전부다 — `rounded-xl`/`2xl`/`3xl` 은 도달 불가이고, 새 단이 필요하면
  임의값(`rounded-[7px]`)이 아니라 `design-tokens.ts` 에 토큰을 추가한다.
  - `none` 0px (explicit square corners — `rounded-none` 과 코너별 변형)
  - `sm` 2px (hairline bars, dense badges)
  - `md` 4px — **bare `rounded` 가 여기로 온다** (chips, small buttons, presets)
  - `lg` 6px (cards, modals, inputs, dropdowns, larger panels)
  - `full` 50% (status dots, avatars)
  - **`DEFAULT` 키를 비워 두지 말 것.** `borderRadius` 맵에 `DEFAULT` 가 없으면
    Tailwind 가 자기 기본값(`0.25rem`)으로 채우고, 그건 **rem 기반**이라 밀도
    다이얼을 따라 움직인다 — ADR-0011 이 막으려던 바로 그 현상이다. 어느 단이
    bare 유틸을 갖는지는 `design-tokens.ts` 의 `isDefault` 플래그가 소유하고,
    생성기가 "정확히 하나" 를 강제한다. 지도의 구멍은 중립적 누락이 아니다 —
    프레임워크가 채운다.
  - **`radius-none` 을 지우지 말 것.** 스케일을 교체했으므로 스케일에 없는 키는
    에러가 아니라 **CSS 미생성**이다. `none` 이 빠지면 `rounded-none`·
    `rounded-r-none` 이 조용히 사라지고, `BookPanel` 의 한쪽만 둥근 잔량 바가
    양쪽 다 둥글어진다(무경고 시각 버그).

### Page shell (feature routes)

Every feature route except the chart workspace follows one shell:

- **Outer padding:** wrap the route in `<PageContainer>` (`frontend/src/layout/PageContainer.tsx`) — the single source of the page padding token (`p-md`). Never hardcode `p-4`/`p-8` at the page root.
- **Content framing:** primary content sits in `bg-bg-card` cards (`PanelCard`). Multi-pane pages (master-detail) use one card per pane; single-content pages use one card. Never nest cards. **레이아웃 열을 나누는 드래그 스플리터는 없다 (2026-08-07):** 마지막 소비처였던 `/capture` 가 열 트랙 고정으로 바뀌면서 `VerticalSplitter` 를 삭제했다. *(범위 주의: lightweight-charts 의 **chart pane separator** — 가격 pane ↔ 거래량/지표 pane 가로 경계 — 는 드래그 리사이즈 기능을 가진 채 **그대로 살아 있다**. 아래 "구분선 최소화" 항목의 유지하는 선 참조.)* — 판정 기준은 "리사이저로 **양쪽이** 얻는 게 있는가"이고, 폼 pane 은 달력이 `repeat(7,2rem)` 고정 트랙이라 최적폭이 하나뿐이었다(광폭에서 폼이 150px 를 빈 여백으로 들고 있었다). 같은 판정을 새 pane 에도 적용할 것: 한쪽 콘텐츠가 고정 트랙이면 리사이저 대신 `minmax()` 로 두 pane 의 하한·상한을 적는다(`frontend/src/pages/Capture.tsx` 의 주석에 실측 유도 과정이 있다). 창 크기 조정이 필요한 곳은 워크스페이스 창(`WindowFrame` 가장자리 핸들)뿐이다. **Feature-route cards are `borderless` in both themes (2026-07-15, 통일 결정):** `/heatmap`·`/screener`·`/inventory`·`/capture` 카드는 `PanelCard borderless` 로 테두리 없이 `--bg-card` + `--shadow-panel` 만으로 배경과 분리 — `/live` 차트 패널과 동일 크롬(부유 카드 모델을 feature route 전반으로 확장). 내부 헤더/스트립 밴드도 `bg-subtle`→`bg-card`, 구분선 `border-strong`→`border` 로 평탄화(live `WorkspaceToolbar` = `bg-card` + `border-b border-border` 와 동형). **Ledger(라이트) tradeoff:** 라이트는 `--bg`=`--bg-card` + 옅은 shadow 라 카드 경계가 다크보다 약하게 읽힌다 — 이전엔 이 때문에 Ledger feature 카드의 `--border` 를 유지했으나, `/live`·`/study` 워크스페이스와의 전면 통일을 위해 **사용자 결정으로 borderless 채택**(라이트에서도 shadow+gap 의존). `--border` 는 이제 카드 프레임이 아니라 카드 **내부** 구분선(`border-b`/`border-t border-border`)·입력·테이블 등에만 쓴다.
- **Live workspace 창 경계 (2026-09-09, 사용자 승인):** 모든 `/live` 창은 필드 배경(`bg-bg`)과 둥근 모서리를 유지하고 **1px 중성 외곽선 + 짧은 그림자**로 겹친 창을 구분한다. 모든 창의 선은 포커스와 무관하게 `--window-border`(`--border-strong`)로 동일하다. 활성 창은 기존 헤더 틴트로만 표시한다. 최초 적용한 활성 외곽선 강조색은 사용자 피드백에 따라 제거했다. 안착 그림자 `--window-shadow`는 다크 `0 2px 8px rgba(0,0,0,.28)`, 라이트 `0 2px 8px rgba(30,39,50,.12)`이며 이동 중에는 `--shadow-modal`로 교체한다. 외곽선은 카드 내부의 포인터를 받지 않는 장식 레이어여서 창 rect·콘텐츠 크기·2px 간격·리사이즈 핸들은 그대로다. 그룹 색상은 배지에만 쓴다. 과거 borderless 정책에서는 겹친 창의 헤더가 가려질 때 경계를 읽기 어려워 이를 개정했다. **2026-08-09에 삭제한 2px 리사이즈 호버 accent 막대는 복원하지 않는다.** 공유 코어에서는 `outlined` opt-in으로 제공한다. `/study` 경로는 현재 `/live`로 리다이렉트된다.

- **구분선 최소화 — "톤 밴드" (2026-07-22, /live 프로토타입 4시안 비교로 C안 채택):** 크롬
  구분선은 그리지 않는다 — "분리는 톤+간격" 규칙을 창 내부 크롬까지 확장해 명도가 담당한다.
  적용: 워크스페이스 창 헤더 = 경계선 없는 톤 밴드(비포커스 `--bg-subtle` / 포커스
  `--tint-selection`), 차트 창 툴바 밑줄·RightRail `border-l`·RailShell(드로어 좌측선·헤더/
  섹션 밑줄·트리 행 밑줄)·관심종목 행 밑줄 제거, sticky 표 헤더(체결 열 헤더)는
  `border` 대신 `--bg-subtle` 밴드 — **단 거래원 "외국계 합계" 행과 잠정투자자 열 헤더는
  예외로 창 본문과 같은 `--bg-card`**(2026-07-30 사용자 결정, 아래 결정로그),
  lightweight-charts 시간/가격 축 `borderVisible: false`
  (눈금·라벨은 유지). 10호가 내부 격자(매도↔매수 경계·총잔량 스트립)는 유지하되
  `--border-strong` → `--border` 한 단계 완화 — 호가 격자는 잔향만 남긴다. **유지하는 선:**
  기능적 테두리(입력·팝오버·드롭다운·현재가 강조 박스·활성 스파인 `border-l-2`)와 chart pane
  separator(드래그 리사이즈 기능 보유 — **lightweight-charts 의 가로 pane 경계**다.
  가격 pane ↔ 거래량/지표 pane 을 나누고 `panes.separatorColor`/`separatorHoverColor` 로
  칠한다: `LiveChartRoot.tsx`. 2026-08-07 에 삭제된 `VerticalSplitter` 와는 **다른 것**이니
  같이 지우지 말 것). 창 이음매(2px gap+그림자)는 카드 모델의 일부로 존치 —
  이음매 병합(플레이트) 시안은 기각. `--border` 는 이제 데이터 격자·입력·팝오버 전용이다.
  1차 사료: `prototype/live-divider-variants` 브랜치(4시안 스위처).
  - **나머지 라우트 확장 (2026-07-22 후속):** 같은 규칙을 feature 라우트 전반에 적용 —
    /screener 결과 패널 툴바 밑줄·"결과" `DataSection` 헤더 밑줄(`flushHeader`) 제거,
    /inventory 상세 패널 헤더 밑줄 제거·좌측 sticky 검색 밴드 `bg-bg-card`+`border-b` →
    `bg-bg-subtle` 밴드, /heatmap 폴더 헤더 `border-b border-border-strong` 제거(틴트 밴드+
    좌측 `border-l-2` 스파인이 그룹 분리)·섹터 온도 스트립 밑줄 제거, /study 메모 패널 섹션
    밑줄 제거, /capture 큐 스크롤 컨테이너 외곽 `border` 링 제거(중첩 카드 회피). **유지:**
    데이터 표 내부 격자(inventory 캡처 표·capture 큐 행·heatmap 종목 행·`DataTable*` — 전부
    이미 `--border`)와 모달 푸터·레일 드로어(RailShell 반영 완료). /study 활성 워크스페이스는
    공유 `WindowFrameCore`+공유 데이터 창 재사용으로 /live 작업에 이미 포함.
- **No redundant page title:** the active top menu item is the page label, so a page never repeats its own name. Pages expose a *title-less* control bar (search / counts / actions) at the top of their card. (See the `/live` header: search only, with the active symbol shown in the status bar below.)
- **Full-bleed exception:** only the chart workspace (`/live`) is full-bleed (no `PageContainer`, no card) — the chart must fill the viewport. Its sidebar still uses `--bg-card` to match other panels.

### Migration Status

Quiet Trading Terminal migration completed across app shell, route surfaces, rail drawers, live dialogs, and dense data panels. Nested-card chrome is prohibited in sidebars, drawers, modals, and detail panels; use `DataSection` dividers inside a single outer surface. **Exception — `/live`·`/study` 상세 지표 카드 (2026-07-15, 사용자 요청):** 각 지표(10호가·거래원·매물대·프로그램·잠정투자자)는 이제 개별 **독립 카드**로 렌더한다. **카드 크롬**은 `/study` 가 이미 쓰던 `PanelCard` 와 동일하다(`bg-bg-card` + `border` + `rounded-lg` + `shadow-panel`) — 이 부분만 두 화면이 일치. **aside 배경 톤은 아직 다르다**: `/live` 는 솔리드 `bg-bg-subtle`, `/study` 는 `bg-bg-subtle/40`(향후 통일 여지). 드래그 재배열(ADR-0114)의 이동 단위가 카드로 명확해지도록 "플랫 섹션"(단일 표면+DataSection 구분선)을 카드화한 것. 카드 사이는 8px 여백. 드래그 시 잡은 카드는 `DragOverlay` 고정 크기 클론으로 뜨고 원래 슬롯은 opacity 0 placeholder(가변 높이 reflow 흔들림 제거), 놓을 위치엔 `bg-accent` 삽입선. 접기·높이 리사이저는 제거(2026-07-15, 카드는 내용 높이). **카드별 스크롤 컨테이너(`overflow-auto/scroll`)는 여전히 금지** — 스크롤은 패널 레벨(`overflow-hidden` clip 자체는 허용, 다만 현재는 붙이지 않음).

## Motion

- **Approach:** Minimal-functional. Only motion that aids comprehension.
- **Easing:**
  - Enter: `ease-out`
  - Exit: `ease-in`
  - State transitions (hover, focus, active): `ease-in-out`
- **Duration:**
  - Micro (hover, focus ring): 80ms
  - Short (most transitions: tab switch, dropdown open, chip toggle): 150ms
  - Medium (page nav, modal): 250ms
  - Long (entrance animation if needed): 400ms — rare
- **Animated elements:**
  - Tab loading status dot: 1.5s ease-in-out infinite pulse (opacity 1↔0.3)
  - Cursor indicator dot: subtle teal glow, no animation
  - Crosshair on chart: instant move (no transition), 30ms debounce on data fetch
- **What we do NOT animate:** chart pane resizes, sidebar updates, value changes (numbers snap, no tween — analysts want exact values not gradients).

## Components — Design Tokens for Specific Patterns

### 스크리너 조건 편집 (2026-10-19 사용자 승인)

`/screener`의 16개 조건에 공통 편집 구조를 적용한다. 조건명·범위 배지·접기 버튼을
헤더에 두고, 펼친 영역은 봉 주기 선택 → 라벨/숫자/단위를 분리한 입력으로
구성한다. 같은 날 사용자 후속 요청에 따라 조건별 안내 문단과 펼침·접힘 상태의 요약
문장을 제거한다. 처음에는 펼쳐 두며, 접어도 조건은 활성 상태이고 파라미터를 보존한다.
접힌 행에는 조건명과 범위 배지를 표시하고 드래그 핸들·제거 버튼은
접힘과 독립적으로 유지한다. 접힘 상태는 검색·저장 모델에 추가하지 않는다.

분·일·주·월, 최근 N봉/날짜 범위, 비교 연산은 짧은 버튼 선택기로 표시한다.
기간내 조건은 발생 검색 범위와 신고/peak 비교 기간을 서로 다른 라벨로 구분한다.
숫자 입력은 `base`·500·데이터 글꼴, 조건명과 선택기는 `sm`, 필드 라벨·배지는
`xs`를 쓴다. 입력 배경·선택 틴트·중성 경계·4/6px 모서리는 기존 테마 토큰을 따른다.
사용자 후속 요청에 따라 숫자와 단위를 감싸는 바깥 영역에만 포커스를 표시한다.
2026-10-20 사용자 후속 요청: 모든 조건의 숫자 프리셋 빠른 입력과 「봉 주기」 표시
라벨을 제거한다. 봉 주기 선택 버튼과 직접 숫자 입력은 유지한다.
같은 날 후속 요청으로 최근 N봉/날짜 범위와 분·일·주·월 선택을 한 줄에 배치한다.
분봉 간격 선택은 그 아래에 둔다.
기존 23rem 빌더 폭, 16개 조건 타입, 기본값·범위·봉별 평가 방식은 유지한다.

2026-10-20 사용자 승인: 조건 헤더에 A·B·C(26개 이후 AA·AB…) 문자를 붙이고,
빌더의 「조건 조합」에서 AND/OR와 괄호로 자유롭게 결합한다. 조건 문자·연결어 버튼은
현재 커서에 입력하며, 모두 AND/모두 OR 빠른 입력을 제공한다. 괄호를
먼저 계산하고 AND가 OR보다 우선한다. 잘못된 식은 오류를 표시하고 조회·저장을 막는다.
조합식 미지정 저장본은 기존 전체 AND이며, 순서 변경 시 문자를 재매핑하고 삭제 시 해당
항만 제거한다. 추가 조건은 기존 식에 AND로 결합한다. 식에서 사용하지 않는 조건은
검색하지 않고 목록을 안내한다. 조합식은 저장·초안·드로어·재조회에 함께 전달한다.

2026-10-20 사용자 후속 승인: 개별 여는/닫는 괄호 버튼을 `() 묶기` 하나로 통합한다.
드래그 또는 키보드로 선택한 완전한 조합식을 괄호 한 쌍으로 감싸고 내부 선택을 유지한다.
선택이 없거나 토큰 일부·불완전한 식이면 묶기를 비활성화한다. 범위 선택 중에는 조합식의
문자/AND/OR 빠른 입력과 조건 행의 문자 버튼을 비활성화해 선택한 식을 보호한다.
직접 타이핑·붙여넣기와 명시적인 모두 AND/OR 변경은 유지한다. 조합식 안의 AND/OR를
더블클릭하면 해당 연결어만 전환한다. 커서가 괄호에 있거나 바로 뒤에 있으면 대응하는
괄호 쌍과 내부 범위를 기존 선택 틴트·강조색으로 표시한다. 묶기와 연결어 전환도
기존 실행 취소/다시 실행 이력을 공유한다.

같은 날 사용자 후속 요청: `() 묶기 해제` 버튼을 추가한다. 묶인 그룹 전체 또는 그
그룹의 내용 전체를 선택하면 해당 그룹의 바깥 괄호 한 쌍만 제거한다. 중첩된 내부
괄호와 나머지 식은 유지하며, 괄호 제거로 연결어와 조건 문자가 붙는 경우에만 공백을
넣는다. 부분 선택·여러 그룹 선택·선택 없음에는 해제를 비활성화한다. 제거 후 그룹의
내용을 선택한 상태로 유지하고 기존 실행 취소/다시 실행 이력을 공유한다.

조합식의 직접 입력·문자/연결어 버튼·전체 AND/OR 변경은 같은 실행 취소 이력을 쓴다.
Ctrl+Z(⌘Z)로 되돌리고 Ctrl+Shift+Z(⌘⇧Z) 또는 Ctrl+Y로 다시 실행한다.
커서와 선택 영역도 복원하며, 조건 추가·삭제·순서 변경이나 다른 저장 조건을 불러오면
조건 문자의 의미가 바뀌므로 조합식 이력을 초기화한다.

2026-10-20 사용자 요청: 오늘 장중/전일 확정 선택을 제거하고 페이지·드로어 모두
서버의 자동 기준으로 조회한다. 결과 메타에는 실제 적용 기준 날짜·시각(KST)을 표시한다.
아카이브 최신일이나 조회 완료 시각을 평가 기준으로 대신 표시하지 않는다. 시세 일부가
확정 데이터로 대체되면 실제 두 기준 시각을 범위로 표시한다. 빈 결과와 새로고침 후에도
서버 기준을 유지한다. 조회 모드 안내 문구와 별도의 일봉 기준일 표시는 제거한다.

> **Scale note:** All px values in this section are **1.0× base intent**.
> Default rendering = × 1.0 as of 2026-08-07, so these px values *are* what ships
> today. That equality is a property of the current dial, not a permanent fact —
> see [Scale Factor](#scale-factor) before copying any of them into code.

<!-- 여기 `### Tabs (/study — ChartTabBar)` 스펙이 있었다. 그 컴포넌트는 ADR-0149(저장뷰
     탭 제거)로 사라졌고 페이지 자체도 ADR-0157 로 폐지됐다 — 즉 이 문서는 **존재한 적
     없는 컴포넌트의 스펙을 한동안 들고 있었다**. 앱 안에 탭 스트립을 되살리지 않는다는
     판정은 ADR-0113·0149 에 있고, 지금 「탭」은 브라우저 탭만 뜻한다. -->

### Combobox (stock selector)
- Min width: 220px
- Border-radius: 6px
- Open state: teal border
- Dropdown shadow: `var(--shadow-overlay)`
- Search input inside dropdown: transparent background, mono font, no border

### Date field
- Same style as combobox but narrower
- Calendar icon left (14px, dim)
- `→` arrow between from/to fields (`--fg-dim`)

### Presets (range pill group)
- Container: `--bg-input` with 2px padding
- Each preset: 7px × 12px padding, mono small-caps text
- Active: teal background, dark text

### Primary CTA (Load button)
- Background: `--accent`
- Text: `--accent-fg` (`#07100f`, dark bg color)
- Padding: 9px × 18px
- Font: 13px / 600 weight Pretendard (`--font-ui`; Geist Sans 는 2026-07-08 에 이미 죽은 이름이다 — 2026-07-21 전환 이후 단일 패밀리)
- Hover: filter brightness 1.1

### Orderbook table row

- **내 평단가 원 (2026-10-19 사용자 승인):** 표시된 최근접 호가와 원본 소수 평단가의 차이가 평단가 방향의 1틱 이내일 때만 표시한다. 1틱을 초과하거나 표시 호가 범위 밖이면 원만 숨기고 상단 평단가는 유지한다. 가격대 경계에서는 위·아래 방향의 실제 다음 호가 단위를 각각 적용한다.

- **호가 정보 페이지 (2026-10-19 사용자 승인):** 10호가·호가 주문 창의 우측 상단 정보 영역은 같은 높이의 두 페이지로 나눈다. 제목은 모두 `정보`이며 페이지 표시는 숫자·화살표 없이 점 두 개로, 현재 점만 강조한다. 정보 영역의 라벨·값·빈 공간 어디를 클릭해도 다음 페이지로 순환하고 제목 버튼은 키보드로도 전환한다. 1페이지는 상단 예상 체결가·체결량과 시작·최고·최저·KRX종가·거래량·어제보다·거래대금, 2페이지는 상하한가·VI 정보를 담는다. 250일 최고·최저 표시는 제거하고, 두 페이지 모두 제목 바로 아래에는 구분선을 두지 않는다. 예상 체결가·체결량 라벨은 항상 유지하고, 값이 없거나 종료되면 숫자 칸은 대시·0·단위 없이 비운다. 기존 예상 체결 상단 배너는 제거하며, 예상값의 수신·갱신·종료나 페이지 전환으로 호가 사다리의 위치를 바꾸지 않는다. 좁은 창의 정보 팝오버도 같은 페이지 상태를 공유한다.
- Height: 22px
- Mono 11.5px
- Right side bar gradient (depth visualization): `--tint-price-up` for bid side, `--tint-price-down` for ask side (10% alpha; the underlying token names encode KRX convention — red for buy/up, blue for sell/down).
- Mid spread row: subtle bg, small-caps teal label

### 우측 레일 반응형 숫자 열 (2026-10-19 사용자 승인)

- 종목명·현재가·등락률 한 줄, 기존 글자 크기·색·행 높이와 종목명 시작 2.5rem·수집 상태 점을 유지한다.
- 관심종목·히트맵·스크리너·순위 패널에 측정 열을 적용한다. 현재가(쉼표 포함, sm)·등락률(부호·소수 둘째 자리·%, xs)을 실제 데이터 글꼴의 일반·활성 굵기로 측정해 전체 그룹의 공통 폭에서 오른쪽 정렬한다. 확정·예상 값과 양/음 등락률을 함께 확보한다.
- 검색·그룹 접힘 적용 전 목록을 기준으로 하고, 패널을 연 동안 관측한 자릿수 폭은 시세 축소·검색·그룹 접힘에도 유지한다. 패널을 다시 열면 현재 목록으로 다시 계산한다.
- 목록 본문 폭 20rem 초과/16.25rem 초과~20rem/16.25rem 이하에서 열 간격은 0.5→0.25→0.125rem, 오른쪽 여백은 0.75→0.5→0.25rem이다(기본 배율 320/260px 경계). 줄인 공간은 이름에 배분한다. 이름 최소 6em을 보호하고 긴 이름은 기존 말줄임을 유지한다. 숫자는 생략·줄바꿈하지 않으며 내재 최소 폭 이하에서 목록만 가로 스크롤한다.
- 드래그 고스트에 동일한 열 폭·간격을 전달한다.

- 같은 날 히트맵 후속 승인: 우측 히트맵 패널에도 같은 공통 숫자 폭·반응형 간격·관측 폭 유지를 적용한다. 그룹 평균 등락률은 종목 행 등락률과 같은 폭·오른쪽 여백으로 정렬하고, 값이 없을 때는 표기 없이 폭만 남긴다. 그룹명·개수의 인라인 구조와 평균 계산·시세/정렬 갱신 규칙은 유지한다. 그룹 드래그 고스트에도 같은 평균 정렬을 적용하고 종목 드래그의 이름+이동/복제 표시는 유지한다. `/heatmap` 풀페이지 보드의 배치·캔들 열은 유지한다.

- 같은 날 스크리너 후속 승인: 결과도 종목명·현재가·등락률 한 줄에 같은 측정 폭·반응형 간격을 적용한다. 같은 조건의 모니터링 재조회·빈 결과·종목 이탈·정렬에서는 관측 폭을 유지한다. 조건 선택만으로 이전 결과의 폭을 초기화하지 않고 새 결과의 저장 조건 ID·요청 원문(없으면 scanKey/저장본 수정 시각)·basis가 바뀔 때 초기화한다. 조회 중 결과가 비는 동안은 이전 폭을 유지한다. 종목 드래그 고스트에도 같은 폭·간격과 원본의 예상가 표시를 전달한다. 글자 크기·방향색·들여쓰기·관심 그룹 메뉴·조회/정렬/모니터링 규칙과 풀페이지 결과표는 유지한다.

- 같은 날 순위 후속 승인: 같은 공통 가격·등락률 폭과 반응형 간격을 적용하고 순위번호~종목명 구간은 별도로 계산한다. 네 자리 순위의 일반·활성 굵기 실측 폭과 0.125rem 간격을 확보하며, 순위번호 왼쪽 여백을 조정해 이름 시작을 2.5rem으로 맞춘다. 순매수 보조 줄은 유지하고 금액을 이름 영역 오른쪽에 정렬한다. 부호·쉼표·소수 둘째 자리·억을 포함한 전체 금액 폭을 측정해 이름 영역의 최소 폭에 반영하며 숫자를 말줄임하지 않는다. 더 보기·폴링·등락률 정렬·ETF 제외 전환에서는 관측 폭을 유지하고, 종류·시장·등락 방향·거래소가 바뀐 새 결과에서 초기화한다. 드래그 원본과 고스트에 같은 순위번호·금액 폭을 적용한다. 원래 순위 번호·조회/정렬·더 보기·스크롤 위치 보존·금액 계산은 유지한다.

### 2026-10-21 — 순위 패널 금액 한 줄 표시

2026-10-26 사용자 승인: 순위번호와 종목명 간격을 위 0.125rem에서 `space-sm`(0.5rem,
기본 8px)으로 넓힌다. 좁은 패널에서도 이 간격을 유지하고, 순위번호 왼쪽 여백을 줄여
종목명 시작 2.5rem과 기존 이름·숫자 열 폭을 보존한다. 네 자리 순위·확대 글자와
드래그 고스트에도 같은 간격을 적용하며 글자 크기·색·행 높이는 유지한다.

2026-10-23 사용자 요청: 우측 순위 패널의 `ETF 제외`는 패널 최초 표시 시 켜짐을
기본값으로 사용한다. 사용자는 기존 토글로 해제할 수 있다.

사용자 후속 승인: 거래대금·프로그램·기관·외국인은 `종목 · 금액 · 가격 · 등락률`을
한 줄로 표시한다. 프로그램·기관·외국인의 종목명 아래 순매수 보조 줄을 별도 금액 열로
옮기며, 거래대금도 같은 중립색과 억원 접미사를 쓴다. 모든 금액은 억원 단위 정수로
반올림하고 순매수의 +/− 부호를 유지한다. 0으로 반올림된 순매수에는 부호를 붙이지 않는다.
가격·등락률의 기존 표시 정밀도와 원 단위 원본 title을 유지한다.
같은 날 사용자 후속 요청으로 프로그램 탭처럼 목록 위의 열 제목 행은 표시하지 않는다.
값이 없으면 `—`, 실제 0은 `0억`으로 구분한다. 숫자는 공통 측정 폭으로 오른쪽 정렬하고
드래그 고스트에도 같은 금액·열 폭을 적용한다. 기본 폭 320px, 종목명 시작·글자 크기와
기존 조회·정렬·드롭 동작을 유지한다. 긴 종목명은 말줄임하고 숫자가 내재 최소 폭을
넘으면 목록만 가로 스크롤한다. 폴링·추가 조회·정렬 뒤에도 관측한 폭을 유지한다.
이 승인은 위 2026-10-19 순위 규칙의 순매수 보조 줄과 소수 둘째 자리 표기를 대체한다.

같은 날 사용자 후속 승인: 등락률·거래량 급증·거래량 탭에도 종목명과 가격 사이에
전일대비 금액·급증률·당일 거래량 열을 각각 추가한다. 상단 열 제목 없이 같은 한 줄
구조·중립색·공통 측정 폭·오른쪽 정렬을 사용하고 드래그 고스트에도 같은 값을 표시한다.
전일대비 금액은 부호·쉼표·원 단위, 급증률은 공급자 원본 %를 소수 최대 둘째 자리로
표시하며 툴팁에 기존 조회 조건인 `1분 기준 급증률`을 명시한다. 거래량은 1만주 미만은
주 단위 정수, 그 이상은 만주 단위 정수로 반올림하고 정확한 주 수를 툴팁으로 제공한다.
결측은 `—`, 실제 0은 각 단위의 0으로 구분한다. 기존 조회·정렬·더 보기와 폴링 주기는 유지한다.

### 2026-10-21 — 관심종목·히트맵 우측 패널의 당일 흐름

사용자 후속 승인: 두 우측 패널을 `종목명 · 가격 · 등락률 · 흐름` 4열로 통일한다.
같은 날 사용자 후속 요청으로 모든 우측 패널의 기본 폭을 320px(`--watchlist-panel-w`, 20rem)로 통일한다.
흐름은 64×16px, 행 높이·글자 크기는 기존 값을 유지한다. 열 제목은 목록 상단에 한 번만
고정하고 그룹 헤더는 그 아래에서 고정한다. 가격·등락률은 패널 공통 측정폭으로 오른쪽
정렬하며 수신·검색·접기 뒤에도 열 경계를 보존한다. 결측 흐름은 `—`로 표시한다.
64px는 SVG가 보호받는 고정 콘텐츠 폭이며 밀도 다이얼에 따라 줄이지 않는다.
다른 패널의 현재가 열과 `/heatmap` 보드는 유지한다. 같은 날 사용자 후속 요청으로
두 우측 패널의 그룹 헤더에서는 등락률·흐름을 제거한다. 그룹명·개수와 기존
접기·정렬 기능은 유지하고 그룹 드래그 고스트에도 같은 표시를 적용한다.
종목 행과 종목 드래그 고스트의 흐름 폭·등락률 정렬은 원본과 맞춘다.

흐름은 전일 기준가 대비 5분 버킷의 실제 관측값이며 60초마다 패널 단위로 조회한다.
미래·결측 버킷의 가로 위치를 보존하고 구간을 끊는다. 마지막 관측값 부호의 기존
가격방향 색과 0선을 사용하며 모양 비교용으로 각 그래프의 세로축은 개별 조정한다.
같은 날 사용자 후속 요청으로 흐름 그래프의 마우스 호버 툴팁을 제거한다.
마지막 관측 시각·결측 사유는 접근성 설명에 유지한다. 시세·동시호가
예상 등락률은 기존 갱신 경로를 유지하며 흐름에 예상가를 끼워 넣지 않는다.

저장 분봉이 없으면 `흐름 없음`으로 구분하고 조회 실패에는 재시도를 제공한다.
미국 종목은 국내 저장 분봉 경로를 사용하지 않으므로 빈 흐름과 미지원 사유를 표시하며
국내 평균에 합산하지 않는다. 새로운 벤더 호출·WS 구독은 만들지 않는다.

### Watchlist group header (관심종목 패널)
- 구조: `[chevron ▼(펼침)/▶(접힘), 좌측] [그룹명 + 개수 인라인] ··· [⋯ hover 메뉴, 우측]`
- 그룹명: `sm`/600 — 종목명(`xs`/400)보다 크고 굵게. 색은 `--fg-dim` 유지(크기·굵기만으로 위계).
- 개수: `xs` `--fg-dim`, **mono 금지** — 우측 정렬 mono 숫자는 종목 행의 가격 컬럼과
  같은 x에 떨어져 행으로 오독되므로 라벨 옆 인라인 고정. (2026-08-04 이전엔 `--fg-dimmer`
  라 드로어 배경 대비 ≈3.9:1 로 WCAG AA(4.5:1) 미달이었고 "3차 텍스트로 의도된
  트레이드오프"로 적혀 있었다 — 소형 텍스트 승격으로 폐기됐다. 개수는 라벨 버튼
  aria-label 에도 포함되어 AT 로도 전달된다.)
- sticky `top-0` + `--bg` 배경 — 드로어(RailDrawer)와 동일색이라 평시엔 투명처럼 보이고
  스크롤 시에만 행을 가린다. **드로어 배경을 바꾸면 이 헤더도 같이 바꿔야 한다**(색이
  어긋나면 평시에도 띠로 드러남). 공용 `RailGroupHeader` 외에 관심종목·히트맵이 드래그
  재정렬 때문에 헤더를 따로 구현하고 있으므로 3곳을 함께 본다.
- 종목 행(QuoteRow) 종목명은 `xs` — 가격(`sm` mono)이 1차 콘텐츠, 종목명은 식별자.
- 종목 행 들여쓰기: 아래 "우측 레일 리스트 — 종목명 좌측 정렬" 절이 결정한다. 이 절이
  관심종목 전용이었던 것은 2026-08-18 까지다.

### 우측 레일 리스트 — 종목명 좌측 정렬 (관심·히트맵·순위·스크리너)

네 리스트의 **종목명 시작 x 를 한 값으로 맞추는 계약** — `2.5rem`(40px @ 현재 1.0×
다이얼; 1.125× 시절엔 45px, 1.25× 시절엔 50px). rem 이라 다이얼을 돌려도 넷이 함께
움직인다. 이게 없으면 패널을 토글할 때 이름 열이 튄다.

경로가 **둘이고 서로 배타적**이다 (`QuoteRow` 의 여백식:
`leading != null ? 'pl-md' : indented ? 'pl-10' : 'pl-md'`).

- **관심·히트맵·스크리너**: `QuoteRow indented` → `pl-10`.
- **순위**: `leading` 순위번호 슬롯은 네 자리 순위의 실측 폭과
  `space-sm`(0.5rem) 간격을 보호하며, 번호 왼쪽 여백을 조정해 종목명 시작을
  같은 2.5rem에 맞춘다(2026-10-26 사용자 승인). **`leading` 이 있으면 `indented`
  는 무시되므로 둘을 함께 넘기지 말 것** — 죽은 prop 이 되고, 읽는 사람은 그게 효과가
  있다고 믿는다.

**드래그 고스트도 이 계약 안에 있다.** 고스트는 자기 리스트 행의 렌더를 그대로
복제하므로(관심종목 고스트는 들여쓰기 안의 수집 상태 점까지 싣는다) 관심·스크리너 고스트는
`indented` 를, 순위 고스트는 리스트 행과 같은 순위번호 슬롯(`RankSlot`)을 싣는다.
**폭만 맞추는 것으로 대신하지 말 것**: 정렬은 어느 쪽으로도 0px 이 되지만(실측), 순위
고스트에 `indented` 를 쓰면 리스트 행과 다른 분기로 같은 픽셀에 도달해 나중에 슬롯 폭이
바뀔 때 고스트만 조용히 어긋나고, 카드 안에 내용 없는 1.75rem 거터가 남는다.

근거는 두 번 바뀌었다. 출발은 **관심종목의 그룹 위계 교정**이었다 — 그룹 헤더의
chevron+라벨보다 종목명이 왼쪽에서 시작해 위계가 역전되던 것을 밀어냈다(실측 @1.0×
다이얼: 종목명이 라벨 시작보다 2px 오른쪽). 평면 목록인 스크리너로 확장하면서
(2026-08-18, #1378) 위계 근거는 사라지고 **정렬 일관성**만 남았고, 순위 드래그 고스트가
마지막 예외였던 것이 #1380 에서 닫혔다.

### Status dot (general)
- 6px circle, glow via `box-shadow` for active states only

### Error surfaces — 인라인 vs 토스트 (2026-08-04)

에러가 뜨는 자리는 **원인의 위치**가 정한다 — 표면을 새로 고를 때 두 갈래뿐이다.

- **액션 인접 인라인** (`InlineState`·폼 아래 한 줄): 사용자가 방금 누른 액션의 실패.
  실패의 맥락(입력값·버튼)이 화면에 있으므로 그 옆에서 말한다. 예: 캡처 시작 실패,
  이름 변경 실패, 조회 실패. **토스트로 옮기지 않는다** — 시선을 원인에서 떼어놓는다.
- **전역 토스트** (`ToastViewport` 호스트): 사용자 액션과 무관하게 배경에서 벌어진 일
  — 붙어 있을 화면 요소가 없다. 예: 시그널 알림, REST 불가/혼잡, 키움 풀하우스,
  배경 태스크 사망, 디스크 잠식, 그리기 전체 삭제 완료(실행취소 창구).
  호스트는 `App.tsx` 의 `ToastViewport` 에 모인다(2026-08-04 당시 6개).
  저장뷰 삭제는 패널을 닫아도 실행 취소·결과·실패 재시도를 제공해야 하므로
  `StudyViewDeleteToastHost` 전역 창구를 사용한다(2026-09-08).

판정이 애매하면 "이 에러의 원인이 지금 화면에 보이는가"로 가른다 — 보이면 인라인,
안 보이면 토스트. (2026-08-04 UI 조사 #5 의 "토스트 인프라 대비 소비처 1곳" 지적은
조사 시점 값 — 이후 #1069 등으로 배경 이벤트 호스트가 6개까지 늘었고, 남은 인라인
에러는 전부 액션 인접이라 정책상 그 자리가 맞다.)

### 경고 알림 통일 (2026-10-17 사용자 비교안 승인)

`Banner`·`InlineState`·페이지/레일의 실패 안내·상태 칩은 공통 의미 색상을 사용한다.
경고·오류 배경은 테마별 tint, 테두리는 해당 의미색 30%를 사용한다. 설명형 상태 칩과
작은 수치 배지를 구분하며 연결이 아닌 칩에는 상태 점을 붙이지 않는다. 차트 도구 행의
기존 배지 높이·폰트·닫기 버튼 정렬은 유지한다.

토스트는 제목과 닫기, 설명, 하단 행동 순서를 공유한다. 짧은 실행 취소만 한 줄로 둔다.
부분 성공(저장 완료·추가 수집 요청 실패)은 경고, 이동 실패는 오류로 표시한다.
마우스 오버와 내부 키보드 포커스 동안 표시 타이머·진행바를 함께 멈추고 남은 시간부터
재개한다. 일반 완료 안내는 5초를 기본으로 하며 기존 5/6초 실행 취소 시간과
지속 장애·수집 요청 실패의 수명은 유지한다. 저장뷰 삭제의 실제
5초 유예는 스토어가 소유하므로 표시 타이머로 늘리거나 멈추지 않는다.

라이브 상단 운영 배너는 서비스 상태 패널로 이관한다. 새 수집·저장·인증 장애는
10초 주의 환기 토스트로 알리고, 닫힘·만료 뒤에도 패널의 현재 문제는 남긴다.
동일 관측 폴링은 재알림하지 않으며 회복 후 재발·새 원인에는 다시 알린다.
구버전 capture_reason·실패 앱키 이름도 누락 없이 패널에 유지한다. 시그널 인박스,
확인 모달, 렌더 실패 대체 화면, 차트 구간 결손 안내는 각각의 역할을 유지한다.

호가주문의 신규 주문 불가 사유는 수량 입력 아래 공통 `InlineState`로 유지하고,
사유가 해소되면 자동으로 없앤다. 주문 칸은 `aria-disabled`와 같은 전송 가드로 차단하되,
마우스·키보드 시도에는 사유를 공통 토스트로 안내한다. 기존 주문의 취소·드래그 가능 여부는
신규 주문과 별도로 판정한다. 호가 지연을 거래시간 외로 단정하지 않으며 API가 확정한
접수 거절은 제목·상세 사유를 나눠 경고로 표시한다. 마지막 거절 사유는 인라인에 남기고
수량·계좌 변경 또는 다음 주문 시도에서 해제한다. 확정 거절에는 같은 요청 재확인 행동을
붙이지 않는다. 결과 불명확은 자동 만료하지 않고 해당 요청의 재확인 행동을 유지한다.
접수 완료 4초·일반 주문 경고 8초는 공통 타이머·진행바를 사용하며 호버·포커스로 함께 멈춘다.

### Destructive actions — 보호 사다리 (2026-08-04)

파괴적 액션의 안전장치는 **위험도에 비례해 4단계 중 하나**를 쓴다 — 새 표면이 임의로
다섯 번째 패턴을 만들지 않는다(2026-08-04 UI 조사에서 "4패턴 혼재로 누르기 전 예측
불가"로 지적된 것을 사다리로 명문화; 지점별 실사 결과 배치 자체는 위험도와 일치했다).

| 단계 | 패턴 | 기준 | 현행 사용처 |
|---|---|---|---|
| 1 | 즉시 실행(보호 없음) | 단건 + 재생성이 한 동작(재추가·재그리기) | 관심 1종목 제거, 히트맵 1종목 제거, 그리기 1개 삭제, 큐 1행 취소 |
| 2 | 인라인 2단(같은 자리에서 "삭제?" 재클릭 / armed 타이머) | 목록 안 반복 작업 흐름 — 모달이 흐름을 끊으면 더 나쁨 | 프리셋 삭제(`PresetMenu` pendingDelete), 캡처 Cancel All(4초 armed) |
| 3 | 삭제유예 + 실행취소 | 재생성 비용이 큰 사용자 저작물 | 저장뷰 단건·선택 삭제(`studyViewDeletion` + `StudyViewDeleteToastHost`): 요청별 독립 5초 유예 |
| 4 | `ConfirmModal(tone="destructive")` | 대량 삭제 또는 부수 효과 동반(멤버 동반 삭제·수집 중단) | 조건검색 삭제, 그리기 전체 삭제, 관심 폴더·히트맵 그룹 삭제 |

- `window.confirm` 은 금지 — 테마 밖 OS 다이얼로그라 온-브랜드 크롬이 아니고,
  테스트에서 스텁 지옥이 된다(2026-08-04 에 잔존 3곳을 `ConfirmModal` 로 전환).
- 단계를 올릴지 애매하면 "실수로 눌렀을 때 복구에 몇 동작이 드는가"로 판정한다 —
  1동작이면 1단계, 여러 동작·재입력이면 3단계 이상.

### Modals & popovers — dismissal contract

**Live 종목 검색 (2026-09-09):** `/` 또는 헤더 검색 버튼으로 여는 검색 표면은 최대
640px, 상단 12vh의 비모달 팝오버다. 전체 높이는 80dvh 이내이며 결과 목록만
스크롤한다. 입력·종목명은 `text-base`, 코드·시장은 `text-sm`로 종목명 아래에
묶는다. 최근 검색도 동일한 세로 행을 쓰며 삭제는 종목 선택과 분리된 버튼이다.
제목·닫기 버튼·키보드 안내를 표시한다. 적용 대상·고정 창 제외 문구는 표시하지
않으며 모든 창이 고정되어 적용할 수 없을 때만 안내한다. Escape는 검색창만
닫고, 외부 클릭이 다른 컨트롤에 포커스를 옮긴 경우를 제외하면 이전 포커스를
복원한다. 기존 테마·폰트 토큰과 최근 5개 저장 정책은 유지한다.

**2026-10-18 사용자 승인 시안 — 빠른 종목 전환:** 위 검색 표면의 폭·위치·비모달
동작을 유지한다. 입력 안내에 초성을 추가하고 검색어 지우기를 둔다. 최근 검색과
결과의 관심 그룹 하트는 같은 크기·위치로 표시하며, 최근 기록 삭제는 하트 오른쪽의
독립 버튼이다. 종목명에서 직접 일치하는 부분은 굵기로 강조하고 현재 보고 있는
종목에만 `현재`를 표시한다. 결과 제목 옆에는 표시 건수(최대 20개)를, 하단에는
방향키 이동과 Enter로 열릴 종목명을 표시한다. Escape 안내는 헤더의 닫기 버튼에 둔다.
정확한 이름·코드, 접두사, 부분 일치, 초성 순으로 정렬하고 같은 순위는 이름 길이와
원본 순서로 고정한다. 최근 이력과 관심 등록은 검색 순위에 영향을 주지 않는다.
종목·지수 목록의 준비 중·조회 실패·정상 빈 결과를 구분하고 실패한 목록은 다시
시도할 수 있다. 모든 종목 창이 고정되면 선택을 막되 검색과 관심 그룹 편집은
유지한다. 관심 그룹 팝오버의 Escape는 그 팝오버만 닫고 하트로 포커스를 돌려준다.
초성 검색·새 정렬은 라이브 검색에만 적용하며 캡처·히트맵의 검색 계약은 유지한다.

Two layers, each with one shared owner. Use them; do **not** hand-roll a dismiss `useEffect`.
- **Center modal** (full-screen backdrop, fixed-position card): wrap in `ModalShell` (`frontend/src/ui/ModalShell.tsx`) — it owns the backdrop, Escape + backdrop-click dismiss, the canon card, and the title + ✕ header. **`/live` 의 보조지표(IndicatorPanel)·설정(SettingsSections) 패널이 2026-08-21 부터 여기 속한다**(사용자 결정, 아래 결정 로그) — 둘은 폭·높이·마스터-디테일 nav 를 `frontend/src/live/workspacePanel.ts` 상수로 공유하므로 클래스를 다시 적지 말고 상수를 소비할 것. 그 동기화는 `App.test.tsx`(설정)와 `IndicatorPanel.test.tsx`(지표)가 **같은 상수를 각각 단언**해서 지킨다 — 한쪽이 하드코딩으로 이탈하면 그 테스트가 빨개진다.
- **Right drawer** (`ModalShell side='right'`, ADR-0116) — ⚠ **2026-08-21 부터 앱 소비자가 0 이다**(설정·보조지표가 중앙 모달로 옮겨갔다; 코드와 `ModalShell.test.tsx` 커버리지는 되돌릴 여지를 위해 남겼다. 새로 쓰기 전에 결정 로그를 읽을 것 — 되돌림이지 신규 선택지가 아니다): full-height right-anchored variant of the same shell — lighter dim (`bg-black/30` vs the center modal's `bg-black/50`), `border-l` instead of the rounded card border, 150ms ease-out slide-in. Purpose: **immediate-apply settings stay visible against the live chart** — the left ~520px of chart remains readable behind the dim, so a toggle's effect is seen in place. Used by the `/live` 보조지표(IndicatorPanel) and 설정(LiveSettingsModal) drawers, which share width (`760px`) and master-detail nav (`240px`) via what is now `frontend/src/live/workspacePanel.ts` (renamed 2026-08-21 — the file no longer describes a drawer) — the two panels must not shift when the user switches between the toolbar buttons, so consume the constants rather than restating the classes.
- **Anchored popover / dropdown** (floats next to a trigger): use `useDismissablePopover` (`frontend/src/util/useDismissablePopover.ts`) for the outside-click + Escape contract, plus `clampToViewport` for edge safety.
- 창 헤더처럼 드래그 시작을 위해 `pointerdown`을 취소하는 영역을 눌러도 열린 팝오버를 닫는다. 이때 생략되는 `mousedown`에만 의존하지 않는다. 트리거·메뉴 내부 및 중첩 팝오버의 예외는 유지한다.
- A copied `addEventListener('mousedown'|'keydown')` is how this drifts (one site on `document`, another on `window`; one forgets Escape) — the helpers concentrate the contract so it can't.

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-05-20 | Created design system via `/design-consultation` | Captures the Modern Trading Lab direction approved via the Variant B mockup. |
| 2026-05-20 | Geist Sans + Geist Mono over Inter + JetBrains Mono | Equal readability, slightly more distinctive, same vendor (Vercel). Avoids the Inter convergence trap without changing the design feel. |
| 2026-05-20 | Single teal accent, strictly separated from up/down semantic | Prevents data-vs-UI color confusion. Teal is "the system speaking"; green/rose is "the market speaking". |
| 2026-05-20 | Compressed multi-day time axis (no overnight gap) | Screen density over chronological accuracy; matches TradingView's convention for analyzing across sessions. |
| 2026-05-20 | Tab status pulse dot | Multi-tab async state needs to be visible. One small animation is worth the tradeoff. |
| 2026-05-20 | Monospace 100% for numbers | Tabular-nums is required for orderbook column alignment. Two-font cost (~50 KB extra) is negligible on localhost. **(뒤집힘 — 2026-07-21 참조)** |
| 2026-05-23 | Adopted KRX market convention (up=red `#DC2626`, down=blue `#2563EB`) | Single-user Korean analyst — Western up=green is counter-intuitive. Renamed `--up`/`--down` → `--success`/`--error` to disambiguate status semantic from price direction; introduced `--price-up`/`--price-down`. Removed `--ratio-ask` (folded into `--price-down`). All chart series now hide both `priceLineVisible` and `lastValueVisible` — analysts read latest values via crosshair. |
| 2026-05-30 | Global Right Rail (fixed; single 관심 item, heart icon) replaces the `/live` ★ watchlist drawer; the chevron `»`/`«` and the 관심 item both show/hide the Watchlist Panel; chrome state in a dedicated `rightRail` store (ADR-0052) | Watchlist reachable from every page. Rail does not collapse — only the panel opens. Active state = tint bg + neutral text (no triple-teal, matches the app-shell active state). `--rail-w` added via `design-tokens.ts` (ADR-0012). |
| 2026-06-08 | 관심종목 그룹 헤더 위계: 크기 교환(그룹 sm/600, 종목명 xs) + 개수 인라인 + chevron 좌측 ▼/▶ + sticky | 그룹·종목이 같은 "좌 텍스트 + 우 mono 숫자" 패턴으로 오독되던 문제. 디자인 컴패니언 4안 비교로 색 추가 없는 A안 선택 — 틸 라벨은 색상 규율(UI 상태 전용) 이탈로 기각. |
| 2026-07-08 | 미정의 `--font-ui`/`--font-mono` 정의 + Geist→IBM Plex 전환 | 토큰이 정의된 적 없어 앱 전체가 Times(세리프)로 렌더링되던 P0. IBM Plex Sans KR 은 한글까지 한 패밀리로 커버, Plex Mono 로 tabular-nums 유지. |
| 2026-07-08 | 상업화 듀얼 테마 Obsidian(다크)/Ledger(라이트) 도입 — 기존 틸 다크는 Obsidian 으로 교체 | 판매 가능한 프로 룩 요구. 틸+단일 형광은 생성형 기본값이라 차별성 없음 → 브래스/장부초록으로 아이덴티티 확보. 색 규율(UI/상태/시세 3분류)은 양 테마 계승. `[data-theme]` 계약 + 라우트별 auto. |
| 2026-07-08 | 차트 색을 `resolveTokensThemed` 지연 해석으로 전환 (모듈 상수 박제 제거) | canvas 가 var() 를 못 받아 모듈 로드 시점 색을 박제 → 부트 테마에 고정되던 결함. 프로젝터 캐시에 테마 키, 시리즈 옵션 thunk 화로 테마 전환 대응. |
| 2026-07-15 | 기본 밀도 1.25×(20px) → 1.125×(18px) 하향 + `RENDERED_ROOT_PX` SSOT 신설 | 사용자 A/B(16/18/20px 스크린샷)로 18px 확정 — 기본 글씨가 크다는 체감 해소, 밀도 DNA 회복. 다이얼 값을 design-tokens.ts `RENDERED_ROOT_PX` 로 승격해 생성기 주석·표와 chartScale.ts 캔버스 상수가 모두 파생(하드코딩 ×20 제거). |
| 2026-07-15 | Obsidian `--bg` #0A0A0C → #060608 심도 강화 | 배경↔카드 명도차(Δ~8)가 너무 옅어 패널이 한 덩어리로 읽힘. 다크에서 1px 보더 강화는 반복 실패(#610~613) — 분리는 톤+간격이 담당한다는 규칙 확정. 카드 크롬(`--bg-card`+border+radius+gap) 자체는 기존 구조 유지. |
| 2026-07-15 | 전역 하단 시장지표 바(MarketIndexBar) 신설 — 앱 셸 3행(auto) | 대표지수 현재지수+전일대비 스트립(KIS FHPUP02100000, 백엔드 20s TTL 코얼레스 + last-good). 색 규율: 등락=가격 방향(priceDirClass 색+부호), 라벨=fg-dim, 값=mono fg. 데이터 없으면(자격증명 부재) 행이 0으로 접혀 빈 띠가 남지 않는다. 지수 클릭=해당 /live 탭 열기. |
| 2026-07-15 | `/live`·`/study` 워크스페이스 pane 보더 제거(A안) — 차트↔상세 경계선 폐지 | 차트와 상세 사이 17px 이음매에 1px 선 3개(카드 보더 + 스플리터 라인 + 카드 보더)가 겹쳐 지저분하게 읽힘. "분리는 톤+간격" 규칙(#610~613)을 pane 이음매에도 적용: `/live`는 두 카드 보더 제거(톤+4px gap+shadow-panel 유지), `/study`는 `border-l` 제거+상세 배경 `bg-subtle/40`→`bg-subtle` 승격(한 카드 내 톤 스텝). 스플리터 리사이즈 라인은 평상시 숨김, 호버/드래그 시 `--accent`로만 노출. |
| 2026-07-15 | 차트 pane 구분선 완화 + 상세패널 겹친 이음매 정리 (#635) | 토스식 "구분선 최소" 평가에서 나온 두 최대 소음. pane 구분선 다크 `#63636f`→`#3a3a42`(Δ~80→~35)·라이트 `#9a917c`→`#bcb4a0` — 이전 값은 `fg-dimmer` 수준의 화면 최강 선이라 규칙 위반(DESIGN.md 기록 `#44444F`와도 드리프트). 상세패널은 카드 `border-t` 제거로 이음매 2선→1선(리사이저선만). |
| 2026-07-15 | **Obsidian `--bg` #060608 → #121216 (= `--bg-card`, 배경 통일)** — 위 심도 강화 결정 되돌림 (#636) | 토스 레퍼런스 기준 "배경색 통일" 평가. 카드를 슬랩처럼 띄우던 톤 스텝이 차트↔호가 gutter 를 어두운 골로 만들어 화면이 쪼개져 읽힘. 사용자 A/B(현재/중간/통일 스크린샷)로 통일(Level B) 확정 — `--bg`=`--bg-card` 로 gutter 소멸, 분리는 4px gap + `--shadow-panel`(카드 가장자리 옅은 다크 헤일로)만 담당. `--bg-subtle`/`--bg-input` 불변이라 nav·탭 활성/비활성·입력 크롬 어포던스 보존. Obsidian 전용(/live·/heatmap). "분리는 톤+간격"의 극단(톤 스텝 0). |
| 2026-07-15 | **Ledger `--bg` #F6F4EE → #FDFCF8 (= `--bg-card`, 배경 통일)** — 다크와 대칭 (#637) | 라이트도 같은 방식으로 통일. 다크 워크스페이스(borderless, gap+shadow 의존)와 달리 **Ledger feature-route 카드는 `--border` 를 유지**하므로 톤 스텝 0에서도 카드 경계가 보존됨(/study·/screener A/B 확인 — 카드 border 로 분리, 뭉개짐 없음). 원래 Δ~11 로 작아 효과는 다크보다 subtle. `--bg-subtle`/`--bg-input` 불변. |
| 2026-07-15 | 하단 시장지표 바(MarketIndexBar) `bg-subtle`+`border-t` → `--bg` borderless | 상단 TopNav 와 대칭 — 하단 바도 `border-t` 제거 + `bg-subtle`→`bg`(=`--bg`) 로 메인 콘텐츠와 완전 통합. 이제 왼쪽 스택(헤더 → 페이지 → 하단 바)이 위→아래 끊김 없는 단일 `--bg` 면이 되고, 크롬 톤(`--bg-subtle`)은 우측 패널(레일·드로어)에만 남는다. 지수 항목 사이 세로 구분선(`w-px bg-border`)은 콘텐츠 내부 구분이라 유지. |
| 2026-07-15 | 앱 셸 열 기반 재구성 — 우측 패널 full-height + 헤더 콘텐츠 통합 | 앱 셸을 행 기반(헤더 전체너비 / 콘텐츠 / 하단바 전체너비)에서 **열 기반**(왼쪽 스택 `1fr` \| 우측 패널: 드로어 + `var(--rail-w)` 레일)으로 전환 — 우측 패널(드로어+레일)이 화면 상단~하단 **full-height** 열로 서고, 헤더는 우측 패널 위 코너를 양보(main 너비만 차지). 왼쪽 스택은 3행(TopNav / 페이지 / 하단 시장지표 바). 오버레이(토스트·설정 모달)는 `fixed`라 열 배치 무영향. 추가로 TopNav `border-b` 제거 + `bg-subtle`→`bg`(=`--bg`) 로 헤더를 메인 콘텐츠와 완전 통합("분리는 톤+간격" 확장 — 화면 왼쪽은 위→아래 단일 `--bg` 면, 크롬 톤은 우측 패널에만). 헤더 검색창(LiveSymbolSearch 트리거)은 헤더가 좁아질 때(드로어 열림) `min-w-0`+`truncate` 로 두 줄 줄바꿈 대신 한 줄 말줄임. |
| 2026-07-15 | `/study` 워크스페이스 → `/live` 부유 카드 모델로 통일 | `/study` 는 단일 `PanelCard`(border) 안 flush 패널 모델이라 `/live`(필드 위 부유 카드 2장)와 레이어 구조가 달랐음. 바깥 `PanelCard` 프레임 제거 → 차트·상세를 각각 `bg-card`+`rounded`+`shadow-panel` 카드로 만들어 `--bg` 필드 위 4px gap 으로 부유. 탭 바(`ChartTabBar` `background="var(--bg)"`)·헤더 행을 `--bg` full-bleed 크롬으로(WorkspaceHeader→plain --bg div, 상세 aside `bg-subtle`→`bg-card`). 상태 화면(빈/로딩/에러)은 `PageContainer`+`PanelCard` 유지(활성↔상태 전환 점프 방지). 다크(톤 스텝 0=shadow 단독)·라이트(옅은 shadow) A/B 확인. |
| 2026-07-15 | `/live` 종목명 스트립(LiveStatusBar) `--bg-subtle` → `--bg` + 워크스페이스 탭 바 배경 파라미터화 (배경 통일 확장) | 통일된 배경 위에서 종목명 스트립만 `--bg-subtle`(크림/골)로 남아 아래 차트 카드와 톤이 어긋나 보임. 페이지 배경(=워크에어리어)과 동일 톤으로 당겨 스트립+차트를 한 콘텐츠 존으로 통합(`/live` 멀티 탭은 ADR-0113 #641 로 제거되어 탭 바 없음). 공용 `ChartTabBar` 에 `background` prop 신설(기본 `--bg-subtle`) — `/study` 워크스페이스 탭 바가 `--bg` 를 넘겨받아 부유 카드 크롬과 통일(아래 `/study` 항목). 탭 어포던스는 거터 톤 대비에서 **테두리(`--border`)+활성 탭 accent 상단바/테두리**로 이관(비활성=흰 바 위 아웃라인 칩, 활성=accent). `--bg-subtle` 은 TopNav·드로어·설정 nav 크롬 전용으로 축소(워크스페이스 탭 바·price strip 용도 제거). 라이트/다크 A/B 확인. |
| 2026-07-15 | `/heatmap` 카드 → `/live` 패널과 배경·크롬 통일 (borderless) | 기준=`/live` 차트 패널: `--bg-card`(=`--bg`) + `--shadow-panel`, 테두리 없음. `/heatmap` 카드는 유일하게 1px `--border` 링 + 어두운 헤더 밴드(`bg-subtle` + `border-strong`)를 달고 있어 두 다크 표면이 어긋나 보임(둘 다 Obsidian). `PanelCard` 에 additive `borderless` prop 신설 → `/heatmap` 의 두 `PanelCard`(본문·상태 shell)만 opt-in(테두리 제거, 나머지 카드 크롬 유지). 내부 헤더 + `SectorTempStrip` 밴드는 `bg-subtle`→`bg-card`, 구분선 `border-strong`→`border` 로 평탄화(live `WorkspaceToolbar` = `bg-card`+`border-b border` 와 동형). **Ledger feature-route 카드의 `--border` 유지 규칙은 불변** — `/heatmap` 은 Obsidian 전용이라 라이트에서 카드가 배경에 녹는 리스크 없음. 실측: 카드 `border 0px`·헤더 `bg #121216`·구분선 `#232329`(live 패널과 동일). |
| 2026-07-15 | `/screener`·`/inventory`·`/capture` 카드도 borderless (feature-route 전면 통일) | 위 `/heatmap` 통일을 나머지 feature route 로 확장. 이 3페이지는 `/heatmap` 과 달리 기본 `auto` 에서 **Ledger(라이트)** 표면이라, 직전 "Ledger 카드는 `--border` 유지" 규칙과 정면 충돌 — 라이트에서 `--bg`=`--bg-card` + 옅은 shadow 라 테두리를 지우면 카드 경계가 약해진다. **사용자가 라이트 tradeoff 를 명시적으로 수용**하고 `/live`·`/study` 워크스페이스와의 전면 통일을 택함 → 8개 `PanelCard`(screener 3·inventory 3·capture 2) 모두 `borderless`. 이로써 이전 "Ledger 카드 `--border` 유지" 규칙은 폐지되고 `--border` 는 카드 내부 구분선·입력·테이블 전용이 된다. 각 페이지 테스트(`toHaveClass('border')`→`not.toHaveClass`)·DESIGN.md Content framing 규칙 갱신. |
| 2026-07-16 | `/live` 보조지표·설정을 중앙 모달 → **우측 드로어**(`ModalShell side='right'`, ADR-0116)로 전환 + 크롬 상수화 | 두 패널 모두 즉시 적용(저장 버튼 없음)인데 1040×820 중앙 모달이 차트를 덮어 효과를 볼 수 없던 모순 해소 — 드로어(760px)는 좌측 ~520px 차트를 가벼운 딤(`bg-black/30`) 너머로 남긴다. 보조지표↔설정 전환 시 패널이 흔들리지 않도록 폭·nav(240px 마스터-디테일)를 `frontend/src/live/workspaceDrawer.ts` 상수로 강제(copy-paste 드리프트 방지, PR #670·#671 코드리뷰 후속). Center modal 은 확인 다이얼로그(ConfirmModal) 등 짧은 상호작용 전용으로 존속. |
| 2026-07-21 | **호가창 잔량 증감 뱃지 = KRX 컨벤션(증가 `--price-up` 빨강 / 감소 `--price-down` 파랑)** — 차트 오버레이의 teal/fuchsia 와 의도적 분기 (사용자 승인) | 잔량 증감 색은 원래 teal/fuchsia 한 쌍을 세 표면(차트 오버레이·`/live` BookPanel·`/study` OrderbookTable)이 공유했다. 그 색조의 근거는 **레이어 겹침** — 차트에선 잔량 증감과 호가 히트맵(빨강·파랑)이 같은 셀에 동시에 켜져 색이 충돌하면 판독 불가다. 호가창 뱃지엔 겹치는 레이어가 없어 그 제약이 성립하지 않고, 증감은 `--price-*` 의 정의("positive delta = red")에 그대로 들어맞는 시장 데이터라 KRX 컨벤션이 더 직관적이다. 뱃지 2곳만 `priceDirClass()` 로 전환하고 차트 오버레이 기본색(`DEPTH_DELTA_DEFAULT_*`)은 불변 — **두 표면의 색이 다른 것은 버그가 아니라 이 결정이다.** 뱃지는 막대 바깥쪽 끝에 붙어 같은 색 막대(ask 파랑 28% / bid 빨강 28%) 위에 얹히는 경우가 생기지만, 막대가 저알파라 솔리드 텍스트가 읽힌다(장중 실화면 확인). **2026-08-25 후기:** 대비 상대였던 차트 오버레이(단별 잔량 증감)가 제거됐다(ADR-0161) — `DEPTH_DELTA_DEFAULT_*` 도 함께 사라졌고, 이제 증감 색은 뱃지의 KRX 컨벤션 한 벌뿐이다. |
| 2026-07-22 | **Toss Dark 추가 (`[data-theme='toss-dark']`) — Toss Light 의 다크 대응** | 같은 날 추가한 Toss Light 의 다크 짝. tossinvest.com 라이브 다크 토큰(`data-wts-theme='dark'`) 실측 벤치마크. 수동 선택 전용(auto 무관). **결정 대칭**: (1) 배경 층 부활 — `--bg #101013`(near-black 바닥) ≠ `--bg-card #17171c`(더 밝은 카드), 라이트의 반대(밝은 바닥+흰 카드)를 뒤집음. (2) **accent-vs-price 파랑 충돌을 라이트와 반대 방향으로 분리** — 라이트는 하락 파랑을 accent 보다 *진하게*(#1957c2) 눌렀지만, 어두운 배경에선 진한 파랑이 묻히므로 다크는 하락을 accent(#3182f6)보다 *밝게*(#56a3ff) 띄운다. "분리 방향은 배경 명도가 정한다." (3) `--fg #eceff5` — 순백(#fff) 대신 살짝 푸른 오프화이트(토스 다크 txt-primary=rgba(242,246,255,0.9) 실측 반영, 눈부심 억제). Elevation/MA 는 Obsidian 다크값 재사용. 파일 세트는 Toss Light 와 동일(themePrefs 5-옵션, EffectiveTheme 확장, index.html, Settings, DESIGN, test). |
| 2026-07-22 | **세 번째 테마 Toss Light 추가 (`[data-theme='toss-light']`) — "no third theme" 규칙 폐지** | 사용자 요청으로 tossinvest.com 라이트 팔레트를 벤치마크(라이브 CSS 커스텀 프로퍼티 실측)해 3번째 테마로 도입. Ledger(ivory+초록)를 교체하지 않고 병존 — 수동 선택 전용(`auto` 는 여전히 Obsidian/Ledger 만). **핵심 결정 2가지**: (1) **배경 층 부활** — Ledger 는 `--bg`==`--bg-card` 통일이지만 Toss Light 는 `--bg #f6f7f9`(회색 바닥) ≠ `--bg-card #ffffff`(흰 카드)로 토스식 명도 층을 되살림. (2) **accent-vs-price 파랑 충돌의 승인된 예외** — 토스 브랜드 accent 가 파랑(#3182f6)이고 하락 시세도 파랑이라 우리 3분류 규율(UI색 ≠ 시세색)과 충돌. accent 를 초록으로 빼면 "토스다움"이 사라지므로 토스블루 accent 를 유지하고, 대신 `--price-down` 을 한 톤 진한 `#1957c2`(blue800)로 벌려 분리(accent=solid fill, down-price=text/border). 고밀도 화면에서 완벽하진 않은 트레이드오프를 수용 — 기존 `--error`/`--price-up` 양쪽 빨강 중첩 선례와 동형. 구현: tokens.css 색-only 블록(Ledger 와 동일 세트, base 밖) + themePrefs.ts 4-옵션 + index.html 부트스트랩 + Settings 세그먼트. 차트 canvas 색은 `resolveTokensThemed` 가 `data-theme` 를 캐시키로 런타임 `getComputedStyle` 해석하므로 프로젝터 코드 무변경(폴백 hex 는 테스트/SSR 전용). |
| 2026-07-21 | **타이포 전면 전환: IBM Plex Sans KR + IBM Plex Mono → Pretendard 단일 패밀리** — 모노스페이스 폐지, 숫자 정렬은 `tnum` 으로 이관, `--font-mono`→`--font-data` 리네이밍, 자간 전면 `normal` (사용자 승인, 프로토타입 A/B/C 비교) | 토스증권 타이포 시스템 벤치마크에서 출발. 토스는 **한 패밀리로 본문·숫자를 모두 처리하고 정렬은 `tnum` OpenType 피처로 얻는다** — 모노스페이스 두 번째 패밀리(~50KB)가 불필요해진다. Toss Product Sans 자체는 산돌 제작 전용 서체로 공개 배포되지 않아 사용 불가 → 동일 계열 오픈 라이선스(SIL OFL) 대체제 **Pretendard** 채택(기존 폴백 체인 2순위였음). **실측이 결정 근거**: Pretendard 숫자는 기본 프로포셔널(40px 에서 `1`=17.55px vs `4`=24.97px)이나 `tnum` 적용 시 전부 24.58px 로 균일. 실 호가창에서 대조 실험 — `tnum` OFF 시 9자리 가격 20개가 **18종 폭(편차 3.12px)** 으로 흩어지고, ON 시 **1종(편차 0px)**. 즉 정렬의 원인은 서체가 아니라 피처 플래그이므로, 개별 호출부의 `tabular-nums` 선언에 맡기지 않고 **Tailwind `fontFamily` 튜플로 `font-data` 유틸리티 자체에 `font-feature-settings:"tnum"` 를 결속**했다(구조적 안전). 이 결속이 없으면 `font-mono` 만 있고 `tabular-nums` 가 없던 80개 호출부가 타입 에러도 테스트 실패도 없이 조용히 어긋난다. `font-mono` 는 삭제하지 않고 deprecated 별칭으로 남긴다 — 키를 지우면 Tailwind 기본 모노 스택이 승계돼 등폭 보장이 사라지기 때문(fail-safe). **포기한 것**: 2026-05-20 이 세운 "데이터=기계적 텍스트" 시각적 위계. 토스는 위계를 굵기·색으로만 만들고 서체로 만들지 않으며, 사용자가 실데이터 프로토타입 3안(현행/토스식/하이브리드)을 비교한 뒤 토스식을 선택했다. |
| 2026-07-29 | **우측 패널(레일 + 6개 드로어 + sticky 그룹헤더) `--bg-subtle` → `--bg`** — 배경 통일 완결, 앱 셸에서 크롬 톤 소멸 | 2026-07-15 #636/#637 이 `--bg`=`--bg-card` 로 배경을 통일한 뒤 "크롬 톤(`--bg-subtle`)은 우측 패널에만 남는다"고 적어둔 잔여분을 정리. Obsidian 실측 = 페이지 `#121216` vs 패널 `#0E0E11` (채널당 4~5, 상대휘도 ≈1.3%), 두 면 사이 **border 없음** — 즉 이 미세한 명도차 하나가 패널의 유일한 윤곽선이었다. 사용자가 스크린샷 실측(경계 x≈910px 에서 `rgb(18,18,22)`→`rgb(14,14,17)` 로 딱 끊김)을 보고 우측 패널 전체 적용을 결정. **범위**: `RailShell.RailDrawer`(6개 드로어 공용 셸)·`RailShell.RailGroupHeader`·`RightRail` 레일·`WatchlistDrawer`/`HeatmapDrawer` 자체 sticky 그룹헤더(드래그 재정렬용 별도 구현). sticky 헤더는 "패널 배경과 동일색이어야 평시에 투명" 계약이라 **선택이 아니라 동반 필수** — 어긋나면 평시에도 띠로 드러난다. **범위 밖**(계속 `--bg-subtle`): 모달 내부 recessed 박스(`CollectDialog`·`StudyViewSaveDialog`), 스크리너 조건 카드(`ConditionRow`), 설정/지표 nav, `StudyViewsDrawer` 삭제 유예 토스트(transient 밴드 — `border-t` 로 이미 구분되고 recessed 톤이 "임시" 어포던스; **2026-09-08 후기:** 이 인라인 밴드는 `StudyViewDeleteToastHost` 전역 토스트로 옮겼다). **부수 효과**: `RailToolbarIconButton` active(`--bg-input` `#101014`)가 패널보다 밝음→어두움으로 극성이 뒤집히나 `border-strong` 이 어포던스를 유지한다. 톤 스텝 0이므로 `border-l` 로 경계를 되살리지 않는다(테스트가 `not.toHaveClass('border-l')` 로 고정). Toss Light/Dark 는 층 구조를 유지하는 테마지만 드로어=바닥 톤이라는 의미는 동일하게 성립. |
| 2026-07-29 | **10호가 잔량 숫자에 방향색 2벌 부여 — `--qty-ask`(매도 `--price-down` 파랑) / `--qty-bid`(매수 `--price-up` 빨강) 신설** | 그전까지 `/live`·`/study` BookPanel 의 잔량 숫자는 양쪽 다 `text-fg-dim` 한 색이라 side 정보를 색이 전혀 나르지 않았다. 색 출처는 사용자 지시로 tossinvest.com 주문 페이지 **실측** — 페이지의 `%` 텍스트를 계산색으로 그룹핑하니 세 쌍이 나왔고(본문 `#2272eb`/`#e42939`, 관심 리스트 `#3182f6`/`#f04452`, 지수바 `#de2b39`), `:root` 의 `--wts-adaptive-*` 스케일을 덤프해 본문 등락률 = **blue600/red600** 으로 등급을 확정했다. **스크린샷만으로는 어느 표면의 톤인지 구분 불가**라는 것이 이 실측의 핵심 교훈. 우리 쪽 대응 토큰은 등락률 글자를 칠하는 `--price-down`/`--price-up` 이라 거기에 별칭으로 붙였다 — Toss Light 의 파랑이 한 톤 진한 것(`#1957c2` vs `#2272eb`)은 accent-vs-price 충돌의 승인된 예외이지 드리프트가 아니다. **막대 토큰(`--bar-*`)을 재사용하지 않은 이유**: 막대는 저알파 워시(다크 28~30%)라 텍스트에 그대로 쓰면 대비가 무너진다. **뱃지 색과 축이 다르다** — 증감 뱃지는 delta 의 부호(2026-07-21 행), 잔량 숫자는 호가의 방향이라 "빨간 잔량 + 파란 −뱃지"가 정상 조합이다(테스트가 이 조합을 고정). 별칭이라 4개 테마가 각자 값으로 풀리고 같은 패널 하단 총잔량 스트립과도 자동 일치한다. |
| 2026-07-30 | **거래원 "외국계 합계" 행 `--bg-subtle` → `--bg-card` 환원** (#955 의 거래원 부분 되돌림, 사용자 결정) | #955 가 "구분선 최소화"(2026-07-22) 결정문의 "sticky 표 헤더/합계행(체결·거래원)" 문언을 따라 합계행을 `--bg-subtle` 밴드로 올렸으나, 실제 화면에서 거래원 창 안에 이 행만 배경이 다른 것이 사용자에게 이물감으로 읽혔다. 창 본문이 `--bg-card`(`DataWindow.tsx` 데이터 창 스크롤 컨테이너)이므로 합계행도 같은 값으로 되돌려 창 전체가 한 면이 된다. **`bg-` 클래스 자체는 제거하지 않는다** — 이 행은 `sticky bottom-0` 이라 배경이 투명하면 스크롤되는 거래원 행이 뒤로 비친다("패널 배경과 동일색이어야 평시에 투명" 계약, 2026-07-29 행과 동일 논리). **범위 밖**: 체결 창 열 헤더(`TradeTickTable`)는 `--bg-subtle` 밴드 유지 — 사용자 지적은 거래원 합계행 한정. 테스트가 `bg-bg-card` + `not.toHaveClass('bg-bg-subtle')` + `sticky` 를 못박는다. |
| 2026-08-04 | **소형 텍스트의 3차 색 `--fg-dimmer` → `--fg-dim` 승격 (142건/소스 71파일)** — 토큰은 비활성·장식 전용으로 축소 | 실측 대비가 **3.15:1(Obsidian) / 2.99:1(Ledger)** 로 WCAG AA 본문(4.5:1) 미달인데, **이 앱엔 AA 대형 텍스트 완화(18.66px bold/24px)를 넘는 본문 토큰이 없다** — `xs`(11.8px)·`sm`(12.9px)·`base`(14.6px) 가 전부 본문 판정이라 "3차 텍스트니까 괜찮다"가 성립하지 않았다. 게다가 DESIGN.md 는 이 미달을 관심종목 개수 **1곳만** 승인된 예외로 적어 뒀는데 실제로는 스크리너 파라미터 폼·워크스페이스 메뉴·히트맵 행·10호가 등 전면에 퍼져 **예외가 아니라 기본값**이었다. `--fg-dim` 은 6.73:1/5.68:1 로 양 테마 AA 통과. **승격 제외 4종**: (1) 비활성 요소 — WCAG 1.4.3 "Incidental" 예외가 비활성 컴포넌트를 빼 주고, 여기선 흐린 것이 *기능* 이라 올리면 비활성이 활성처럼 읽힌다, (2) 장식 글리프(`WindowFrame` 드래그 핸들 `⠿`) — 텍스트가 아니다, (3) `placeholder:` variant — 입력 힌트는 별도 축, (4) 비거래일 캘린더 셀(`baseColorVarFor`) — "선택 불가"를 색으로 말한다. **미해결로 남긴 것**: `--border` 1.20:1/1.29:1·`--border-strong` 1.71:1 이 WCAG 1.4.11(비텍스트 3:1) 미달 — 입력 경계가 사실상 안 보이지만 텍스트 축과 별개 문제다. |
| 2026-08-04 | **상단 nav + `/capture` 전면 한글화 — 앱 셸의 언어 이원화 해소** (사용자 결정: "상단 nav 를 한글로") | 상단 nav 는 100% 영어(`Live`·`Heatmap`·`Screener`…), 우측 레일은 100% 한글(`관심`·`히트맵`·`스크리너`…)이라 **같은 앱의 두 내비게이션이 언어가 갈려 있었고**, 무엇보다 `Heatmap`(상단)과 `히트맵`(레일)이 **같은 목적지를 다른 이름으로** 부르고 있었다. Copy tone 규칙상 영어는 도메인 식별자(`hogaplay`·`kis_live`·`EGW00201`) 몫이고 라우트 라벨은 거기 해당하지 않는다 → 라벨 8개를 한글로(`라이브`·`복기`·`히트맵`·`스크리너`·`옵션심리`·`보관함`·`캡처`·`설정`). **파급 2가지가 자동**: (1) `App.tsx` 의 `STATIC_ROUTE_TITLES` 가 `nav/items.ts` 에서 파생하므로 **브라우저 탭 제목이 함께 한글화**된다(별도 표 없음), (2) 반응형 바닥의 유도 근거였던 nav 자연폭 939px 이 stale 이 된다 → 재측정 710px, 토큰은 유지(위 Responsive floor 항목). 같은 규칙으로 `/capture` 도 정리 — `Symbol`/`Date Range`/`Today`/`▶ Start Capture`/`Cancel All`/`Retry Failed`/`Dismiss Done`/`Refresh & Resume`, 캘린더 범례 7개와 툴팁 11개, 월 이동 aria-label. `hogaplay`·`KIS`·`KRX` 는 도메인 식별자/고유명사라 **유지**. `Loading inventory…`/`Loading queue…` 는 로딩 어휘 최다수인 `불러오는 중` 으로 통일. e2e 셀렉터 6개 파일이 영어 문구로 버튼을 찾고 있어 함께 이관(24개 전부 통과). |
| 2026-07-30 | **잠정투자자 창 열 헤더(차수·외국인·기관·합산) `--bg-subtle` → `--bg-card`** — 위 거래원 결정의 연장(사용자 지적) | 같은 이유로 `/live` 잠정투자자 창에서도 헤더 행만 배경이 달라 보였다. 창 본문(`DataWindow.InvestorWindow` = `bg-bg-card`)과 같은 값으로 환원. **배경을 `thead`/`tr` 이 아니라 `th` 4개에 각각 주는 구조는 유지한다** — `border-collapse: collapse` 표에서는 `thead`/`tr` 에 준 배경이 sticky 헤더를 따라오지 않아 스크롤 시 행이 뒤로 비친다. 그래서 "밴드를 없앤다"가 `bg-` 클래스 삭제가 아니라 **값 일치**인 것은 거래원 합계행과 동일하다. 소비처는 `DataWindow` 하나뿐이라(`/study` 는 이 카드를 쓰지 않는다) 다른 배경 위에서 비칠 위험은 없다. 테스트가 4개 셀 각각에 `bg-bg-card` + `not bg-bg-subtle`, `thead` 에 `sticky` 를 못박는다. |
| 2026-08-04 | **`--border`/`--border-strong` 대비 인상 검토 → 현행 유지 (사용자 결정)** | 2026-08-04 UI 조사가 입력 경계 대비 미달(WCAG 1.4.11 비텍스트 3:1 기준 — strong 1.71:1 라이트/1.49:1 다크)을 지적. 입력·팝오버 전용 `--border-strong` 1단 인상안(Ledger #C9C3B2→#AFA792=2.33:1, Obsidian #33333C→#4A4A58=2.15:1)을 A/B 실측 이미지로 비교한 뒤 **현행 유지를 선택** — "분리는 톤+간격, 선은 조용하게"가 이 시스템의 방향이고(pane 구분선을 두 번 낮춘 전례), 단일 사용자 도구라 AA 준수 압력도 없다. 입력 어포던스는 배경(`--bg-input`)·포커스 accent 테두리가 담당. **재검토 트리거**: 입력을 못 찾는 실사용 불편이 실제로 관측될 때 — 그 전까지 조사 도구가 이 수치를 다시 지적해도 재론하지 않는다. |
| 2026-08-04 | **파괴적 액션 보호 사다리 명문화** (Components → Destructive actions) | 4패턴(즉시/인라인 2단/삭제유예+실행취소/ConfirmModal)이 문서 없이 혼재해 "누르기 전 예측 불가"로 지적됐다(2026-08-04 UI 조사). 지점별 실사 결과 배치 자체는 위험도와 일치 — 규칙 부재가 문제라 사다리로 명문화하고 `window.confirm` 금지를 못박았다. 판정 기준: 실수 복구에 드는 동작 수. |
| 2026-08-04 | **`text-[Npx]` 하드코딩 71곳 전량 토큰화 + `text-2xs`(base 9px) 신설** | 하드코딩 텍스트 크기는 `:root font-size` 밀도 다이얼을 이탈한다(미래 Compact/Cozy 에서 그 텍스트만 안 따라옴 — 2026-08-04 UI 조사 #4). 값 분포 실측: 10px×25·11px×20·10.5px×14·12px×6·9/9.5px×4·13px×1. badge(9.56 렌더)~xs(11.81 렌더) 사이 공백이 하드코딩의 원인이라 **`text-2xs`(base 9 → 렌더 10.125px)를 신설**해 10·10.5px 무리를 흡수(기존과 시각 등가, ±0.4px). 매핑: 9/9.5→badge · 10/10.5→2xs · 11→xs · 12/13→sm. **11↔12 는 같은 파일 3곳(타이틀바 등)에서 의도된 위계라 xs/sm 으로 분리 유지** — 근사 최단 매핑(둘 다 xs)이 아니라 위계 보존이 우선. 10↔10.5 공존 1곳은 이미 0.5px 차라 병합 무해. 도그푸딩 실측으로 12.94/11.81px 렌더 확인. |
| 2026-08-04 | **전역 `:focus-visible` 액센트 링 도입 (`global.css`)** | 색 규율은 focus ring 을 `--accent` 소유로 명시했지만 실제로는 `focus-visible` 처리가 8개 파일뿐, 나머지 표면 전부가 브라우저 기본 아웃라인이었다(계약 미이행). `/`·`[`·`]` 단축키가 있는 키보드 친화 도구라 전역 `:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px }` 한 블록으로 이행. `:focus` 가 아니라 `:focus-visible` 이라 마우스 클릭에는 링이 뜨지 않는다. inset(−2px)인 이유: 드로어·리스트의 `overflow-hidden` 조상 아래에서 바깥 링은 잘린다. 자체 focus 처리(`focus:outline-none`+ring)는 유틸리티 특이도가 높아 기존 동작 유지. |
| 2026-08-07 | **`/heatmap` 섹터 온도 밴드 축약 검토 → 현행 칩 클라우드 유지 (사용자 결정)** | UI 조사가 상단 밴드의 상시 세로 점유(실측 1680×1000 기준 칩 39개 4줄 = 87px = 뷰포트 9%)를 지적. `?variant=` 프로토타입으로 3안을 실데이터 위에서 A/B — **B** 양 끝단 5+5·나머지 접기(35px) · **C** 종목 수 비례 연속 온도 띠(36px) · **D** 접힌 요약 한 줄(35px). 세 안 모두 세로 60%를 회수하지만 **현행 유지를 선택**. 프로토타입이 확정한 사실 두 가지: (1) **C 계열의 세그먼트 라벨은 원리적으로 불가능** — 39섹터를 1680px 에 나누면 세그먼트 폭 중앙값 45px·60px 이상 3개뿐이라, 지분 임계를 낮춰도 라벨이 3~4글자로 잘린다. C 를 다시 꺼낸다면 라벨을 버리고 hover/클릭 전용이어야 하며 대가는 섹터 카드 wayfinding 상실. (2) 세 안의 회수량이 사실상 동일(35~36px)해 **회수량은 변별점이 아니다** — 판정축은 "접은 것을 얼마나 자주 펼치는가"다. 전체 변형은 throwaway 브랜치 `prototype/heatmap-sector-band-2026-08-07`(커밋 `c9cee0a8`)에 1차 출처로 보존. **재검토 트리거**: 섹터 수가 크게 줄거나(≲20) 칩이 5줄 이상으로 늘어날 때 — 그 전까지 조사 도구가 이 점유율을 다시 지적해도 재론하지 않는다. |
| 2026-08-07 | **`borderRadius.DEFAULT` 누락 복구 — bare `rounded` 143곳이 토큰 밖 4.5px 였다** | `tokens.generated.ts` 가 `sm/md/lg/full` 만 주입하고 **`DEFAULT` 키를 안 냈다** → Tailwind 가 자기 기본값 `0.25rem` 으로 채웠고, root 18px 이라 **4.5px** 로 렌더됐다. 피해 둘: ① 토큰 밖 5번째 반경이 생겨 한 화면에 4px·4.5px·6px 이 공존(실측 `/screener` 버튼 28개에 (반경×높이) 조합 13종, `/heatmap` 은 4.5px 39개와 0px 40개) ② rem 기반이라 **고정 px 이어야 할 값이 밀도 다이얼을 따라 움직였다**(ADR-0011 위반 — root 22px 로 밀면 4.5→5.5px). `design-tokens.ts` 에 `isDefault` 플래그를 두고 생성기가 "정확히 하나" 를 강제하도록 해 복구. **값은 `md`(4px)** — 143곳이 이미 4.5px 로 렌더 중이라 `md` 는 0.5px(시각 등가), `lg` 는 +33%(전 화면 재스타일)다. `text-2xs` 결정(2026-08-04)과 같은 원칙: **구멍은 이미 화면에 있는 값으로 막고, 누수 수정의 부산물로 앱을 재디자인하지 않는다.** `radius-lg` 의 "(default)" 주석은 `md` 로 이관. 덤으로 값이 완전히 같던 임의값 6곳(`rounded-[4px]`×2→`md`, `rounded-[6px]`×4→`lg`)을 토큰화 — 특히 후자는 주석이 "ModalShell 반경에 맞춰"라고 적힌 채 **숫자로만 결합**돼 있었다. `rounded-xl`(13.5px, 다이얼 추종) 2곳도 함께 `lg` 로 — 종목 검색 팔레트인데, **트리거 버튼(`bg-bg-input rounded-lg`)을 눌러 열면 같은 검색 입력면이 13.5px 로 바뀌고** 결과 행은 이미 `rounded-lg` 였다(한 컴포넌트 안에서 갈림). 컨테이너도 `role="dialog"`+`shadow-modal`+`border-border-strong`+`bg-bg-card` 로 `ModalShell` 과 구조가 같은데 **앱에서 유일하게 13.5px 인 다이얼로그**였다. 실측 검증: 4개 라우트 231개 버튼에서 4.5px **0건** · root 22px 에서도 반경 불변 · **빌드 CSS 전수에 rem 기반 반경 0개**(`.rounded`→`var(--radius-md)`, `.rounded-t-md`·`sm`·`md`·`lg`·`full` 전부 토큰). 나머지 임의 반경 12곳도 최근접 토큰으로 스냅(사용자 결정): `[7px]`×5 툴바 알약 4종→`lg` · `[3px]`×2 BookPanel 배지→`sm` · `[1px]`×4 헤어라인→`sm` · `[6px]`×1→`lg`. `[3px]` 은 `sm`(2)·`md`(4) **등거리**라 위계로 갈랐다 — BookPanel 이 이미 `rounded-md` 를 쓰고 있어 배지를 `md` 로 올리면 파일 안 2단이 뭉개진다(`text-2xs` 때의 "위계 우선" 규칙). `[1px]`→`sm` 의 시각 영향은 실측했다: **2px 두께 막대에서 r=1px 와 r=2px 는 픽셀 동일**(CSS Backgrounds §5.5 — 한 변의 반경 합이 변 길이를 넘으면 비례 축소, 2+2>2 → ×0.5 → 1px). 두꺼워지는 경우(스플리터 hover `w-1`, vdist 막대)만 모서리가 1px 더 깎인다. ⚠️ 마지막 `[6px]` 1곳(`live/workspaceDrawer.ts`)은 **`--include='*.tsx'` 스캔 밖이라 1차에서 놓쳤다** — 반경/토큰 스윕은 `.ts` 까지 훑을 것(2026-08-04 `--fg-dimmer` 스윕이 같은 데 걸렸다). **영구 차단까지 완료(사용자 결정)**: `tailwind.config.ts` 에서 borderRadius 만 `extend` 밖으로 빼 **`theme.borderRadius` 로 교체**했다 — `extend` 는 Tailwind 기본 스케일과 *병합*이라 `xl`(0.75rem)·`2xl`·`3xl` 이 해석 가능한 채로 남고, 누가 한 번 쓰면 rem 누수가 재발한다(실제로 그 구멍으로 `rounded-xl` 이 검색 팔레트에 들어왔었다). 교체의 전제 조건 하나: **스케일에 없는 키는 에러가 아니라 CSS 미생성**이라 `radius-none` 토큰을 먼저 신설해야 했다 — 없으면 `rounded-none`·`rounded-r-none` 이 조용히 사라져 `BookPanel` 의 **한쪽만 둥근 잔량 바가 양쪽 다 둥글어진다**(무경고 시각 버그). 검증은 빌드로 했다: 임시 파일에 `rounded-xl`·`2xl`·`3xl` 을 **명시적으로 쓴 뒤 빌드했더니 셋 다 CSS 에 나오지 않았고**, `rounded-none`·`-r-none`·`-t-md` 는 전부 살아 토큰으로 해석됐다. 최종 실측: 전 반경 유틸이 root 18px·22px 에서 **동일**(다이얼 이탈 0), `rounded-md rounded-r-none` = TL/BL 4px·TR/BR 0px 정상. 결과적으로 앱 전체 반경이 `0 / 2 / 4 / 6 / full` **5단으로 폐쇄**됐다 — 새 단이 필요하면 임의값이 아니라 design-tokens.ts 에 추가해야 하고, 그게 이 교체의 요점이다. |
| 2026-08-07 | **테마 기본값 `auto` → `toss-light` + 첫 페인트 부트스트랩 동기 버그 수정 (사용자 결정)** | `auto` 는 테마를 **라우트마다** 고른다(`/live`·`/heatmap`·`/market`=Obsidian, 나머지=Ledger). 그래서 상단 nav 를 **한 번 누르는 것**(히트맵→스크리너)이 화면 전체를 다크↔라이트로 뒤집었다. 명시적 기본값은 라우트 분기를 통째로 없앤다 — 한 테마로 고정. `auto` 는 설정에 옵션으로 남는다. **대가는 문서화·수용**: Toss Light 의 accent 와 `--price-down` 이 둘 다 파랑이고, 실측 지각 거리 **ΔE 17.3** 으로 Ledger(80.8)·Obsidian(139.2)의 약 1/5 이다. 분리는 관례가 떠받친다 — accent 는 솔리드 채움(버튼·활성탭·포커스·크로스헤어), 하락색은 텍스트·테두리. 이 충돌이 이제 옵트인이 아니라 **기본 경험**이므로 두 토큰을 건드리기 전에 위 Toss Light 노트를 볼 것. 함께 고친 **기존 버그**: `index.html` 부트스트랩이 `effectiveTheme` 와 이미 어긋나 있었다 — `OBSIDIAN_ROUTE_PREFIXES` 가 `/market` 을 얻었는데 부트스트랩 목록은 안 따라가서, `auto` 로 `/market` 에 진입하면 **ledger 로 칠했다가 obsidian 으로 뒤집혔다**(그 블록이 막으려던 FOUC·잘못된 테마 차트 캐시 그 자체). 기존 테스트도 `/market` 을 단언하지 않아 **커버리지 구멍이 드리프트 위치와 정확히 일치**했다. 부트스트랩은 모듈 그래프보다 먼저 돌아야 하므로 복제를 없앨 수 없다 → **`themePrefs.test.ts` 가 `index.html?raw` 를 파싱해 기본값·라우트 맵·허용 선호값 3가지를 대조**하고 이탈하면 실패한다. 가드는 4가지 이탈 시나리오로 역실험해 전부 잡는 것을 확인했다(첫 시도는 3항 연산자 기본값을 놓쳐 통과했다 — **통과하는 가드는 아무것도 증명하지 않는다**). **재검토 트리거**: 장중 `/live` 10호가에서 파란 크로스헤어가 파란 하락 잔량 위에 겹쳐 읽기 어려우면 — 장 마감 상태라 그 표면은 이번에 확인하지 못했다. |
| 2026-08-07 | **`/live` 툴바에 거래소 선택기 신설 — 트리거가 현재 값 + 세션 창을 인다 (`거래소 통합 08:00–20:00`), 팝오버로 선택 (사용자 결정)** | venue 상태(`live.venue.v1`)는 이미 전역이었고 관심종목·히트맵·타이틀바가 읽고 있었는데, **변경 수단이 설정 모달 → 데이터 소스 → 거래소 라디오 하나뿐**이라 클릭 4번 깊이에 묻혀 있었다. `?variant=` 4변형을 실데이터 위에서 A/B — **A** 현행 · **B** 툴바 상시 세그먼트 `KRX│NXT│통합` · **C** 요약 pill + 팝오버 · **D** TopNav 전역 배지 + `V` 키. **판정 C**(조합 요구 없음). 프로토타입이 확정한 사실: (1) **판정축은 클릭 수가 아니라 "세션 창이 고르기 전에 보이는가"** 다 — 전환의 실제 비용은 x축이 09:00–15:30 → 08:00–20:00 으로 리플로우되고 NXT 호가 공백 경고가 붙는 **뷰 전체의 교체**이고, 그걸 미리 알리는 정도가 C(선택지마다 병기) > B(`title` 툴팁뿐) > D(없음) 로 갈렸다. (2) **툴바에 앵커되는 팝오버는 body 포털이어야 한다** — `WorkspaceToolbar` 의 `backdrop-blur` 가 `position: fixed` 의 컨테이닝 블록 겸 스택 컨텍스트를 만들어 `left/top` 이 툴바 기준으로 잡히고 `z-50` 도 툴바 안에서만 유효하다(**DOM 엔 있는데 화면엔 없음**; absolute 는 애초에 `overflow-x-auto` 에 잘린다). (3) 포털 패널은 `useDismissablePopover` 의 anchor-contains 예외 밖이라 `onMouseDown` 전파를 끊어야 한다 — 안 끊으면 mousedown 이 먼저 닫아 그 버튼의 click 이 영영 안 온다. **차트 창 헤더는 후보에서 제외**(#759 결정 1 — 앱 전역 값을 창 헤더에 두면 "이 창의 설정" 으로 읽힌다). 설정 모달의 「거래소」 라디오는 **유지** — `DataSourceDetail` 이 /study 도 렌더하고 거기엔 이 툴바가 없다. 전체 변형은 throwaway 브랜치 `prototype/live-venue-control-2026-08-07`(커밋 `2d6932e6`)에 1차 출처로 보존. **재검토 트리거**: 거래소가 4개 이상으로 늘거나, 툴바 폭이 좁아져 pill 라벨의 세션 창이 잘릴 때. |
| 2026-08-07 | **기본 밀도 1.125×(18px) → 1.0×(16px) — 백로그의 "Compact" 도달 (사용자 요청: 전체 UI 폰트 1–2px 축소, 안 A 선택)** | 요청은 "폰트"였고 대안 두 개를 제시했다 — **A** 다이얼 하향(폰트+간격+레이아웃 동시 −11%) · **B** `text-*` 토큰만 축소(글자만 작아지고 여백 유지 → 더 헐거워짐). 사용자가 A 선택. 다이얼 한 값으로 끝난 이유는 2026-08-04 스윕이 `text-[Npx]` 하드코딩 71곳을 전량 토큰화해 뒀기 때문이다 — **다이얼 밖으로 새는 타이포가 0곳**이라 `RENDERED_ROOT_PX` 18→16 + `npm run gen:tokens` 로 전 표면이 따라왔다(본문 14.63→13 · 표 행 12.94→11.5 · 헤딩 15.75→14 · 마이크로라벨 10.13→9). 도그푸딩 실측으로 root 16px·토큰 8개 전부 base intent 일치 확인. **부수 변경 3건**: ① `rightOffset` 이 다이얼 파생이라 14→12 bars(차트 우측 여백), ② 반응형 바닥이 rem 이라 1026→912px(셸이 114px 더 압축된 뒤 멈춤 — 밀도가 낮아졌으니 의도된 결합), ③ 헤더 접힘 임계 재측정(아래). **다이얼을 내리면 "px 를 손으로 박은 자리" 가 전부 드러난다** — 이번에 셋이 걸렸다: (1) `HIGHLOW_FONT_PX = 11.8` 은 `--text-xs × 18` 을 손계산한 캔버스 상수라 다이얼을 따라가지 못했다 → 파생식으로 교체, (2) 차트 헤더 접힘 임계(424·258·303·202·104)는 전부 1.125× 실측 px 라 그대로 두면 **라벨이 들어갈 폭에서도 접히는 무성 회귀** → `/browse` 로 #905 절차 재측정, (3) `chartScale.test.ts` 의 `not.toBe(round(12 × DENSITY))` 는 DENSITY=1 에서 핀 값 12 와 파생값 12 가 붕괴해 **항상 빨간 단언**이 됐다 → 밀도 조건 뒤로 물려 다이얼이 1 이 아닐 때 자동 부활(가드 red-check 실측 완료). **재측정이 stale 상수 하나를 덤으로 잡았다**: 2단계 임계 주석의 "213px" 는 **2버튼 시절 값**이었다(git 확정 — 213 을 쓴 #763 이 저장·수집 버튼을 더한 #767 의 조상). #767 은 1단계만 344→424 로 고치고 2단계는 방치했다 — *바로 그 실수를 경고하는 문장을 같은 파일에 쓰면서*. 무증상이었던 이유는 임계 258 이 4버튼 실요구 254.25 위 3.75px 여유로 **우연히** 살아 있었기 때문이다. 새 실측(1.0× / 30분 라벨): `/live` 펴짐 382 → 임계 **384**, 1단계접힘 235 → **240**; `/study` 272 / 185 / 98. 절차 검증은 **옛 밀도 동시 측정**으로 했다 — 같은 방법을 root 18px 로 돌리니 414.25 / 300.75 / 201.75 / 104.25 가 나와 기록된 415 / 303 / 202 / 104 를 1px 안에서 재현했다. **비례 환산은 쓰지 않았다**: 실측 비율이 0.904 로 ×0.889 와 달라 환산했으면 6px 틀렸을 값이고, 이 파일은 이미 3px 차로 무성 잘림을 낸 전례를 갖고 있다. **함정 하나가 새로 생겼다(문서화함)**: 1.0× 에서는 토큰 표의 base-intent 열과 렌더 열이 **같은 값**이라, `text-[10.5px]` 같은 하드코딩이 오늘은 아무 증상을 안 낸다. 1.125× 시절엔 즉시 어긋나 보이던 실수가 이제 **다이얼이 다시 움직일 때까지 잠복**한다 — 규칙(임의값 px 금지)은 그대로지만 근거가 "값이 다르다" 에서 "값이 같아 보이는 건 우연이다" 로 바뀌었다. 비선형 지점 하나는 남겨 두고 경고를 달았다: `/heatmap` 캔들 셀은 배정(rem)이 줄어도 분자의 `CandleGlyph` 폭이 고정 px 라 여유가 4px→2.39px 로 잠식됐다(실측 30.39 ⊃ 10+2+16=28). `overflow-hidden` 이라 넘쳐도 조용히 잘리므로, **다음 한 칸을 내리려면 여기부터 실측**해야 한다. |
| 2026-08-14 | **시간외 10호가 창 — 격자는 10단 그대로, 채워지는 행만 줄인다 (사용자 결정)** | 15:30 이후 KRX-only 종목의 호가가 얼어붙는 문제에 두 소스를 붙이면서 생긴 표시 결정이다. 벤더가 주는 것이 시간대마다 달라 **화면이 세 모습**을 갖는다: 정규장 10단 · 15:40–16:00 은 사다리 없이 **총잔량 두 개만**(WS `0E`) · 16:00–18:00 은 **5단**(REST `ka10087`). 후보는 **A** 시간외엔 격자를 5단으로 접기(창 높이가 줄고 두 시각이 안 섞임) · **B** 10단 격자 유지하고 중앙 쪽 5행만 채우기. **사용자 선택 B** — 레이아웃이 시간대마다 흔들리지 않는 쪽. 대가는 B 의 알려진 약점이다: **빈 5행이 "데이터 결손"으로 읽힐 수 있다.** 그래서 하단 총잔량 스트립의 조건부 라벨(`시간외` / `시간외 단일가`)이 **장식이 아니라 그 모호함을 해소하는 유일한 장치**가 된다 — 라벨 없이 값만 갈아끼우면 안 된다. 15:40–16:00 모드에는 함정이 하나 더 있다: 사다리는 15:30 정규장 마지막 스냅샷이고 총잔량만 시간외 값이라 **둘의 합이 안 맞는 것이 정상**이다(출처와 시각이 다르다). 구현상 5단은 10칸으로 zero-pad 해서 넣는다 — 정규장에서 짧은 book 이 오는 경로와 같아 격자 로직은 무변경이다. 근거·실측은 `docs/research/2026-08-14-kiwoom-after-hours-orderbook-sources.md`. **재검토 트리거**: 벤더가 시간외 단일가 호가를 5단 넘게 주기 시작하거나, 빈 5행을 결손으로 오해한 문의가 실제로 나올 때. |
| 2026-08-09 | **워크스페이스 창 가장자리 accent 바 삭제 — 리사이즈 어포던스를 커서로만 남긴다 (사용자 결정)** | `WindowFrame` 코어의 변(edge) 핸들 안에 있던 2px `bg-accent` 막대(평상시 `opacity-0`, 호버 시 `opacity-80`)를 없앴다. 이로써 **2026-07-15 에 세운 "스플리터 리사이즈 라인은 평상시 숨김, 호버/드래그 시 `--accent` 로만 노출" 규칙이 폐기**된다(위 본문에 History 주석으로 남김). 계기: 사용자가 `/live` 차트 창 가장자리의 색 선을 시각 소음으로 지목했다. **기능은 불변** — 8방향 히트박스(모서리 12×12, 변 8px)와 `cursor-*-resize` 가 그대로라 리사이즈·스냅 동작은 같고, 사라진 것은 "여기를 잡을 수 있다" 를 **미리** 알려주던 힌트뿐이다. 어포던스가 커서에만 남는 설계의 비용은 **처음 보는 사람에게 기능이 은폐된다**는 것이고, 이 앱은 단일 사용자라 그 비용이 사실상 0 이라는 판단이다 — 다중 사용자 표면에 같은 패턴을 복사하지 말 것. 바가 없어져 변·모서리 핸들이 동형이 됐으므로 `EDGE_HANDLES`/`CORNER_HANDLES` 두 배열을 `RESIZE_HANDLES` 하나로 합쳤다(`bar` 필드와 `group/handle` 유틸리티도 함께 소멸). **범위 주의**: 이 파일은 코어라 `/live` 와 `/study` 창에 **동시 적용**된다. 창 **이동** 중 뜨는 `WorkspaceCanvas` 의 2px accent 스냅 정렬선은 **남긴다** — 리사이즈가 아니라 정렬 피드백이라 축이 다르다. |
| 2026-08-18 | **프로그램 순매수 pane 에 값 레전드 행 추가 + 축 최신값 칩 끄기 — 2026-05-23 규칙으로 복귀 (사용자 결정)** | 이 pane 만 `lastValueVisible: true` 라 규칙에서 벗어나 있었는데, 조사해 보니 **규칙의 전제가 여기서만 깨져 있었다**: 근거인 "analysts read latest values via crosshair" 가 성립하려면 크로스헤어로 값을 읽을 수 있어야 하는데, 프로그램은 `LEGEND_CELL_PANES` 밖이라 레전드 값 행이 꺼져 있었고 그 필터는 **크로스헤어 유무와 무관하게 행 자체를 거른다**(실측: 크로스헤어를 올려도 레전드에 뜨는 것은 OHLC·이동평균선·거래량 셋뿐). 축 칩은 그 구멍을 메우던 것이었다. 그래서 **구멍 쪽을 막았다** — 화이트리스트에 `program-trade` 를 넣어 레전드 행을 되살리고 축 칩을 껐다. 2026-07-22 에 전 pane 을 숨긴 결정의 동기는 **캔들 pane** 의 밀집도였고(MA·flag 칩 6줄), 자기 pane 에 홀로 그려지는 cells 행은 부수 피해였다 — 2026-08-04 의 거래량·총잔량 복원과 같은 성격의 연장이다. **둘 다 켜는 안은 기각**: 축 칩은 SSE 재투영을 따라 거의 실시간이고 레전드 latest 는 캔들 epoch 주기라, 장중에 같은 시리즈가 서로 다른 두 숫자로 보인다(레전드 5,100억 / 축 5,128억). **대가**: 커서를 올리지 않은 상태의 값이 epoch 주기(≈캔들 1개)만큼 stale 해진다 — 거래량 누적이 2026-08-04 부터 이미 같은 상태이고, 정확한 지금-값은 크로스헤어로 읽는다는 규칙 그대로다. idle 실시간이 필요해지면 `dataEpoch` 에 호가 번들을 넣지 말 것(P1 이 제거한 틱당 O(N) 리드백이 부활한다) — 원시값 타겟 구독(`LiveCurrentPriceLine` 패턴)이 기록된 경로다. **남은 비대칭**: 호가비·체결강도·투자자는 여전히 레전드가 없다. 이들은 축 칩도 없어 "크로스헤어로만" 이 일관되게 성립하므로 이번 범위 밖이다. |
| 2026-08-21 | **설정·보조지표 패널을 우측 드로어 → 중앙 모달로 되돌림 (사용자 결정)** — `live/workspaceDrawer.ts` → `workspacePanel.ts` 리네이밍 동반 | 2026-07-16 항목(중앙 모달 → 우측 드로어)을 **뒤집는다**. 그때의 폐기 사유는 "즉시 적용인데 1040×820 중앙 모달이 차트를 덮어 효과를 볼 수 없다" 였으므로, 되돌리기 전에 **시안 4종을 실데이터(삼성전자 1분봉·1600×1000) 위에서 A/B** 했다 — 현행 드로어 · **A 중앙 모달** · B 중앙 비모달 플로팅(딤 없음, 차트 클릭 가능) · B+ B와 드래그. **판정 A**(사용자). 프로토타입이 확정한 실측: (1) **딤은 눈이 아니라 픽셀로 갈린다** — 흰 배경 255 기준 드로어 178 / 모달 127 / 비모달 255 였는데, 축소된 스크린샷에서는 A 와 B 가 거의 같아 보였다. (2) **"뒤쪽 차트를 만질 수 있는가"의 결정적 측정은 `elementFromPoint`** 다 — B 에서만 `CANVAS` 를 반환하고 드로어·모달은 백드롭 div 를 반환한다. 바깥클릭 닫힘도 **양방향**으로 쟀다(드로어·모달 닫힘 ↔ B 안 닫힘) — 한 방향만 봤으면 "항상 안 닫힘" 하드코딩도 통과했다. **수용한 비용**: 딤 50% 가 차트를 덮고 바깥클릭이 패널을 닫는다(= 2026-07-16 이 지적한 그 성질). **흡수한 비용**: 보조지표 nav 16항목의 요구 높이가 실측 903px 인데 드로어는 풀하이트라 그냥 보였다 — 중앙 카드는 높이를 스스로 정해야 하므로 `h-[min(960px,86vh)]` 로 두어 **세로 ~1120px 이상 화면에서는 스크롤이 사라지고** 그 아래에서만 클램프된다(고정 px 하나면 큰 화면의 여유를 못 쓰고, vh 하나면 초대형 화면에서 카드가 쓸데없이 길어진다). 설정 패널은 8항목이라 애초에 스크롤이 없다. **가드의 비대칭을 이번에 메웠다**: 배치를 통째로 바꿨는데 빨개진 것은 `App.test.tsx` 2건뿐이었고 **지표 패널 쪽에는 앵커 가드가 아예 없었다**(72개 전부 초록). 이제 두 테스트가 각각 중앙 앵커 + **같은 폭·높이 상수**를 단언하므로 한쪽이 하드코딩으로 이탈하면 빨개진다 — red-check 은 `side='right'` 되돌림과 높이 하드코딩 두 방향 모두 실측 확인했다. `ModalShell side='right'` 는 **앱 소비자가 0 이 됐지만 코드·테스트를 남긴다**(되돌릴 여지). **재검토 트리거**: 세로 1000px 이하 화면에서 보조지표 nav 스크롤이 실제로 거슬릴 때 — 그때는 카드를 키우는 게 아니라(요구 903px 은 화면을 거의 채운다) nav 그룹 접기를 검토할 것. **⚠ 2026-08-26 에 이 트리거가 소멸했다**: 단일 리스트 전환으로 nav 요구가 903+푸터 → **707px** 이 되어 임계가 세로 ~1,170px → **~830px** 로 내려갔다(아래 항목). 여기 적힌 903px 은 그 시점의 실측으로만 읽을 것. |
| 2026-08-23 | **`--h-live-header` 토큰 삭제 — 이 표의 첫 토큰 제거** | `/study` 폐지(ADR-0157) 후속으로 소비자 `WorkspaceShell.WorkspaceHeader` 가 사라져 **소비처 0** 이 됐다. 지우면서 확인된 사실 하나: 그 마지막 소비처마저 `min-h-12`(3rem = 48px @ 1×)를 얹고 있었으므로(`min-height` 가 인라인 `height` 를 이긴다) **이 토큰은 한 번도 화면 높이를 정한 적이 없다**. 즉 삭제의 시각적 영향은 0 이다. `npm run gen:tokens` 로 `tokens.css`·`tokens.generated.ts` 재생성(손으로 고치지 않는다). |
| 2026-08-23 | **`/study`(복기) 라우트 폐지 — 상단 메뉴가 8개 → 7개 (사용자 결정, ADR-0157)** | 저장뷰는 이제 `/live` 차트 창에서 열린다. 화면에서 사라지는 표면: nav 항목 「복기」 · 그 페이지의 워크스페이스·메모 창·레이아웃 프리셋 메뉴. **남는 표면은 그대로**다 — 우측 레일 「저장뷰」 패널은 nav 짝 없이 레일 버튼으로 열고, 차트 창의 저장 버튼·저장 구간 밴드·착석 칩은 무변경. 부수 효과 둘: 「당일 최고 수평선」 토글이 저장 구간 창에서도 보이고(페이지로 가르던 게이트 제거), 저장뷰 행 하이라이트가 여럿 → 하나가 된다(출처가 그룹 맵 → 기간 슬롯). |
| 2026-08-23 | **Pane Legend 가 지표 설정 변경에 한 박자 늦던 것 수정** | flag provider 는 **비반응형 레지스트리**에 있다(P1: SSE 틱마다 레전드가 재렌더되는 것을 막는 장치). 그래서 provider 값이 달라져도 **오버레이가 다시 렌더될 때**에만 읽힌다. 그런데 이 오버레이는 스토어 토글(`useWindowIndicator`)만 구독하고 **chartPrefs 는 구독하지 않아**, 지표 설정을 바꾸면 선·마커는 즉시 갱신되는데 **레전드만 다음 상호작용(크로스헤어·팬·토글)까지 옛 값**을 보였다. 실측 증상: 매수 최대벽의 MA 필터를 끄면 빨간 선 3개와 화살표가 즉시 나오는데 레전드는 이름만 남아 있었고, 눈 토글 같은 **무관한 조작**을 해야 채워졌다. 처방은 `useScopedChartPrefs()` 를 **값 없이 구독만** 하는 것(`void`). 전체 구독이 안전한 근거: chartPrefs 의 쓰기 경로가 **설정 UI 뿐**이라(실측 4곳) 사용자 조작 빈도이고, P1 이 막은 비용(SSE 틱당 재렌더)을 되살리지 않는다. 반환값은 상태 객체당 memo 된 안정 참조라(`prefsForScope` WeakMap) 렌더마다 새로 구독되지도 않는다. ⚠ **레지스트리를 반응형으로 바꾸는 것은 여전히 금지다** — 그건 P1 을 정면으로 되돌린다. 고친 것은 「언제 다시 읽는가」뿐이다. |
| 2026-08-23 | **팬 프레임마다 `LiveChartRoot` 를 통째로 재렌더하던 두 경로 제거** | `setVisibleTimeCutoff` 가 시간범위 변화마다 setState 를 했다. 문제가 **둘**이었다. **① 무조건 구독**: 그 값은 「보이는 최신 봉 기준」 pref 가 꺼져 있으면 통째로 버려지는데, 두 pref 의 **기본값이 둘 다 false** 라 대다수 사용자가 아무 이득 없이 훅 수백 개짜리 컴포넌트의 재렌더 비용을 내고 있었다 → 한쪽이라도 켜졌을 때만 구독한다. **② 새 객체 identity**: `rightmostVisibleCandleCutoff` 는 호출마다 새 객체를 내므로, 오른쪽 끝 봉이 **그대로여도** 재렌더가 났다 → `nextVisibleTimeCutoff` 가 같으면 이전 참조를 돌려주고 React 가 `Object.is` 로 그 갱신을 버린다. **실측**(삼성전자 1분봉, 30프레임 조작): 줌(오른쪽 끝 고정) 이벤트 31건 중 끝 봉이 달라진 것 **1건** — ②가 31 → 1 로 줄인다. 좌측 팬은 끝 봉이 실제로 움직여 12/10 · 31/29 라 ②의 몫이 작고, 그 경우엔 ①이 기본 설정에서 **전부** 없앤다. 비교를 순수 함수로 뗀 이유: 「참조가 보존되는가」를 컴포넌트 없이 `toBe` 로 재야 한다 — 호출부에 인라인으로 두면 그 비교를 지워도 아무 테스트도 빨개지지 않는다. |
| 2026-08-23 | **당일 최대벽 렌더를 단일 소스로 — 계산 호출부 6곳 → 1곳** | 같은 계산이 여섯 곳에서 각자 돌았고(선 오버레이 2 · 도킹 라벨 2 · 고저 라벨 회피 2), 「이 지표가 지금 그려지는가」가 **네 가지 표기**로 손으로 적혀 있었다. 넷이 우연히 일치했을 뿐 일치를 강제하는 것이 없었고, **실제로 하나가 어긋나 있었다**: **회피 경로만 `allPriceRankLimit` 을 안 넘겨 기본값 1 로 돌고 있었다** — 「체결된 벽 표시 개수」를 2·3 으로 둔 사용자는 그날 2·3번째 벽이 그려지는데도 고저 극값 라벨이 그것들을 피하지 않았다. 인자 하나가 빠진 것이라 타입이 못 잡는다. `usePeakWallRender` 훅 하나가 계산과 게이트를 소유하고, 표면 셋은 **같은 참조**를 받아 자기 플래그만 읽는다. ⚠ **불변식**: `segments` 는 `enabled` 기준으로만 계산한다 — 눈(hidden)으로 숨겨도 레전드는 값을 유지해야 하므로(MA 규칙). 무엇이 그려지는지는 `drawn`/`labels`/`arrows` 플래그가 말한다. 계산이 컴포넌트 밖으로 나오면서 이 규칙의 집도 훅으로 옮겼고, 그 자리에 red-check 가드를 뒀다. 덤: 매도·매수 오버레이가 **한 컴포넌트**가 됐고(`LivePeakWallSegments`, side prop), 봉 극값 맵을 두 벌 만들던 것도 한 벌로 합쳤다. 컴포넌트 576줄 → 331줄, 초기 로드 raw −2.5 KB. |
| 2026-08-23 | **매도 최대벽 오버레이의 팬·줌 재계산 제거 (죽은 구독)** | `LiveAskPeakSegments` 가 `visibleLogicalRangeChange` 마다 세그먼트를 **통째로 다시 만들고** 있었다. 그 구독의 근거는 「보이는 영역 최대벽」 강조가 update 시점에 `getVisibleRange()` 를 읽는 것이었는데, 그 강조가 사라지면서 **이 계산에서 보이는 범위를 읽는 곳이 하나도 남지 않았다** — 유일한 범위 의존 입력인 `visibleTimeCutoff` 는 prop 이고 그 구독은 `LiveChartRoot` 에 따로 있다. **판별식은 비대칭이었다**: 매수 오버레이엔 이 구독이 애초에 없었고 그래서 잘 돌았다 — 같은 계산인데 한쪽만 구독한다면 그 구독은 필요 없거나 반대쪽이 틀린 것이고, 여기선 전자였다. 팬에 따라가야 하는 것들(레전드 셀 · 순위 화살표 · 고저 라벨 회피)은 전부 **draw 시점 랭킹**이라 구독과 무관하다. ⚠ 범위를 읽는 입력을 다시 넣으면 구독도 되살려야 한다 — 가드 테스트가 그때 뒤집힌다. |
| 2026-08-23 | **당일 최대벽 매도·매수 빌드 계층 통합 — 169줄 바이트 동일 중복 제거** | `LiveAskPeakSegments` 와 `LiveBidPeakSegments` 의 순수 계층이 **정규화 diff 로 169줄 바이트 동일**이었다(`expandBaselinePeaks` 40줄과 `buildXPeakOverlaySegments` 39줄은 **함수 이름 한 줄만** 달랐다). `peakWallSegments.ts` 한 벌로 합친다. **중복 자체보다 그것이 가린 것이 문제였다** — 매수의 「보이는 영역 최대벽」 노브가 강조 색 없이 한 달 넘게 살아 있었는데, 169줄이 똑같으니 눈이 "이 둘은 같다" 로 미끄러져 아무도 못 봤다(당일 두 PR 에 걸쳐 이 파일들을 고치면서도 기계적 diff 를 돌리기 전엔 못 봤다). **side 인자를 두지 않는다**: 방향은 이미 호출자가 넘기는 데이터와 필터 안에 있다(`PeakMaFilter` 가 자기 side 를 들고 다닌다). 방향이 실제로 갈리는 것은 **그리기뿐**이라 화살표 계층만 side 를 받는다. ⚠ `applyPeakVisibleTimeCutoff` 의 `side` 인자는 본문이 `void options.side` 로 **버리고 있었다** — 그 죽은 인자가 두 호출부를 텍스트상 다르게 만들어 「같은 계산인데 달라 보이게」 한 원인 중 하나였다(함께 제거). `AskPeakSegment` → `PeakWallSegment` 개명도 같이 했다(매수도 쓰는 타입이 매도 이름을 달고 있었다). **남은 것**: primitive 클래스 이름(`AskPeakSegmentsPrimitive`)은 20개 파일이 참조해 순수 churn 이라 별도로 두고, 세그먼트 **계산 호출부 6곳**(오버레이 2 · 도킹 라벨 2 · 회피 2)의 단일 소스화는 다음 단계다. |
| 2026-08-23 | **「보이는 영역 최대벽」 색 강조 제거 — 매도·매수 모두 (사용자 결정)** | 같은 날 들어간 순위 화살표가 이 채널을 **중복으로 만들었다**: 레전드의 ①②③ 과 캔들 밖 화살표 ①②③ 이 「화면에서 가장 큰 벽」을 **순위까지 정확히** 나르는데, 색 강조는 같은 정보를 「상위 N 개 중 하나」 라는 덜 정밀한 형태로 반복했다. 채널 하나를 통째로 줄인다(캔들 pane 은 이미 급증 마커 ▼/▲ · 도킹 라벨 · 점 · MA 선이 겹치는 곳이다). **계기는 매수 쪽의 죽은 노브였다** — 「보이는 영역 최대벽 표시 개수」가 매수 설정에 있는데 강조 색이 존재한 적이 없어 아무 시각 변화도 없었다(`08f29fc1` 이 Ask/Bid 양쪽 config 에 노브만 대칭으로 넣고 매수 렌더링 절반은 만들어진 적이 없다). 고치는 길이 「대칭 완성」과 「제거」 둘이었고 **둘 다 아닌 「양쪽 제거」**가 선택됐다. ⚠ 그 노브는 무동작이 아니었다 — `maxPeakRankLimit(하루개수, 강조개수)` 를 통해 **하루 안 벽 생성 개수**를 늘리고 있었다(오표기 컨트롤). 기본값이 둘 다 1 이라 **기본 사용자 화면은 안 바뀌지만**, 그 노브를 2·3 으로 둔 사용자는 벽 개수가 「체결된 벽 표시 개수」 하나로만 결정된다. 남은 순위 어휘는 둘로 줄었다: `allPriceRankLimit`(하루 몇 개) · `PEAK_WALL_LEGEND_RANK_LIMIT`(판독 3 고정). **초기 로드 raw −3.5 KB**(1,316.9 → 1,313.4) — 이 예산 상수가 내려간 첫 사례다. |
| 2026-08-23 | **당일 최대벽 상위 3개를 캔들 밖에 순위 화살표로 (사용자 요청)** | 선·점·도킹 라벨은 전부 **벽 가격** y 에 붙는다. 벽이 캔들에서 멀면 "그게 어느 분봉이었나" 가 눈에 안 들어온다 — 화살표만 앵커가 **캔들 극값**(매도 고가 위 ↓ · 매수 저가 아래 ↑)이라 레전드의 ①②③ 과 봉이 1:1 로 이어진다. 매수 방향은 **미러**(사용자 결정): 이 pane 의 기존 문법과 일치한다(도킹 라벨 매도=위/매수=아래 · 급증 마커 ▼/▲). **⚠ ▼ 는 이미 다른 뜻이다** — `WallSurgeMarkersPrimitive`(호가벽 급증)가 같은 pane 에 속 찬 삼각형으로 ▼/▲ 를 쓰고 채움·테두리로 결말·유형까지 인코딩한다. 그래서 **축(shaft)이 있는 화살표 + 순위 숫자**로 형태를 가른다(숫자가 결정적 구분자다 — 급증 마커엔 숫자가 없다). **2026-08-26 후기:** 그 대비 상대였던 호가벽 급증 지표가 제거됐다(ADR-0162) — 축+숫자 형태는 **그대로 둔다**(레전드 ①②③ 과의 1:1 대응이 그 마커의 존재 이유다). **색은 지표 기본색 고정**: 「보이는 영역 최대벽」 강조색은 **선의 언어로 남긴다**. 화살표에까지 얹으면 레전드(행 스와치 하나, 셀별 색 없음)와 채널 수가 갈리고, 강조 규칙이 두 곳에 복제된다. **랭킹은 draw 시점**에 primitive 안에서 한다 — 팬·줌마다 draw 가 다시 도니 별도 구독이 없고, 레전드 provider 와 **같은 함수·같은 프레임의 보이는 범위**를 읽어 둘이 다른 상위 3개를 보일 수 없다. 줌 예산(`peakLabelBudgetForBarSpacing`)은 **적용하지 않는다**: 최대 6개라 라벨 수십 개처럼 충돌하지 않고, 오히려 라벨이 사라진 줌에서 "여기가 상위" 를 알려주는 것이 값어치다. 눈(👁)은 화살표도 지운다(그리기이므로 — 레전드 값과 다른 취급). **고저 극값 라벨과의 충돌은 회피 기계에 연결했다**: 매도 1위 벽의 봉은 화면 고가일 확률이 유난히 높은데 극값 라벨이 정확히 거기 붙는다. 회피 대상은 **그려지는 상위 N 개만** — 전건을 넣으면 있지도 않은 화살표를 피해 라벨이 표류하는 유령 회피가 되고, 그건 칩 rect 에서 이미 겪은 결함이다. |
| 2026-08-22 | **당일 최대벽 flag 레전드 행 복귀 + 값을 「보이는 영역 잔량 상위 3개」로 (사용자 요청)** | 2026-07-22 에 캔들 pane 밀집도 때문에 flag 행을 **전부** 숨긴 결정을, 매도·매수 최대벽 두 행에 한해 되돌린다(`LEGEND_FLAG_IDS` 화이트리스트 — `LEGEND_CELL_PANES` 와 같은 성격). **뒤집기가 아니라 전제 변화다**: 그때 숨긴 flag 값은 「커서가 올라간 거래일의 벽 1개」라 커서를 올리지 않으면 이름만 남은 빈 칩이었는데, 값이 **화면 전체 요약**으로 바뀌면서 커서 없이도 읽을 것이 생겼다 — 2026-08-18 프로그램 순매수 복원(“규칙의 전제가 여기서만 깨져 있었다”)과 같은 성격의 연장이다. **값 규칙**: 보이는 시간 범위와 겹치는 벽 중 잔량 내림차순 3개, 셀은 「순위 + 가격, 잔량」. 3개 고정이며 설정의 「보이는 영역 최대벽 표시 개수」(0~3)와 **무관**하다 — 그 노브는 선 강조 색만 관장하고, 0 을 고른 사용자의 레전드가 통째로 비면 지표를 끌 눈·✕ 까지 사라진다(같은 이유로 겹치는 벽이 0개여도 행은 남긴다). **랭킹은 한 곳**(`peakWallVisibleRanking.rankVisiblePeakSegments`)에서만 하고 선 강조와 레전드가 **같은 함수**를 쓴다 — 두 벌이면 동점(같은 잔량)에서 조용히 갈려 선은 A 를 강조하는데 레전드 1위는 B 가 된다(red-check 실측). 값 문자열도 도킹 라벨과 같은 `formatPriceQty` 다(#839 재발 방지). **대가**: 캔들 pane 에 상시 2줄이 늘어 좁은 워크스페이스 창에서는 3번째 셀이 잘린다 — 셀당 약 13자라 폭을 줄일 여지가 거의 없고(가격 축약은 Y축 정밀도라는 이 지표의 요점을 없앤다), 잘림은 `boxStyle` 의 기존 `overflow:hidden` 이 받는다. **재검토 트리거**: 좁은 창에서 1위조차 안 보인다는 보고가 오면 — 그때는 포맷이 아니라 **행 접기**(라벨만 남기고 값 토글)를 검토할 것. |
| 2026-08-26 | **보조지표 패널 리디자인 — 2모드 플립 폐지 + 글리프 + 미리보기 카드 + 검색** (#1616·#1617, 승인 목업 `docs/superpowers/designs/2026-08-26-indicator-panel-redesign.html`) | 좌측 목록이 「내 지표」와 카탈로그 **두 모드**라 15종 중 무엇이 켜져 있는지 한 화면에서 볼 수 없었다. 2모드 분리의 근거였던 "켜고 끌 때 행이 두 구역 사이를 오가면 방금 조준한 항목이 커서 밑에서 움직인다" 는 **옳은 제약**이고, 순서를 존재 여부와 **무관하게 고정**하면 같은 제약이 더 싸게 만족된다 — 오갈 구역이 없으면 움직일 일도 없다(가드: 추가·삭제 후 행 순서 동일). 추가 여부는 행 **안**의 상태로 말한다: 잉크 농도 + **인스턴스 색 점** + ＋/✕. 색 점은 장식이 아니라 **차트에 실제로 그려지는 색의 메아리**라 패널·레전드·캔버스가 같은 색을 쓴다 — 그래서 **사용자 색이 없는 7종(거래량·총잔량·호가비·체결강도·프로그램·투자자 둘)은 점이 없는 것이 정답**이다(목업은 거래량·체결강도에 점을 그렸으나 그건 일러스트였고, 실제로 찍으려면 없는 값을 지어내야 한다). **글리프 15종**은 단색 `currentColor` 16px 미니 스키마틱이고 문법이 둘로 갈린다 — **오버레이는 캔들 고스트 위, 하단 패널은 구분선 아래**. 즉 그림 하나가 "무엇을 그리나" 와 "어디에 그리나" 를 함께 답하고, 후자는 헤더 eyebrow(`10호가 지표 · 캔들 오버레이`)가 텍스트로 확정한다. ⚠ 조각 공유를 `<symbol id>`+`<use>` 로 하지 말 것 — nav 15행과 미리보기 카드가 **동시에** 렌더돼 문서에 같은 id 가 여럿 생기고, 중복 id 의 `<use>` 는 **조용히 첫 정의만** 따라간다(JSX 프래그먼트 상수로 둔다). **미추가 지표는 설정 폼이 아니라 미리보기 카드**다: 종전엔 존재하지 않는 지표의 *편집 가능한* 폼이 떠서 저 스위치를 만지면 무슨 일이 나는지가 화면에 없었고, 실제로 일부는 상태를 바꿨다(최대벽 방향 토글 — 그 테스트가 미리보기를 우회 경로로 쓰고 있었다). 추가하면 **그 자리가 폼이 된다**(선택 불변). 목업의 위치 스키마 그림·기본값 표는 **보류** — 지표마다 손으로 그린 그림 15장이 필요해지고 설정이 바뀌면 낡는다. **검색**은 nav **안**에 둔다(밖에 래퍼를 더하면 "nav 부모가 톤 면, 그 부모가 2열 그리드" 앵커가 한 겹 어긋난다). Enter 는 **선택까지만** — 라벨=미리보기 어휘가 키보드에도 적용된다. ⚠ 한글 조합 중 Enter 는 **글자 확정이지 명령이 아니라** `isComposing` 가드가 필요하고(리포 최초 사례), Escape 사다리(검색어→메뉴→패널)는 `stopPropagation` 없이는 성립하지 않는다(`ModalShell` 리스너가 `document`, 팝오버가 `window` 라 document 가 먼저 발화). **초기화는 헤더 ⋯ 로** — 가장 위험하고 가장 드문 항목이 매일 쓰는 목록의 상석을 차지하고 있었다(보호 수준은 인라인 2단 그대로, `ConfirmModal` 은 중첩 모달이라 금지). 지표 **이름·설명은 `CATEGORIES` 로 이관**한다 — 미리보기 카드는 Config 를 렌더하지 않으므로 설명이 그 안에 있으면 애초에 닿지 못한다. `hiddenCategories` prop 은 소비처 0 으로 제거(`/study` 폐지의 잔여물). **높이 근거 갱신**: nav 요구 903+푸터 100 ≈ **1,003px → 707px**(검색 40 + 목록 667), 스크롤이 사라지는 세로 뷰포트 ~1,170px → **~830px**. 상수 `min(960px,86vh)` 는 **줄이지 않는다** — 카드 높이는 우측 상세(최대벽이 가장 길다)와 설정 패널도 함께 정하므로 줄이려면 두 소비처를 같이 실측할 것. ⚠ 그 실측에서 `scrollHeight` 를 콘텐츠 높이로 쓰지 말 것(`clientHeight` 아래로 안 내려가 컨테이너 높이를 되돌려 준다 — 867px 이라는 틀린 값을 한 번 얻었다). 2026-08-21 항목의 재검토 트리거(「nav 그룹 접기」)는 이로써 **당분간 소멸**한다. |
| 2026-08-26 | **당일 최대벽 매도\|매수 탭 → 방향×계열 매트릭스 + 필터 가시화** (#1618·#1619, 아트보드 ⑤) | 서브탭은 **절반의 상태를 항상 숨겼다**. 두 방향이 완전한 미러라(갈리는 것은 미도달 판정 기준과 MA 방향뿐) 나란히 두면 대칭이 그대로 보인다. 더 중요한 것은 그 탭이 2026-08-25 가 세운 **"위치가 스코프를 말한다"** 를 계속 망가뜨렸다는 점이다 — "카드 안이면 그 계열, 밖이면 공통" 위에 방향 공용 항목을 위한 **"탭 밖"** 이라는 두 번째 관례를 얹어야 했고, **탭 경계는 눈에 보이는 선이 아니라** 화면에서 읽히지 않았다. 이 결정은 그 원칙을 뒤집는 게 아니라 **완성한다**: 열 머리=방향 마스터 · 셀=방향×계열 · 푸터 행=방향별 계열 공용(캔들 수평선·분봉 내 최댓값) · **매트릭스 밖=방향까지 공용**(강도 pane — 한 pane 을 양방향이 공유하므로 어느 열에 둬도 거짓말이 된다, 배지 동반). **세부 존이 하나가 된다**: 종전 계열 카드 3장이 각자 접히는 세부를 품어 전부 펼치면 21행이라 기본 접힘이었고, 접혀 있으니 뭐가 꺼졌는지 안 보여 「끈 개수」 뱃지를 따로 달아야 했다 — 선택이 항상 하나면 접기도 뱃지도 필요 없다(`usePeakWallFamilyOffCount` 소멸). **두 열을 다 끄면 존재 삭제와 동일**(판정이 `ask \|\| bid`)이고 매트릭스에서는 그것이 **평범해 보이는 두 클릭**으로 도달하므로 레전드 칩 ✕ 와 같은 undo 토스트를 준다 — ⚠ patch 에 `{side}PeakHidden` 을 **함께 실어야** 한다(복원은 op 를 우회하는 raw patch 인데 `set{Side}PeakEnabled(true)` 가 `Hidden:false` 를 같이 쓴다). **필터 가시화**: 「당일 최대벽이 왜 안 보이나」의 실제 원인은 MA 필터 4종이 **전부 기본 ON** 인데 그 필터가 아코디언 3단 깊이에 있었다는 것이다. 셀의 **깔때기**(활성 필터 수, 순수 pref 읽기 — ⚠ 공장값이 둘 다 켜짐이라 **손대지 않은 칸이 2로 시작**한다: 기본이 최대라는 뜻이지 사용자가 뭘 했다는 뜻이 아니다)와 존 헤더의 **리드아웃**(「지금 N개 표시 · M개 필터로 숨김」)이 그걸 표면으로 올린다. **기본값 자체는 유지**(사용자 결정 — 별도 판단). ⚠ **M 은 필터 경계에서 재야 한다**: 밖에서 `후보 − 그려진 것` 으로 빼면 세그먼트 매핑 손실(그 date 의 `RangeSegment` 부재·비유한 값)이 "필터로 숨김" 에 섞여 사용자가 **끄지도 않은 필터를 탓한다** — `N+M ≠ 후보총수` 가 정상이고 UI 는 총수를 주장하지 않는다. ⚠ **미등록 = 데이터 없음이지 0 이 아니다**(일·주·월봉은 발행 안 함 — `{shown:0}` 을 넣으면 "필터가 다 걸렀다" 와 구별 불가). warn 은 **계열 켜짐 ∧ 0개 ∧ 필터가 실제로 걸렀다** 셋을 다 만족할 때만(셋째가 없으면 벽이 없던 날에도 경보가 떠 곧 무시된다). 눈이 꺼져 있으면 문구를 **후보 어법**으로 바꾼다(세그먼트 계산이 `hidden` 을 안 보는 것이 `usePeakWallRender` 불변식이라 "표시" 는 거짓이 된다). ⚠ **deps 계약이 이 기능의 성능 위험 전부**다 — `register()` 는 조건 없이 스토어를 쓰므로 발행 effect 가 팬·줌마다 돌면 개수가 그대로여도 패널 재렌더로 샌다. 발행부를 `usePeakWallCountsPublisher` 로 빼 **원시값 12개**를 deps 로 나열하고 테스트가 그 계약을 잰다(객체를 **하나만** 끼워도 register 호출이 6→24, red-check 실측). 곁가지: 1\|2\|3 세그먼트를 **borderless 트랙 + tint 활성**(2026-07-15 규칙)으로 통일 — 다크에서 `bg-input` 테두리 세그먼트는 카드와 같은 톤이라 안 보인다. `--tint-warn` 은 네 테마에 진작 있었는데 tailwind 매핑만 없었다. |
| 2026-08-26 | **단일 리스트를 2모드(내 지표 / 카탈로그)로 되돌림 (사용자 결정)** — 같은 날 위 항목의 부분 되돌림 | 같은 날 합쳤던 것을 **사용자 결정으로 되돌린다**. 합친 판의 이점(15종이 한 화면 · 행이 안 움직임 · nav 요구 707px)은 실재했지만, 사용자가 그보다 **「지금 쓰는 것」과 「추가할 수 있는 것」이 섞이지 않는 것**을 택했다 — 매일 여는 목록은 대개 전자만 보려고 여는 것이고, 후자는 가끔 찾으러 들어가는 곳이다. 즉 뒤집힌 것은 근거가 아니라 **무엇을 최적화할지의 선택**이다(위 항목의 "행이 안 움직인다" 계약과 그 가드는 함께 사라진다). **되돌린 범위는 목록 구조뿐**이다: 2모드 + 하단 전환 버튼 + 「내 지표」 평리스트 / 카탈로그 그룹 헤더(정확히 이전 형태). 그룹 헤더의 `2/3` 카운트는 단일 리스트 전용 기능이라 함께 사라진다. **유지되는 것**: 글리프 15종 · 인스턴스 색 점 · 미리보기 카드 · 검색 · 헤더 ⋯ 초기화 · 설명 레지스트리 — 이들은 어느 목록 구조에도 얹힌다. ⚠ **검색은 지금 보고 있는 모드 안에서만 거른다**: 「내 지표」에서 친 검색어가 아직 추가하지 않은 지표를 끌어오면 두 목록을 가른 의미가 없어진다. 그리고 **모드를 바꿀 때 검색어를 지운다** — 한쪽에서 친 검색어가 다른 목록에 그대로 걸려 있으면 "왜 비어 있지" 가 된다. 삭제 시 동작도 되돌아간다(선택이 그 자리에 남는 대신 **남은 첫 항목으로** — 그 행이 「내 지표」에서 사라지므로 목록에 없는 것의 설정을 보게 된다). **높이**: nav 요구가 다시 두 모드로 갈려 각각 707px 보다 작아지고 푸터 1행(≈50px)이 돌아온다 — `min(960px,86vh)` 상수는 그대로 충분하다. |
| 2026-08-26 | **당일 최대벽 패널을 방향×계열 매트릭스 → 파이프라인(5단계)으로** — 같은 날 위 매트릭스 항목의 **구조 교체**(프로토타입 3안 A/B 비교, 사용자 판정 C) | 매트릭스는 **상태 조회**에 최적화돼 있었다(여섯 칸이 한눈에). 그런데 이 패널에서 실제로 반복된 질문은 조회가 아니라 진단이었다 — 「당일 최대벽이 왜 안 보이지」. 표 구조에서는 후보가 어디서 잘렸는지가 화면에 없어서 셀마다 **깔때기 배지를 따로 발명**해야 했다. 그게 구조가 답해야 할 것을 장식으로 때운 신호였다. **판정축과 탈락 이유**(실드로어 폭 518px · 실데이터 · `?variant=` 스위처): **A 교정된 매트릭스** — 아래 결함 넷만 고친 판. 고쳐도 진단 질문의 답이 여전히 배지에 있다. **B 표면 우선 스프레드시트** — 축을 뒤집어 행=축·열=방향×계열 6칸. 30개 토글이 한 화면에 들어가고(스크롤 0) 매도·매수 비대칭이 즉시 보이지만, **행마다 붙던 설명 문장이 툴팁으로 내려간다** — 밀도를 사고 설명을 판 것이라 기각. **C 파이프라인**(채택) — 방향 → 계열 → 후보 기준 → 표현 → pane. ③ 이 「지금 N개 표시 · M개 필터로 숨김」을 들고 있어 **레이아웃 자체가 진단**이다. **판 것**: 매도·매수를 나란히 보는 것. ① 의 두 카드가 각자 개수를 들어 반대쪽이 통째로 침묵하지는 않는다(`지금 2개 표시` / `지금 0개 표시`). **단계 번호가 스코프의 깊이**가 되어 종전 「위치가 스코프를 말한다」의 자리 넷(열 머리·셀·푸터·매트릭스 밖)을 순서 하나가 대신한다. **함께 닫힌 결함 넷**(조사 실측): ⓐ 푸터 「캔들 수평선」이 **거짓 이름**이었다 — `{side}PeakHidden` 은 `usePeakWallRender:467` 에서 `drawn` 으로 접혀 선·도킹 라벨·발생 시점 화살표·**순위 화살표**까지 끈다(스크린샷 red-check: 끄니 수평선과 순위 화살표 「2」가 동시에 사라짐). 계열별 「수평선 표시」와 이름까지 충돌했다. **배선은 그대로 두고** 이름·어포던스를 레전드의 눈으로 통일(`EyeGlyph` 를 `PaneLegendOverlay` 에서 끌어올려 두 표면이 같은 그림). ⓑ 관계도가 **매수판만 반쯤 뒤집혀** 있었다 — 셋은 방향별 y 인데 전체 최대벽만 `y="86"` 리터럴이라 매수에서 미도달(80)과 6u 로 붙었다. 네 레인을 전부 방향 파생으로. 곁가지로 「체결됨」 라벨이 캔들 rect(x193–207)와 겹치던 것도 함께(라벨을 166–193 틈으로). ⓒ 열 마스터 토글이 **자기 열보다 옆 열에 붙어** 있었다(실측 x: 매도 라벨 669 · 마스터 792 · 매수 열 시작 834 — 자기 라벨과 103px, 다음 열과 16px). ① 의 카드에서 라벨·마스터·눈이 한 덩어리가 된다. ⓓ 매트릭스 셀이 **넘쳤다** — `clientWidth` 165px vs `scrollWidth` 180–181px 이라 깔때기 배지가 잘렸다. 셀 자체가 사라져 소멸. **깔때기 → `필터 N/2`**: 공장값이 둘 다 켜짐이라 손대지 않은 칸이 2로 시작하는데 맨숫자 `2` 는 "내가 뭘 많이 켜 뒀나" 로 읽힌다. 분모가 **기본이 최대**라는 극성을 숫자 안으로 들여온다(분모는 레지스트리에서 파생 — 상수로 박으면 red 가 뜬다, red-check 실측). **표면 다섯을 두 구획으로**(캔들 위 셋 · 랭킹 참여 둘) — 종전엔 「어디에」 아래 평평한 다섯 형제라 성격이 다른 둘이 섞여 있었다. **리드아웃 문구 정정**: 「수평선 숨김 —」 → 「숨김 —」(눈이 선만 끄지 않으므로). 세 부재 사유(계열 꺼짐 · 미발행 · 눈)와 warn 3조건은 그대로 승계. **보존한 계약**: 마지막 방향 끄기 undo 토스트 3종(`Hidden` 스냅샷 포함) · 「보이는 영역 최대벽」 부재 가드(양 방향 순회로 강화) · 계열별 키 격리 · `peak-wall-detail-zone-{side}-{family}` 스코프 가드. **곁가지 doc drift 3건**: 「전체·미도달은 rank-1 고정」 주석이 코드와 반대였다(실측 rank 1→3 에서 표시 5→7개 — 2026-08-25 백엔드 top-3 로 전제 소멸) · `peakWallStepsRegistry` 의 「체결된 벽은 토글이 없어」 · 카탈로그 설명이 수평선/오버레이만 말하던 것. **프로토타입은 남기지 않는다** — 변형 셋과 스위처는 폐기하고 판정만 여기와 메모리에 적는다. |
| 2026-08-26 | **강도 pane 에 계열 셋 전용 토글** — pane 은 **하나**를 유지 (위 파이프라인 항목의 후속) | 종전엔 "어느 계열이 강도 pane 에 나오는가" 를 **캔들 선 토글이 정했다**(`{side}Peak{Family}LineEnabled`). 그래서 캔들에서 지운 계열을 pane 에서만 계속 보거나, 반대로 캔들에만 두고 pane 은 비우는 조합이 **원리적으로 불가능**했다 — 두 표면이 답하는 질문이 다른데(캔들 = 「그날 어디에 벽이 있었나」, pane = 「그 벽이 언제 얼마나 자랐나」) 스위치가 하나였던 것이다. pane 전용 키 셋을 만든다: `peakWallPane{Traded,Unreached,AllWall}Enabled`. **방향 공용**이다 — pane 자체가 매도·매수 공용이므로 6개가 아니라 3개이고, 슬롯은 그대로 6(방향 2 × 계열 3)이며 **pane 은 늘어나지 않는다**. 계단 셋이 같은 y 축(잔량)이라 겹쳐 읽는 것이 의미가 있고, pane 을 셋으로 쪼개면 화면 부동산만 먹는다. **공장값 T/F/F** — 종전 규칙("캔들 선 토글을 따라간다")의 공장값과 같아, 손대지 않은 사용자가 pane 을 켜면 **종전과 같은 화면**이 나온다. (캔들에서 미도달·전체를 켜 두고 pane 도 보던 사용자는 그 계열이 pane 에서 한 번 사라지고, 새 스위치가 바로 아래 있다 — 결합을 끊는 값이다.) ⚠ **`stepSegments` 의 `?? built` 폴백을 걷어냈다**: 종전엔 게이트가 닫히면 그리기 세그먼트로 떨어져 **소비처가 pane 을 다시 게이트해 주는 것에 의존**했는데, "pane 은 켜졌고 이 계열만 꺼진" 상태가 생기면서 그 의존이 거짓말이 된다. 세 계단이 전부 자기 게이트로 비운다. 가드는 **양방향**이다(캔들 ON·pane OFF → 선만 / 캔들 OFF·pane ON → 계단만) — 한 방향만 재면 "그냥 둘 다 끄는" 구현도 통과한다. red-check: 게이트를 캔들 선 토글로 되돌리면 두 테스트가 빨개진다(실측). 프리셋 화이트리스트(`PRESET_INDICATOR_FLAG_KEYS`)·`INDICATOR_PANE_PREF_KEYS` 에는 **넣지 않는다** — 전자는 "어느 지표가 켜졌나", 후자는 "어느 pane 이 뜨나" 의 목록이고 이 셋은 pane **안**의 계열 선택이다. |
| 2026-08-26 | **강도 pane 토글을 계열 3개 → 슬롯 6개(방향 × 계열)로** (사용자 결정) — 바로 위 항목의 부분 정정 | 위 항목은 "pane 이 매도·매수 공용이므로 토글도 방향 공용 3개" 로 갔다. **틀린 추론이었다** — pane 이 하나인 것과 그 안에 무엇을 넣을지가 방향마다 같아야 하는 것은 별개다. 실제 읽기 방식이 「매도 셋만 겹쳐 보기」나 「양방향의 체결된 벽만 마주 보기」라, 슬롯 6칸(`PEAK_WALL_STEP_SLOTS` = 방향 2 × 계열 3)과 **1:1** 인 키가 맞다: `{side}Peak{Family}PaneEnabled`. **pane 은 여전히 하나다** — 계단이 전부 같은 y 축(잔량)이라 겹쳐 읽는 것이 의미가 있고, 늘리면 화면 부동산만 먹는다. **UI 는 계열 3행 × 방향 2열**: 행이 설명을 소유하고(계열의 성질이 셋 다 다르다 — 단조/비단조), 열 라벨과 스위치가 **같은 grid 트랙**에 앉는다. 종전 매트릭스가 라벨을 열 왼쪽에, 스위치를 `justify-between` 으로 오른쪽 끝에 두어 마스터가 자기 라벨보다 옆 열에 가까웠던 실수(실측 103px vs 16px)를 되풀이하지 않는 배치다. **단계 ① 이 방향을 고르는 자리인데 ⑤ 는 양방향을 함께 둔다** — pane 이 하나라 그 안의 구성은 한 화면에서 정하는 것이 맞고, 그 비대칭이 의도임을 테스트가 못 박는다. **레거시 시드**: 반나절 살았던 방향 공용 3키를 값이 있을 때만 양 방향의 씨앗으로 읽는다(새 키가 있으면 그쪽이 이긴다) — 마이그레이션이 과해 보이지만 그새 만진 선택을 조용히 되돌리는 것이 더 나쁘다. ⚠ `FLAG_INDICATOR_FIELDS` 가드가 **네 번째로** 잡았다(6필드) — 지표 삭제 시 pane 구성도 공장값으로 돌아가야 한다. red-check 은 **방향 상실** 방향으로 확인(키를 매도 하나로 합치면 4건이 빨개진다). |
| 2026-08-26 | **설정·지표 설정 행 밀도 py-3 → py-2** (설정 패널 리디자인 · 프로토타입 C 채택의 선행 커밋) | 설정 모달 「차트」 섹션의 콘텐츠 실측이 1,705px vs 뷰포트 807px — 행 자체의 세로 패딩(12px×2)이 그 길이의 상수 항이었다. 판정된 프로토타입의 밀도 문법(단일 구분선 + py 8px)을 `SettingsRow` 한 곳에서 바꾼다. ⚠ `SettingsRow` 는 ⚙️ 설정 모달과 「지표」 모달의 hoga Config 가 **공유**한다 — 지표 모달 행도 함께 조여지는 것이 이 커밋의 의도다(두 표면의 행 문법이 갈라지는 것이 더 나쁘다). 이중 구분선(행 border-b + 별도 divider)은 설정 본체 재작성에서 따로 닫는다. |
| 2026-08-26 | **설정 모달을 마스터-디테일 → 단일 스크롤 + 스크롤 스파이 목차로** (제안 목업 `docs/superpowers/designs/2026-08-26-settings-panel-redesign.html` · 프로토타입 3안 실기기 판정, 사용자 선택 C) | 종전 구조의 문제 셋(실측): 차트 섹션 콘텐츠 1,705px vs 뷰포트 807px 인데 **이중 구분선**(행 border-b + 별도 divider, 행당 +17px)이 길이를 불리고 있었다 · 날짜 구분선·VI 스타일 행이 **게이트 없이** 서 있어 부모를 꺼도 피커가 살아 있는 죽은 컨트롤이었다 · 8개 섹션에 검색이 없어 「이 설정이 어느 섹션이더라」를 nav 를 눌러 가며 찾아야 했다. **판정축과 탈락 이유**(실모달 760px · 실제 레지스트리 라벨 · `?variant=` 스위처): **A 현행** — 기준선. **B 소그룹+밀도+검색(마스터-디테일 유지)** — 검색이 **별도 결과 뷰**라 조작 후 「돌아가기」가 생기고, 결과 행마다 소속을 말할 섹션 배지가 필요했다. **C 단일 스크롤 + 목차**(채택) — 문서가 항상 전부 펼쳐져 있으니 검색이 **인라인 필터**가 되고(그 자리에서 걸러 그 자리에서 조작, 배지 불요), nav 는 갈아 끼우는 스위치가 아니라 **스크롤 위치를 비추는 목차**다(VS Code 설정 문법). B 의 소그룹·밀도·게이트 문법은 C 에 그대로 승계됐다 — 뒤집힌 것은 **문서 모델**(한 번에 한 섹션 ↔ 항상 전부)이다. **수용한 비용**: 정보 섹션(알림·데이터소스·테마·Symbol Master·앱 정보) 이 항상 마운트라 설정을 열면 그 쿼리들이 함께 뜬다(캐시되는 가벼운 설정 조회들이라 수용) · 전체 스크롤이 길다(목차와 필터가 그 비용을 갚는다 — 프로토타입이 자리 표시 블록으로 길이를 정직하게 보여 준 상태에서의 판정이다). **소그룹은 레지스트리가 소유한다**: `CHART_TOGGLES` 의 `group` 필드 + `CHART_TOGGLE_GROUPS`(순서가 곧 화면 순서). 렌더가 그룹 순회뿐이라 group 없는 최상위 토글은 조용히 사라진다 — 레지스트리 가드 테스트가 그 누락을 빨갛게 만든다(red-check 실측). **필터 매칭은 유닛(부모+종속 행) 단위** — 프로토타입은 행 단위였지만 실렌더러(`IndicatorPrefRows`)는 부모+하위를 한 덩어리로 그리고 부모 없는 하위 행은 맥락을 잃는다(의도된 이탈, 컴포넌트 주석에 기록). 손 스타일 행의 검색 코퍼스는 **렌더와 같은 상수**에서 읽는다(각자 적으면 검색만 낡는다). **필터 중 TOC 클릭은 「필터 해제 → 점프」** — setState 직후엔 리마운트된 DOM 이 없어 대상을 ref 에 적고 query 변화 effect 가 소비한다. Esc 사다리(검색어 → 패널)·`isComposing` 불요(Enter 커밋 없음)는 지표 패널 검색 문법 승계. 스크롤 스파이의 추적 절반은 jsdom 에서 잴 수 없다(모든 rect 가 0) — 클릭 경로의 동기 절반(aria-current + scrollIntoView 호출)만 테스트로 못 박고 추적은 /browse 실화면 검증. ⚠ jsdom 에 `scrollIntoView` 가 없으므로 **옵셔널 호출**(`?.()`)이 필수다 — 기존 테스트들의 nav 클릭이 전부 이 경로를 지난다. 아트보드 ② 의 검색 결과 뷰 모델은 목업 안 후기 주석으로 **대체 표기**했다. 프로토타입 브랜치는 보존하지 않는다 — 판정은 여기와 메모리에 남긴다. |
| 2026-08-28 | **`/heatmap` 섹터 온도 스트립 제거 (사용자 결정)** — 2026-08-07 「현행 칩 클라우드 유지」 항목을 supersede | 2026-08-07 은 상단 밴드의 상시 세로 점유(실측 1680×1000 기준 칩 39개 4줄 = 87px = 뷰포트 9%)에 대해 **축약 3안**(B 양끝단 접기 · C 연속 온도 띠 · D 요약 한 줄)을 A/B 하고 현행 유지를 택했고, 「조사 도구가 이 점유율을 다시 지적해도 재론하지 않는다」는 잠금과 재검토 트리거(섹터 수 ≲20 또는 칩 5줄 이상)를 함께 걸었다. **이번은 그 재론이 아니다** — 당시 후보는 전부 축약이었고 **전면 제거는 검토된 적이 없다**. 사용자 지시로 스트립 자체를 없앤다. **제거 시점 실측**(1280×720, 사용자 데이터 45그룹): 스트립 높이 **100.9px · 칩 44개** 로 2026-08-07 의 87px/39칩보다 **자라 있었다**(섹터가 늘면 wrap 줄이 늘어 점유가 커지는 구조라, 그 항목의 재검토 트리거 「칩 5줄 이상」에 접근 중이었다). 보드 높이 **505.9 → 606.8px(+19.9%)**, `boardTop` 190.1 → 89.2px — **회수량이 스트립 높이와 정확히 일치**해 잔여 여백·접힘 없음을 확인했다(축약 3안이 회수하려던 35~36px 의 2.8배). **잃는 것과 이미 있는 대체**: 39섹터 「시장 온도 한눈」 개요 층 → 그룹 헤더 밴드 틴트(`heatHeaderBg`)가 섹터별 온도를 계속 표시한다(스크롤이 필요해진 것이 이 결정의 실제 대가다) · 칩 클릭 점프(wayfinding) → `그룹` 정렬 `desc`(뜨거운 섹터 최상단) + `HeatmapSearchInput` 그룹명 검색. **점프를 다른 형태로 되살리지 않는다**(사용자 결정). **범위**: `SectorTempStrip.tsx`·그 테스트 삭제, `pages/Heatmap.tsx` 의 import·렌더 + **소비처가 스트립뿐이던 `scrollToFolder`** 제거. ⚠ **`heat.ts` 는 통째로 보존한다** — `heatBg` 는 `/market` 의 KRX 업종 섹터 온도(`MarketPage.tsx`)가, `avgPct`/`makePctOf` 는 `HeatmapFolder`·`HeatmapDrawer` 가 쓴다(이름이 같아 grep 에 함께 걸리지만 **별개 기능**이다). ⚠ **`#heatmap-folder-*` id 도 보존** — 스크롤 앵커 겸 dnd 드롭 타깃이라 점프가 사라져도 역할이 남는다(`HeatmapBoard.test.tsx` 가 고정). 곁가지로 스트립을 원문 참조하던 **주석 4곳**을 갱신했다 — 코드 의존이 0이어도 주석이 삭제 대상을 근거로 들고 있으면 유령 근거가 된다(`liveQuotes.ts` 의 `open?` optional 근거 목록 · `Heatmap.test.tsx` 의 「스트립 칩+헤더로 중복 → All」 · `Heatmap.dragFreeze.test.tsx` 2곳). 「중복」이 사라졌으므로 그 대기 쿼리는 `findAllByText` → `findByText` 로 좁혔다(1개여도 통과해 **테스트는 안 깨지고 주석만 거짓말이 되는** 경로였다). **재검토 트리거**: 섹터 카드 wayfinding 이 실제로 아쉬워질 때(그때의 후보는 스트립 복원이 아니라 헤더의 그룹 목록 드롭다운 — 상시 세로 점유가 0이다). |
| 2026-08-30 | **테마 선호 `auto` 제거 (사용자 결정)** — 2026-08-07 「`auto` 는 설정에 옵션으로 남는다」를 supersede | 2026-08-07 은 `auto` 의 동작(nav 한 번에 화면 전체가 다크↔라이트로 뒤집힘)을 이유로 **기본값에서** 뺐고 옵션으로 남겼다. 남은 값어치는 「그 뒤집힘을 원하는 사람을 위한 옵션」 뿐인데, 그 옵션 하나가 지고 있던 비용이 컸다: ① `index.html` 부트스트랩에 **라우트 맵이 복제**돼 있었고 실제로 어긋나 FOUC 를 냈다(`/market`, 2026-08-07 항목의 그 버그) · ② 그 복제를 지키는 가드 테스트 · ③ 라우트 축을 위한 **두 번째 DOM writer**(App.tsx) · ④ 그 writer 가 자식 이펙트보다 늦어 생기는 순서 갭(#1656 이 「의도적 미수정」으로 남긴 엣지) · ⑤ **preference ≠ effective theme** 이라는 개념 이중화(`effectiveTheme(pref, pathname)` + `EffectiveTheme` 타입). 다섯 가지가 `auto` 와 함께 사라졌다 — **선호가 곧 테마**이고 라우트는 입력이 아니다. **마이그레이션 코드 없음**: `readStorage` 가 화이트리스트 검증이라 저장된 `'auto'` 는 `null` → 기본값(Toss Light)으로 폴백한다. 그 폴백은 **제거가 만든 새 경로**(그전엔 유효값이었다)라 테스트로 못 박았다. ⚠ **삭제가 조용히 앗아간 것 하나**: App 이펙트가 마운트 시 하던 1회 동기화가 함께 사라져, 부트스트랩이 예외로 떨어졌을 때(localStorage 차단 등 `catch` → obsidian) 스토어 값과 어긋난 채 교정 수단이 없어졌다. `subscribeThemeToDom` 이 **등록 시 현재 값을 한 번 쓰도록** 해 되살렸다 — App.test 의 탭 전역 테스트가 잡았다(기능을 옮길 때 곁다리 보장이 함께 죽는 전형). 남은 복제(기본값 + 허용 목록)와 그 가드 2개는 그대로 유지한다. |
| 2026-09-04 | **10호가 `중` 행(중간값) 제거 — 사다리 22행 → 21행 (사용자 결정, ADR-0170)** — ADR-0140 §7.1 「호가창 21행 + `중` 행」을 supersede | §7.1 은 `중` 행을 넣으며 두 성질을 함께 받아들였다: 중간값이 **호가 단위 밖일 수 있다**는 것과, 그것을 `중` 뱃지가 "주문 가능한 호가가 아니다"로 표시한다는 것(키움 앱 규약). 실사용에서 그 뱃지가 나르는 정보가 값에 비해 비쌌다 — 소수 `.5` 중간값은 예외가 아니라 **기본값**이고(실측 2026-08-06 KRX 스냅샷 80,199건 중 4.88%, 종목별로는 100130 **99.0%** · 018880 93.5% · 003530 82.7% — 호가단위 1·5원인 저가주는 1틱 스프레드의 합이 홀수라 거의 매 틱이다), 그래서 한 행만 사다리 20행과 자릿수가 다른 숫자를 상시 띄웠다. 뱃지 쪽은 더 나쁘다: 뜻이 "이 값으로는 주문할 수 없다"인데 **늘 떠 있으므로 등장이 아무것도 말하지 않는다** — §7.1 이 교차 경고를 거절할 때 쓴 논리(「상시 켜진 경고는 없는 문제를 찾게 만든다」)가 뱃지 자신에게 적용된 셈이다. **포기하는 것**은 §7.1 의 원래 근거인 "매도10과 매수1이 맞붙어 스프레드를 보여줄 자리가 없다" — 스프레드는 다시 매도1·매수1 두 숫자로 읽는다. **격자 규칙은 그대로 지켜진다**: 2026-07-22 「10호가 내부 격자(매도↔매수 경계)는 유지하되 `--border-strong`→`--border` 완화」가 여전히 성립하고, 경계선이 두 줄 × 3열 = 6개에서 **한 줄 × 3열 = 3개**로 줄 뿐이다(남는 3개는 좌 체결강도 `border-t` · 중앙·우 첫 매수 행 `topDivider` 로 **이미 있던 선**이라 새로 그리는 것이 없다). ⚠ **행을 지울 땐 좌·우 빈칸을 함께** 지운다 — 중앙만 건드리면 좌우가 1행씩 길어져 하단이 조용히 어긋난다. `trades.slice(0, 9)` 는 세 열이 동시에 줄어 **불변**이고, 패널 높이만 484 → **462px**(21 × 22)이 된다. 곁가지: 스프레드 안쪽 가격의 시/고/저 칩은 사라지지 않고 **요약표 칩으로 이동**한다(`offLadderChip` 이 받는다 — 배타 규칙 유지). |

## App-shell & live tokens (ADR-0039, ADR-0052)

Layout and source-identity tokens beyond the core scale. The Right Rail tokens (ADR-0052) are app-shell-wide (every route); the live tokens are `/live`-scoped. These layout widths/heights live in `design-tokens.ts` `SIZE_TOKENS` (ADR-0012); this hand-maintained table mirrors them for reference (no auto-marker yet):

| Token | Base intent (1.0×) | Rendered @ default (1×) | Use |
|---|---|---|---|
| `--rail-w` | 48px | 48px | Right Rail icon column width (app shell, all routes; fixed — does not collapse) |
| `--watchlist-panel-w` | 320px | 320px | Shared width for all Right Rail panels |
| `--h-top-nav` | 32px | 32px | Global top navigation row |
| `--h-toolbar` | 32px | 32px | Workspace toolbar row — `WorkspaceShell.WorkspaceToolbar`, 소비처는 `/live` 의 `WorkspaceLiveToolbar` (창 추가·설정·프리셋·캡처헬스 한 줄 버튼 행). 밀도 개편(2026-07-23)으로 60→32px |
| `--h-bottom-bar` | 24px | 24px | Global market-index bottom bar row (하단 시장지표 스트립; 데이터 없으면 행 자체가 접힘) |
| `--app-floor-min-w` | 944px | 944px | App shell 가로 바닥 — 아래로는 압축을 멈추고 `#root` 가 가로 스크롤 (Layout → Responsive floor) |
| `--app-floor-min-h` | 624px | 624px | App shell 세로 바닥 (ADR-0122) — 아래로는 높이 동결 + 세로 스크롤 |

> 두 열이 같은 값인 것은 **2026-08-07 부터 기본 밀도가 1.0× 이기 때문**이다(우연이 아니라 정의상). 열을 합치지 않는 이유는 density 모드가 부활하면 다시 갈라지고, 그때 "base intent 가 무엇이었나" 가 필요하기 때문이다.

**소비처 없는 토큰은 정의째 삭제한다** — 정의만 남은 토큰은 "이 값이 화면에 나타난다"고 오독되기 때문. 2026-07-29 (#916) 에 `--h-pricestrip`(시세 스트립 폐지)·`--h-tab`·`--h-tab-secondary`·`--h-orderbook-row`·`--combobox-min-w` 5개를 삭제했다. 판정은 `--token-name` grep 만으로 하지 말 것 — `TAILWIND_THEME` 이 토큰을 유틸리티로도 매핑하므로(`--h-tab` → `className="h-tab"`) **CSS 변수명과 Tailwind 클래스명 양쪽**을 봐야 한다. 삭제해도 Tailwind 기본 스케일이 승계하지 않는 이름이라 무음 회귀는 없다(`font-mono` 별칭을 남긴 이유와 대비 — 그쪽은 기본 스택이 승계한다). `usage` 문자열은 `npm run gen:tokens` 로 `tokens.css` 주석에 그대로 찍히므로, 고칠 때는 `design-tokens.ts` 를 고치고 재생성해야 한다.

**Source identity** — neither UI state nor status nor price direction, but data provenance.
A fourth category limited to identifying which capture source produced the data.

| Token | Value | Use |
|---|---|---|
| `--source-kis-live-border` | `var(--accent)` | kis_live 출처 표식 — 캘린더 캡처 배지 (`capture/calendarStatus.ts`) |

*소스별 `-bg`/`-border` 8개였으나 2026-07-31 에 7개를 삭제했다.* 이 토큰들은 `SourceChip` 전용이었고,
그 칩을 얹던 `LiveStatusBar` 가 #865 에서 폐지되면서 컴포넌트가 죽은 채 남아 있었다(참조는 자기 테스트뿐).
`-border` 4개는 그보다 앞선 #639 (2026-07-15 borderless 전환) 부터 이미 죽어 있었다 — 칩이 `-bg` 만 썼다.
위의 "소비처 없는 토큰은 정의째 삭제한다" 규칙을 적용한 결과다.

## Copy tone (Stage 9)

- **Domain identifiers** (`hogaplay`, `kis_live`, `cycle_lag_ms`, `EGW00201`): English lowercase, code-style (monospace where appropriate). Never localized.
- **User-facing messages**: Korean natural-language sentences. No trailing periods. Actions are nominalized ("재발급" not "재발급하기").
- **Status labels** (`LiveStateBanner` badges, 차트 창 타이틀바 칩): Korean single words ("장 외", "대기 중", "준비됨"). *(`LiveStatusBar` 는 폐지됐다 — 종목 식별·현재가·등락률·경고는 각 차트 창 타이틀바가, 캡처 헬스는 툴바가 소유한다. 2026-07-29 정정.)*
- **Layout grid for `/live`**: see [Layout → App shell](#layout). (History: this line described a 4-row grid — header + status bar + toolbar + workarea — mirroring the since-deleted `/replay` PriceStrip pattern. Corrected 2026-07-29; the page has been a 3-row grid since `LiveStatusBar` 폐지.)

### 2026-09-08 — 우측 패널 탐색·액션 정리 (사용자 승인)

- 패널 폭 280px, 레일 48px, 종목 행 최소 높이와 숫자 열 정렬은 유지한다. 헤더 액션은 28px 높이, 행 메뉴는 기존 행 높이 안의 20px 영역을 쓴다. 레일은 아이콘과 상시 라벨을 유지한다.
- 관심종목·히트맵·저장뷰는 검색 오른쪽에 전체 접기를 두고 그 아래에 다중 선택과 정렬을 배치한다. 선택 모드의 공통 문구는 `다중 선택` / `선택 완료` / `N개 선택`이다. 그룹 생성은 `+ 그룹`, 종목 추가는 `종목 추가`로 대상을 명시한다.
- 2026-10-21 사용자 승인: 관심종목·히트맵의 전체 접기 버튼은 처음 제안한 미니멀 시안으로 통일하며, 후속 요청으로 저장뷰에도 같은 버튼을 적용한다. 접기는 안쪽으로 모이는 두 꺾쇠, 펼치기는 바깥으로 벌어지는 두 꺾쇠만 표시하며 가로선은 제거한다. 아이콘 16px·버튼 28px의 rem 토큰과 보조색·무테 배치를 쓰고, 호버에만 기존 보조 배경과 accent를 표시한다. 각 패널의 접힘 저장·검색 중 동작·비활성 조건과 저장뷰의 검색 중 비활성 사유 툴팁은 유지한다.
- 관심종목 검색은 종목명·코드·그룹명을 필터링하며 접힌 그룹에서도 결과를 찾는다. 검색 중 접힘은 일시 상태로 분리하고, 해제하면 기존 접힘과 스크롤 위치를 복원한다. 필터 중 재정렬은 제한하고 이유를 표시한다. 같은 코드의 서로 다른 그룹 멤버십은 별도 행이다.
- 종목 행은 호버·키보드 포커스에 전체 이름과 코드를 보여준다. 종목 클릭 패널의 `연결 대상`은 `activationTarget`으로 계산한 차트 연결 그룹과 고정되지 않은 창 개수를 표시한다. 관심종목 그룹과 별개다.
- 패턴 드로어의 조건 상시 노출 설명은 이번 승인으로 변경한다. 봉 단위·기간·결과 상한은 계속 노출하고 나머지는 상세 조건으로 접는다. 접힌 상태에도 적용 개수와 요약을 보존하며 조건값·검색 의미는 바꾸지 않는다(ADR-0166의 검색 계약 유지).
- 스크리너는 `실시간 감시 시작`과 선택 조건 요약, 장 마감 대기를 안내한다. 알림은 설정의 사용 여부와 오늘 수신 내역을 구분하고 같은 전역 설정 모달의 알림 섹션으로 연결한다. `사용 중`은 설정값이며 연결 정상 여부를 의미하지 않는다.
- 일반 액션에는 `aria-pressed`를 붙이지 않는다. 비활성 버튼은 색을 낮추고 호버 강조를 막되 이유 툴팁은 유지한다. 접기·메뉴·드래그 표식은 공용 SVG를 쓴다.

### 2026-10-13 — 우측 관심종목·히트맵 목록 조작 (사용자 승인)

- 그룹 헤더와 종목 행의 드래그 핸들·⋯ 메뉴 아이콘을 제거한다. 종목명과 수치가 그 공간을 사용한다.
- 종목 행과 그룹 헤더 전체에서 포인터 드래그를 시작하며, 기존 5px 이동 기준과 삽입선·미리보기·자동 스크롤·Esc 취소를 유지한다. 종목 클릭은 차트 열기, 그룹 이름 클릭은 접기·펼치기다. 드래그 후에는 클릭 동작이 발화하지 않는다.
- 선택 체크박스·접기·정렬·입력 컨트롤은 드래그 시작에서 제외한다. 이동 가능한 영역은 grab, 이동 중에는 grabbing 커서를 표시한다. 기존 검색·정렬 중 재배열 규칙을 유지한다.
- 그룹과 종목의 기존 메뉴는 우클릭과 Shift+F10/메뉴 키로 제공한다. 패널 상단 도구와 레일 아이콘은 기존 조작 영역을 유지한다.

### 2026-10-14 — 관심종목의 행 직접 다중 선택 (사용자 승인)

- 관심종목 패널의 `다중 선택` / `선택 완료` 버튼과 선택 체크박스를 제거한다. 다른 패널의 선택 방식은 유지한다.
- 일반 클릭은 차트를 열고 범위 선택 시작점을 지정한다. Shift+클릭은 시작점부터 현재 행까지 선택하며 차트를 바꾸지 않는다. Ctrl/⌘+클릭은 해당 그룹의 행 하나를 추가·해제한다. Ctrl/⌘+Shift+클릭은 기존 선택에 범위를 추가한다. 새 탭 열기는 관심종목의 단일 행 우클릭 메뉴로 제공한다.
- 범위는 펼쳐진 검색 결과의 화면 순서다. 그룹 경계를 넘고 그룹 헤더·빈칸·접힌 그룹 내부는 제외한다. Shift+↑/↓는 같은 범위를 확장·축소한다. 동일 코드의 서로 다른 그룹 소속은 별개 행이다.
- 선택 배경은 `--tint-selection`, 현재 차트 종목명은 accent와 굵기로 구별한다. 선택이 있을 때만 `N개 선택 · 이동 · 삭제 · 선택 해제` 액션을 표시한다. 수정키를 누른 포인터 동작은 드래그를 시작하지 않는다.
- 선택된 행 드래그는 전체 선택을 이동한다. 선택된 행 우클릭은 일괄 이동·삭제 메뉴를 열고, 선택 밖 행 우클릭은 선택을 해제하고 단일 행 메뉴를 연다. 메뉴 이동은 목적 그룹 끝에 넣으며 기존 이동·중복 합침·실행취소 계약을 공유한다.
- Delete는 선택이 있으면 선택한 그룹 소속을 일괄 삭제하고, 없으면 기존 포커스 행 소속만 해제한다. 일괄 삭제는 확인 창에 항목 수와 마지막 소속이 없어지는 종목 수(관심종목 제외·수집 중단)를 표시한다. 다른 그룹 소속과 메모는 유지한다.
- `POST /api/watchlist/items/remove`는 그룹별 before/after와 확인한 `orphan_codes`를 받는다. 한 잠금·한 저장으로 코드 소속만 제거한다. 그룹 스냅샷 또는 최종 소속 해제 집합이 달라지면 전체를 409로 거절한다. 삭제 실행취소는 제공하지 않는다.
- 검색·접기·정렬 조작 시 선택과 시작점을 해제한다. 시세 갱신에 따른 순서 변경은 선택한 행의 동일성을 유지하며, 사라진 행은 선택에서 제외한다. Esc는 드래그·메뉴·확인 창을 먼저 취소하고, 목록에서는 선택을 해제한다.

### 2026-10-14 — 히트맵 패널의 행 직접 다중 선택 (사용자 승인)

- 우측 히트맵 패널에도 관심종목과 같은 직접 선택을 적용한다. 다중 선택 버튼·체크박스를 제거하고 Shift+클릭 범위 선택, Ctrl/⌘+클릭 개별 선택, Shift+↑/↓ 범위 조절, Esc 해제와 선택 중에만 보이는 일괄 액션을 제공한다. 새 탭 열기는 단일 행 우클릭 메뉴에 둔다.
- 히트맵 검색은 기존처럼 매칭 그룹 전체를 표시한다. 범위는 실제로 표시된 모든 종목 행을 따른다. 검색 매칭 종목은 이름의 굵기로, 현재 차트 종목은 accent로, 일괄 선택은 배경으로 구별한다. 검색·접기·명시적 정렬 변경 시 선택을 해제하며, 시세에 따른 재정렬은 선택한 소속을 유지한다.
- 선택한 행 드래그와 우클릭 그룹 이동은 선택된 소속 전체를 이동한다. 기존 Ctrl+드래그 복제는 유지한다. Ctrl+클릭과는 5px 드래그 시작 기준으로 구분한다. Shift/⌘ 포인터 동작은 드래그를 시작하지 않는다. 기존 중복 합침·실행취소·검색/정렬 중 그룹 이동 규칙을 공유한다.
- Delete·선택 삭제는 해당 그룹 소속만 제거한다. 일괄 삭제 확인에 마지막 소속이 사라져 히트맵에서 빠지는 종목 수를 표시한다. 다른 그룹의 등록과 관심종목 문서는 유지한다. 삭제 후 남아 있는 행 또는 패널 버튼에 포커스를 둔다.
- `POST /api/heatmap/entries/remove`는 그룹별 before/after와 확인한 `orphan_codes`를 받는다. 한 잠금·한 저장으로 등록만 제거하고, 그룹 스냅샷이나 최종 소속 해제 집합이 달라지면 전체를 409로 거절한다. 저장 후 수집 대상과 히트맵 관련 조회를 갱신한다. 삭제 실행취소는 제공하지 않는다.
- 적용 범위는 우측 패널이다. `/heatmap` 보드의 조작 방식은 기존 계약을 유지한다.

### 2026-10-14 — 관심종목·히트맵 Ctrl/⌘+클릭 새 탭 (사용자 승인)

- 위 두 패널의 직접 선택 수정키 계약을 변경한다. Ctrl/⌘+클릭은 해당 종목 차트를 새 브라우저 탭으로 연다. Shift·Alt를 함께 눌러도 새 탭 열기를 우선하며 현재 차트·목록 선택·범위 시작점은 유지한다. 단일 행 우클릭 메뉴의 새 탭 열기도 유지한다.
- 개별 소속 선택·해제는 Alt+클릭, 기존 선택에 범위 추가는 Alt+Shift+클릭이다. 일반 클릭·Shift+클릭·Shift+↑/↓·Esc·일괄 이동·삭제는 기존 계약을 유지한다. Alt+Shift+↑/↓도 기존 선택에 범위를 추가한다.
- 선택용 Shift/Alt 포인터 동작은 드래그를 시작하지 않는다. 관심종목은 Ctrl/⌘도 드래그를 시작하지 않고, 히트맵은 기존 Ctrl+드래그 복제를 유지한다. 히트맵의 Ctrl+클릭은 기존 5px 드래그 시작 기준으로 복제와 구분하며 드래그 완료 후 새 탭을 열지 않는다.
- 적용 범위는 우측 관심종목·히트맵 패널이다. 기존 새 탭 전달 경로와 배치 복사·격리 계약을 재사용한다.

### 2026-10-14 — 관심종목 행 이름 폭을 히트맵과 통일 (사용자 승인)

- 관심종목의 오른쪽 수집 상태 예약 칸을 제거한다. 이름 시작점·가격·등락률 열 폭과 행 높이는 우측 히트맵 패널과 같게 유지한다. 이름 영역은 기존 상태 칸·간격에 쓰던 1.75rem을 되찾는다.
- 수집 예외 점은 기존 왼쪽 2.5rem 들여쓰기 안에 배치한다. 정상 수집은 기존처럼 점을 숨기고, 예외 상태의 색·툴팁·접근성 문구는 유지한다. 표시 상태가 바뀌어도 이름·숫자 열 폭이 움직이지 않는다.
- 드래그 미리보기에도 같은 배치를 적용한다. 이름 생략은 히트맵과 동일하게 실제 남은 폭이 부족할 때만 사용한다.

### 히트맵 탐색과 수집 (2026-09-09)

`/heatmap`도 `/market`처럼 화면 폭에 맞추고 상단 내비게이션만 내부 스크롤한다. 그룹 헤더는 이름에 폭을 우선 배정하고 보조 정보는 줄바꿈한다. ⋯ 버튼으로 그룹 메뉴에 키보드 접근을 제공한다. 검색 기본은 그룹 전체이며 일치 종목만 보기에서도 평균과 수집 지연은 원래 그룹 전체 기준이다. 등록 수와 중복 제외 고유 종목 수를 구분한다. 수집 지연은 시세 수신이 아니라 저장 마커 최댓값 기준이며 대상 종목과 기준일을 확인하고 커버리지 조회 후 보충 수집한다.

2026-09-09 사용자 요청: 그룹 헤더에 수집 지연 라벨이나 개수를 표시하지 않는다. 보충 수집은 ⋯ 그룹 메뉴에 두며 수집 기준과 대상은 다이얼로그에서 확인한다.

2026-10-23 사용자 요청: 히트맵 보드 그룹 헤더는 항상 한 줄로 배치한다. 그룹명 영역의
기본 배정 폭을 없애 남는 폭을 쓰고, 긴 이름만 말줄임한다. 미니 그래프·평균 등락률·
종목 추가는 유지하며 ⋯ 버튼을 제거한다. 이름 변경·그룹 삭제·보충 수집은 헤더 우클릭,
헤더 포커스 후 Shift+F10 또는 메뉴 키로 연다. 위의 보조 정보 줄바꿈·⋯ 진입점 규칙을 대체한다.


### 저장뷰 사용자 그룹 (2026-09-12 사용자 승인)

2026-10-26 사용자 요청 — 차트의 저장 기간 밴드 내부 채움은 기존 테마 선택 틴트의
40% 농도로 낮춰 캔들과 지표를 덜 가린다. 후속 요청으로 상단 설정 → 차트 → 저장 기간에
`저장 기간 채움 농도` 슬라이더(0~100%, 기본 40%)를 제공한다. 변경 즉시 모든 열린
저장 기간 밴드에 반영하고 자동 저장하며 검색·되돌리기를 지원한다. 0%는 채움을 숨기고
양끝 1px 경계선은 기존 accent를 유지한다.

2026-10-27 사용자 승인 — 일봉 저장뷰의 저장 기간은 양끝 세로선을 제거하고 범위
안의 반투명 영역 밴드만 표시한다. 첫 봉과 마지막 봉의 바 폭을 포함하는 범위와
테마 색상·기존 채움 농도 설정을 유지하고 거래량·보조지표 pane에도 같은 영역을
이어 표시한다. 일봉의 채움 농도 0%는 저장 범위 표시를 전부 숨긴다. 주·월봉의
양끝 1px 경계선은 유지한다. 위 2026-10-26 경계선 유지 규칙을 일봉에 한해 대체한다.

2026-10-26 사용자 수정 요청 — 일·주·월봉 저장의 기간은 화면에 보이던 첫 캔들부터
마지막 캔들까지 표시·저장한다. 분봉 원자료의 2년 제한으로 하루만 남기지 않는다.
캘린더 봉 저장에는 호가 원자료의 누락 수집 안내를 표시하지 않는다. 기존 항목은
남아 있는 화면 좌우 시각으로 복구 가능한 경우에만 원본 백업 후 기간을 복구한다.

2026-10-26 사용자 승인 — 저장뷰를 저장한 봉 주기로 열면 저장 배율로 저장 구간 끝을
표시한다. 일·주·월봉에도 적용하며, 다른 봉 주기로 전환할 때만 기존의 주변 맥락
배율(저장 구간 봉 수의 2.2배·최대 160칸)을 사용한다. 저장 배율이 없는 경우도 기존
계산을 사용한다. 일반 갱신은 사용자의 팬·줌을 되돌리지 않는다.

저장뷰는 사용자가 만든 한 단계 그룹으로 분류한다. 같은 그룹에 서로 다른 종목과 같은 종목의 여러 저장 기간을 담는다. 그룹 헤더는 그룹명과 저장뷰 개수를, 행은 종목명·저장뷰 이름·봉 단위·기간을 표시한다. 분봉에는 KST 시작·종료 시각을 표시하며 긴 기간은 줄바꿈한다. 빈 그룹은 유지한다. 기존 패널 폭 280px와 공용 토큰을 유지한다.

2026-10-25 사용자 요청: 저장뷰 목록의 일봉 항목은 봉 단위 문구를 생략하고 기간만 표시한다. 목록 툴팁에도 같은 규칙을 적용하며 다른 봉 단위 표시는 유지한다.

2026-10-26 사용자 승인: 저장뷰 목록을 관심종목의 그룹·행 스타일과 조작에 맞춘다.
그룹명 바로 옆에 개수를 두고, 행은 종목명·저장뷰 이름과 기간의 2줄로 표시한다.
메모는 툴팁·인라인 편집에 보존하며 핸들·점·행/그룹 메뉴 버튼을 제거한다.
행·그룹 전체 드래그, 우클릭·Shift+F10 메뉴를 사용하고 이름 변경은 메뉴에서 연다.
클릭은 즉시 열기, Shift+클릭·Shift+방향키는 범위 선택, Alt+클릭은 개별 선택,
Alt+Shift는 범위 추가, Ctrl/⌘+클릭은 새 브라우저 탭 열기다.
열린 저장뷰는 이름의 accent·굵기로, 다중 선택은 배경 tint로 구별한다.
선택 작업은 선택이 있을 때만 표시하고 선택 묶음 드래그·그룹 이동·삭제를 제공한다.
상시 하단 조작 안내는 제거하며 정렬 제한·이동 결과·실패·되돌리기는 유지한다.
삭제의 5초 실행 취소와 저장뷰별 식별자·그룹·기간·메모 저장 계약은 유지한다.
드래그 미리보기에도 별도 핸들 기호나 반복되는 `이동` 문구 없이 이름 또는 선택 개수를 표시한다.

차트 창의 저장 버튼은 그룹 선택과 새 그룹 입력을 한 다이얼로그에 제공한다. 이름은 선택 입력이며 빈 값은 종목·봉·기간으로 채운다. 새 그룹 생성과 저장은 함께 완료한다. 저장 성공 안내의 `목록에서 보기`는 목적 그룹을 펼치고 새 항목을 드러낸다. 그룹 이동은 메뉴·다중 선택·드래그로 제공한다. 전체 정책은 `docs/superpowers/specs/2026-09-12-study-view-user-groups.md`에 기록한다.

### 통합 서비스 상태 (2026-09-13)

상단 내비게이션 오른쪽의 `상태` 버튼이 공통 서비스 상태 패널을 연다. 개별 키움 API
실패·연결 관측·점검 공지는 페이지를 밀어내는 전역 배너에서 제거하고 이 패널에 둔다.
디스크 부족·백그라운드 작업 중단도 같은 목록에서 확인한다. 기존 운영 경보 토스트는
주의 환기용으로 유지하며, 닫아도 상태 패널의 관측은 남는다. 폼의 액션 인접 오류와
렌더 실패 대체 화면은 기존 위치를 유지한다.

프로그램매매 패널의 실패·부분 데이터 표시에는 `상태 보기`를 제공한다. 관련 API의
공급사 관측을 열되, API 단위 관측을 해당 종목·날짜의 실패 원인으로 단정하지 않는다.
상세의 진단 복사는 원문 응답 대신 안전한 원인·코드·API·시각을 제공하며 클립보드가
불가능하면 선택 가능한 텍스트를 제공한다.

2026-10-15 사용자 요청: 프로그램 창 하단의 `최근 누적 / 커서 시점 · 시각 · 표시 단위`
안내 행을 제거한다.
같은 날 사용자 요청: 매물대 창 하단의 `최대 거래량 가격 · 가격` 안내 행을 제거한다.
같은 날 사용자 요청: 체결 창 하단의 `최근 체결 · 시각 · 최대 200건 · 커서와 독립`
안내 행을 제거한다.

2026-10-19 사용자 승인: 매물대는 프로그램 창의 차분한 톤을 따른다. 일반 막대는
테마의 중립색에 설정 색상을 옅게 섞고, 최대 구간만 낮은 농도로 강조한다. 막대의
전체 폭 배경 트랙과 가격선 외곽선은 제거하고 가격선은 얇은 보조색으로 표시한다.
상단에는 최대 거래량 구간·가격 범례만 두며, `최대 매물 가격·구간 거래량·비중`
요약 수치는 표시하지 않는다. 기존 가격·시간축, POC 가격 라벨과 색상 설정은 유지한다.
2026-10-21 사용자 요청: 매물대 창의 최신 체결 시각을 표시하는 자동 세로 점선을 제거한다.
같은 날 사용자 승인: 매물대 시간축은 프로그램 창처럼 실제 가격의 첫 유효 관측부터
마지막 관측까지 표시한다. 가격이 없는 경우 전체 분포의 체결 관측 범위를 사용하고,
관측 시각을 알 수 없을 때만 집계 구간으로 대체한다. 가격선·막대·호버 마커·눈금은
같은 축을 사용한다. 08~09시 데이터가 없으면 앞쪽 빈 공간을 제거하되 NXT 가격이
있으면 해당 시간대를 포함한다. 중간 공백과 거래량 집계 기준은 유지하며 호버 집계로
시간축을 줄이지 않는다. 관측이 한 점이면 그 시각만 표시한다.

2026-10-15 사용자 요청: 일반 `체결` 창도 `ka10003` 연속조회로 당일의 이전 체결을
이어 읽는다. 시각·체결가·체결량 3열, 가격색·수량색·대량 체결 강조를 유지한다.
스크롤바가 없어도 하단 방향 휠을 처리하며 조회 중 반복 휠은 중복 요청하지 않는다.
새 체결이 추가돼도 읽던 행의 위치를 보존하고 종목·거래소·날짜 변경 시 목록을
초기화한다. 상시 하단 안내 행은 추가하지 않고 조회 중 표시와 실패 시 재시도만 둔다.

2026-10-21 사용자 요청: 설정의 `체결창 → 대량 체결 강조`를 10호가·호가주문의
최근 체결에도 적용한다. 세 화면은 켬·끔, 기준 금액(만원), 강조 배경색을 공유하며
체결가 × 수량이 기준 이상인 수량 칸만 같은 약 35% 알파 배경으로 강조한다.
기존 가격·매수/매도 글자색과 최근 체결 9건의 배치를 유지한다.

2026-10-15 사용자 승인: 체결창 헤더의 기존 `⋯`(창 옵션) 메뉴에 `설정`을 추가한다.
선택하면 앵커에 붙은 `체결창 설정` 팝오버에서 최소 체결금액을 조절한다. 빠른 선택은
전체·1천만·3천만·5천만·1억이며 직접 입력은 만원 단위 정수로 적용한다. 기본은 전체다.
기준은 단건 체결가 × 체결량 이상이고 기존 대량 체결 강조와 독립적이다. 창별 기준을
배치와 함께 저장하며 종목 변경·새로고침에도 유지한다. 활성 금액은 헤더에 표시하고
넓은 창에서도 설정에 접근할 수 있다. 2026-10-18 체결창 점검 후, 창 액션이 모두
노출된 상태에서는 톱니바퀴로 설정을 바로 열고, 액션이 접힌 상태에서만 `⋯` 메뉴를 쓴다.
필터는 200행 표시 제한 전에 적용한다. 필터 중에는
빈 공간을 채우려고 과거 페이지를 자동 소진하지 않으며 하단 스크롤·휠로 이어 읽는다.

2026-10-15 사용자 승인: `프로그램 체결`을 독립 데이터 창으로 추가한다. 기존 체결창과
같은 표 밀도로 `수신시각 / 현재가(원) / 순매수 증감(주)` 3열만 표시한다. 키움 0w의
이번 수신 순매수수량 증감(FID 211)을 직접 사용하며 양수는 빨강, 음수는 파랑으로
부호와 함께 표시한다. 0 또는 미제공 값은 행을 만들지 않는다. 최신 수신순으로 처음
200행을 표시하며 차트 커서·차트 연결과 독립적이다. 종목·거래소·거래일을 분리하고 하단
안내 행은 두지 않는다. 기존 프로그램 누적/일별 창과 저장 delta의 의미는 유지한다.
같은 날 사용자 요청: 하단 스크롤·휠로 버퍼와 저장 원본의 이전 수신분을 200행씩
이어 표시한다. 조회 중 반복 입력은 중복 요청하지 않고, 실시간 수신 추가 시 읽던
행의 위치를 유지한다. 조회 중 표시와 실패 시 재시도만 일시적으로 노출한다.
원본 저장 전의 과거 수신분을 집계값으로 대체하지 않는다.
같은 날 사용자 요청: 로컬 저장 전의 시간대도 `ka90008` 연속조회로 이어 읽는다.
과거는 공급사의 순매수수량 증감 필드를 직접 표시하고 0인 행은 제외한다. 시간 열은
`시간`으로 표시하며 과거는 키움 제공 시각, 이후 실시간은 수신 시각이다. 최신 REST
시각의 초까지는 과거 행만 사용하고 그 뒤 WS 수신분을 붙인다. 조회 실패를 이력 끝으로
처리하지 않으며 기존 로딩·재시도 동작과 읽던 위치 보존 규칙을 유지한다.
같은 날 사용자 요청: `체결`·`프로그램 체결` 창은 320px 이하에서도 창 이름과 종목명을
한 줄로 표시한다. 제목 옆의 불필요한 스페이서를 숨겨 종목명에 공간을 배정하고,
공간이 부족하면 종목명만 말줄임한다.

최근 해제 내역은 브라우저 탭의 앱 마운트 기간에 최대 20건을 보관한다. 성공한 상태
조회에서 관측이 사라진 것을 `관측 해제`로 표시한다. 클라이언트 정리·서버 재시작도
관측을 지울 수 있으므로 전체 API 복구라고 부르지 않는다. 상태 조회 실패나 관측 필드
누락만으로 해제하지 않는다. 휴장·운영시간 외 대기는 오류 건수에 포함하지 않는다.

이는 ADR-0143의 진단과 렌더 분리 원칙을 유지하면서 §6의 전역 내역 확인을 확장한다.
원인이 같다는 근거 없는 WS/REST 오류 합치기는 하지 않는다.

### 2026-09-30 — 라이브 차트 중심 구성

사용자가 선택한 차트 중심 안을 `/live`에 적용한다. 창 간 여백은 8px로 넓히고,
기존 색상·서체·크기 토큰으로 종목명과 최신 시세의 위계를 구분한다.
종목명·코드·현재가·등락률은 사용자 후속 요청에 따라 한 줄에 배치한다. 현재가의
소유권은 각 차트 타이틀바에 유지하며 커서 시점 시세와 섞지 않는다. 포커스 창은
옅은 배경으로 구분한다. 다른 워크스페이스의 기본 창 간격과 헤더는 유지한다.

2026-10-16 사용자 승인: 캔들 차트 헤더의 현재가·등락률은 고정 폭에 오른쪽 정렬하고,
시세 미제공 시에도 `—`로 자리를 유지한다. 과거 로딩은 헤더 끝의 예약 칸에
`↻ 06/09`처럼 표시하며 완료 후 내용만 숨긴다. 좁은 창은 날짜를 접고 아이콘 칸을
유지한다. 종목명·히트맵 그룹은 남는 폭에서 말줄임하고, 로딩 상태에 따라 주변
항목이 움직이지 않게 한다. 그룹명의 접힘은 기존 창 너비 기준을 유지한다.

2026-10-14 사용자 요청에 따라 창 간 여백을 8px에서 4px로 줄인다. 창 카드는
사방 2px씩 안쪽에 그리며, 창 좌표·저장 배치·흡착 임계(12px)·리사이즈 핸들은 유지한다.

2026-10-12 사용자 요청에 따라 봉 선택·보조지표·그리기와 표시·연동·종목·저장
기능을 모두 도구 행의 버튼으로 제공한다. 좁은 창에서는 라벨을 접고 버튼을
줄바꿈하며 모든 기능에 직접 접근한다. 호가의 커서 조회 시 데이터 기준을 표시하고,
커서 시점에서 같은 연결 그룹의 최신 데이터로 복귀할 수 있게 한다.

2026-10-17 사용자 승인: 선택한 그리기의 옵션 바는 왼쪽 이동 핸들로 차트 안에서
옮길 수 있다. 단일·다중 선택이 같은 창별 위치를 공유하며 종목·봉 주기 변경과
선택 해제 후에도 유지한다. 위치는 페이지 메모리에만 두고 새로고침하면 현재 기본
위치인 차트 상단 중앙으로 돌아간다. 창 크기 변경 시 보이는 영역 안으로 보정하되
원래 기억한 상대 위치는 덮어쓰지 않는다. 핸들 더블클릭·Home은 기본 위치 복원,
방향키는 이동, 드래그 중 Escape는 이동 취소다. 기존 색상·두께 버튼은 이동과
분리하고, 차트 가장자리에서는 하위 옵션 목록의 방향과 위치를 보정한다.

2026-10-23 사용자 승인: 선택 모드의 캔들 플롯에서 우측 드래그로 그리기를 영역
선택한다. 5px 이상 이동하면 기존 accent 테두리·10% 채움의 선택 상자를 표시하며,
교차한 그리기를 미리 강조한다. 2026-10-24 사용자 후속 요청으로 드래그 중 선택
개수 문구는 표시하지 않는다. 놓으면 기존 선택을 교체하고,
Shift를 누른 채 시작하면 기존 선택에 추가한다. 축·다른 pane·다른 창으로 선택을
확장하지 않는다. 잠긴 항목도 선택되지만 이동·편집·삭제 보호는 유지한다. 기존
다중 선택 옵션 바에서 일괄 편집·잠금·삭제를 제공하고, 선택된 항목의 좌측 드래그는
함께 이동한다. 선택 삭제는 기존 실행취소 토스트를 사용한다. 작은 우클릭과 활성
그리기 도구의 우클릭 취소는 유지하며, 영역 선택 중 Escape·포인터 취소·창 포커스
상실은 확정 전 선택을 보존하고 선택 상자만 취소한다.

2026-10-17 사용자 미리보기 승인: 차트 도구 행의 과거 날짜·저장뷰·기간 점프 배지는
봉 주기 선택 묶음과 같은 바깥 높이를 사용한다. 공통 높이는 rem 단위로 밀도 설정을
따르고, 배지 상하 패딩을 제거해 글자와 닫기 버튼을 세로 중앙에 맞춘다. 닫기 버튼에
일반 도구 버튼의 최소 높이를 적용하지 않는다. 글자 크기·색상·좌우 간격은 유지한다.

2026-10-17 사용자 요청: 거래원 창은 커서 조회 중에도 상단의 `커서 시점`·
`실시간으로 복귀` 안내 행을 표시하지 않는다. 기존 커서 연동과 거래원 표는 유지한다.
같은 날 사용자 후속 요청: 10호가 창에서도 `커서 시점`·`실시간으로 복귀`를 제거한다.
정상 분봉 커서 조회에는 안내 행을 표시하지 않으며, 초봉의 저장 호가 기준과
다음 가용·형성 중 상태 안내는 유지한다.
2026-10-19 사용자 후속 요청: `커서 조회 중 · 이전 호가` 안내 행을 제거한다.
조회 중 기존 호가를 유지하며 호가 사다리의 위치가 안내 행 때문에 밀리지 않게 한다.

2026-10-13 사용자 요청에 따라 10호가창·호가 주문창의 폭별 축소 배치를 제거한다.
좁은 창에서도 잔량·체결·상세 통계와 동일한 열 배치를 유지하고 가로 스크롤로
전체 내용을 볼 수 있게 한다. 상세 통계 펼치기·접기 버튼은 제거한다.
기존 21행의 가격·잔량 대응과 매수 시작 높이는 유지한다.
2026-10-14 사용자 요청에 따라 호가 주문창의 새 창 기본 폭은 720px에서 576px,
본문 폭 560px 이상은 기본 5열, 560px 미만은 압축 5열 호가를 사용한다. 모든 폭에서
가격을 중앙에 두고 좌우 주문 열·잔량 열의 폭을 대칭으로 맞춘다. 잔량 막대는 양쪽의
공통 최대 잔량과 같은 표시 폭을 기준으로 계산한다. 사용자 후속 요청에 따라 상세
통계는 기본 576px 창에서도 보이도록 유효 본문 560px 이상에서 호가 영역 우측 상단에
직접 표시하고, 그 미만에서만
정보 버튼의 팝오버로 제공한다. 본문 최소 폭은 504px이며 그 아래는 가로 스크롤로
확인한다. 폰트와 24px 호가 행 높이는 유지하고
560~695px에서는 주문 열 48px·가격 열 144px·좌우 잔량 열 최소 152px로 배치하고,
상세 정보의 좌우 패딩과 라벨·값 간격만 2px로 줄인다. 696px 이상에서는 기존 여백을
유지한다. 전환은 세로 스크롤바를 제외한 유효 본문 너비를 기준으로 한다.
2026-10-23 호가주문 흔들림 수정: 위의 스크롤바 제외 유효 폭 기준을 창 본문 외곽
너비 기준으로 대체한다. 상세정보·여백의 560px·696px 전환은 내부 스크롤바와 독립적으로
판정해 높이 경계에서 상세정보가 반복해서 보였다 숨겨지지 않게 한다. 기존 기본 창
너비·페이지·주문 조작·행 높이를 유지하며 부족한 사다리 공간은 기존 스크롤로 확인한다.
같은 날 사용자 요청: 호가주문 좌우 잔량·상세정보 열의 고정 152px/184px 하한을
실제 숫자·라벨·값·행 여백의 측정 폭으로 대체한다. 양쪽 열은 공통 최소 폭과 대칭을
유지하고, 같은 계좌·종목·글꼴·간격에서 관측한 상세정보 폭은 페이지·값 변경으로 줄이지
않는다. 100만원대 가격에서도 내용이 들어가면 가로 스크롤을 만들지 않고, 실제 내용이
넘칠 때만 스크롤한다. 가격 열·글자 크기·24px 행 높이·주문 조작은 유지한다.
같은 날 사용자 후속 요청: 일반 10호가창도 좌우 열의 고정 184px 하한을 실제 잔량·체결·
상세정보의 측정 폭으로 대체한다. 같은 종목·글꼴·간격에서 관측한 상세정보 최대 폭은
유지하고, 좁은 창의 팝오버 전환 기준 531px·가격 중앙 대칭·22px 행 높이는 유지한다.
100만원대에서도 내용이 들어가면 가로 스크롤을 만들지 않고 실제로 넘칠 때만 스크롤한다.
2026-10-15 사용자 요청: 호가주문창의 주문 입력은 수량 한 칸(주)으로 통일한다.
`주 / 금액` 전환은 빠른 입력 버튼 종류만 바꾸고 수량을 유지한다. 금액 버튼과
Ctrl+1/2/3은 적용 시점의 현재가로 금액을 나눠 소수 주를 버린 수량을 같은 칸에 채운다.
이후 현재가·호버·주문 호가가 바뀌어도 수량은 고정한다.
2026-10-21 사용자 요청: 금액 프리셋 버튼 3개의 마우스 호버 툴팁을 제거한다.
버튼 금액 표시·현재가 기준 수량 환산·현재가 미제공 시 비활성화는 유지한다.
2026-10-16 사용자 후속 요청: 예상 주문금액은 현재가 × 현재 입력 수량으로 계산한다.
호가 행의 마우스 호버·키보드 포커스로 기준 가격이나 예상 금액을 바꾸지 않는다.
입력 수량 또는 현재가가 바뀌면 금액을 갱신하며 가격별 잔량 금액 툴팁은 유지한다.
2026-10-23 사용자 요청: 예상 주문 금액의 `금액` 라벨·표시값 영역에서 기준 가격
네이티브 툴팁을 제거한다. 금액 표시·계산과 접근성 이름은 유지한다.
보유 클릭은 매도 가능 수량을 채우되 버튼 종류를 바꾸지 않는다. 종목 변경은 기존처럼
수량을 비운다. 금액 환산은 현재가 미제공 시 막고, 환산이 0주면 신규 주문을 막는다.
2026-10-15 사용자 요청: 호가주문창은 부분 호가에서도 매도 10행·매수 10행 공간을
확보하고, 남는 높이를 위아래에 동일하게 배분해 매도·매수 경계를 중앙에 고정한다.
매도는 아래에서, 매수는 위에서 채우며 빈 슬롯에는 가격·잔량·주문 버튼을 표시하지
않고 드롭 대상으로도 사용하지 않는다. 체결강도와 최근 체결 9건의 슬롯도 유지한다.
넓은 창의 상세 통계는 확보된 매도 10행에 표시하고, 낮은 창은 24px 행 높이를 유지한
채 스크롤한다. 같은 날 후속 요청으로 일반 10호가창에도 이 중앙 고정 배치를
적용한다. 일반 10호가창은 기존 22px 행 높이와 20행 공간을 유지하며, 부분 호가에서도
상세 요약은 확보된 매도 영역에 표시하고 좁은 창에서만 팝오버로 전환한다.
시·고·저 칩의 공간을 가격 열에 포함한다. 틱 체결 가격은 전일종가 대비
색, 체결 수량은 매수 빨강·매도 파랑을 쓰고, 잔량 유입·유출은 10호가의 순간 증감
로직과 부호·색을 공유한다.
2026-10-18 사용자 미리보기 승인: 10호가·호가주문창의 중앙 가격 열은 종목의 가장
긴 호가 자릿수에 맞춰 배분하고 남는 폭은 양쪽 잔량 열에 돌려준다. 주문창 중앙
하한은 일반 가격 128px·백만 원대 144px·천만 원대 160px이며 실제 글꼴의 숫자 폭이
더 크면 확장한다. 평단가 원이 없는 일반 10호가는 그 공간만큼 더 좁힌다.
같은 종목에서는 확보한 자릿수 폭을 유지하고 종목 변경 시 다시 계산한다.
시고저와 평단가 원은 가격 숫자에 붙여 배치하며 마지막 아이콘과 가격 사이 간격은
4px로 고정한다. 가격 숫자의 우측 끝은 모든 행에서 같고, 가격은 sm(기본 11.5px),
등락률은 한 단계 작은 xs(기본 10.5px)를 사용한다. 확대 글꼴과 좁은 창에서도
가격을 생략하거나 줄이지 않고 필요한 경우 사다리를 가로 스크롤한다.
같은 날 후속 승인한 「좌우 균형」 배치: 가격–등락률은 2px로 붙이고 등락률은
왼쪽 정렬한다. 중앙 묶음 양쪽에 최소 8px를 확보하며 남는 폭도 양쪽에 똑같이
배분한다. 가격·등락률 열은 같은 종목의 공통 텍스트 폭을 유지한다. 주문창의
상세 정보 시작 여백은 잔량과 같은 6px로 맞춘다. 아이콘–가격 4px와 sm/xs 위계는 유지한다.
보유 숫자·수량 입력·프리셋·예상금액은 각각 한 줄로 배치한다. 계좌 그룹과
설정 그룹은 필요한 경우 묶음 단위로 줄바꿈한다. 상단 정보 행은 보유수량·평단가·수익
다음에 매수 가능 금액을 배치한다(2026-10-16 사용자 요청). 매입수량·매입평단가·평가수익·주문수량·예상금액의 화면 라벨은
제거하며 접근성 이름과 매수금액 호버 툴팁은 유지한다.
2026-10-16 사용자 미리보기 승인: 상단의 보유수량·평단가·수익을 각각 7ch·8ch·13ch
열에 오른쪽 정렬하고 항목 간격은 8px로 고정한다. 매수 가능 금액은 17ch 칸에
오른쪽 정렬한다. 창 너비 510px 미만에서는 매수 가능을 항상 둘째 줄에 배치하고
첫 줄 수익 칸은 남는 폭을 사용한다. 자릿수·부호·금액/% 전환으로 배치를 바꾸지
않는다. 칸보다 긴 숫자는 글꼴을 줄이거나 생략하지 않고 그 칸 안에서 가로 스크롤한다.
2026-10-16 사용자 요청: 10호가창·호가주문창의 가격 숫자에 500ms 호버하면 해당
방향의 가격 × 잔량을 `100억`처럼 금액만 억 단위 툴팁으로 표시한다(사용자 후속 요청).
기존 주문창의 `order-tooltip` 스타일과 공통 억 단위 포맷터를 사용한다.
유효 가격의 잔량 0은 0억으로 표시하며, 시·고·저 칩의 별도 툴팁은 유지한다.
2026-10-16 사용자 승인: 주문 설정의 `주문 입력` 프리셋 아래에 기존 체크박스 행과
같은 UI로 `종목별 주문수량 기억`을 추가한다. 기본은 끔이고 변경 즉시 저장한다.
켜면 같은 주문창·계좌·종목의 마지막 수량을 복원하며 직접 비운 입력도 빈칸으로 기억한다.
직접 입력·수량 프리셋·금액 환산 결과를 모두 주 단위로 기억하고 시세로 재환산하지 않는다.
기록 없는 종목은 전환 시 비운다. 끄면 기록을 버리고 현재 입력은 유지한다.
수량 기록은 창을 열어둔 동안만 유지하며 새로고침·창 닫기 후에는 복원하지 않는다.
설정의 켬·끔만 기존 창별 설정에 저장한다.
같은 날 사용자 요청으로 주문 설정 팝오버의 세로 간격을 압축한다. 섹션 구분선
위아래는 각각 12px, 항목 사이와 설명 아래 간격은 8px, 입력 라벨 아래는 4px로
줄인다. 입력창·스위치 크기와 글꼴, 가로 정렬은 유지한다.
2026-10-14 사용자 후속 요청: 10호가 창도 새 창 기본 너비를 511px에서 409px로
20% 축소하고 공장 기본 우측 열도 같은 비율로 줄인다. 기존 저장 배치는 유지한다.
본문 531px 이상은 상세 통계를 그대로 표시하고, 그 미만은 정보 버튼의 팝오버로
옮긴다. 좌우 잔량 열은 항상 같은 폭으로 두고 공통 최대 잔량 기준을 유지한다.
가격 열 163px, 폰트, 22px 호가 행, 체결강도·최근 체결·총잔량은 유지한다.
압축 본문 최소 폭은 387px이며 그 아래에서는 가로 스크롤로 확인한다.
2026-10-14 사용자 후속 요청: 10호가창·호가주문창 모두 시·고·저 아이콘은 호가
가격 왼쪽에만 표시한다. 정보 팝오버와 넓은 창의 상세 통계 영역에서는 아이콘을
제거하고 시작·최고·최저 항목, 가격과 가격 색상은 유지한다.
2026-10-14 사용자 후속 요청: 주문창 하단의 개별 주문 선택·가격/잔여 수량 입력·
정정 접수·취소 접수 UI를 제거한다. 더블클릭 신규 주문, 주문별 수량 칩 드래그 정정,
호가 영역 밖 드래그 취소를 사용한다. 같은 가격의 여러 주문도 각각 드래그하며
호가 밖 주문도 드래그할 수 있다. 직접 주문을 보내는 키보드 단축키는 제거하고,
전체/매수/매도 일괄 취소는 호가 우클릭 메뉴로 제공한다. 기존 1억원 이상 실계좌
주문 금액 확인은 수정 입력 없는 팝업으로 유지한다.
2026-10-21 사용자 요청: 좌우 매수·매도 주문 칸에서 `처리 중` 문구를 제거한다.
미체결 잔여 수량 숫자와 정정·취소 처리 중의 드래그·중복 요청 잠금은 유지한다.
2026-10-23 사용자 A안 선택: 좌우 신규 주문 버튼은 수량이 비어 있거나 0이어도
입력된 상태와 같은 밝기(불투명도 100%)로 표시한다. 기존 매수·매도 배경색을 사용하고
수량 검증·주문 불가 상태·명령 차단은 유지한다. 하단 미체결 합계와 다른 조작 버튼의
비활성 표시에는 적용하지 않는다.
같은 날 사용자 요청: 하단 매수·매도 주문 합계 칸(`0(0)` 등)의 호버 툴팁을 제거한다.
같은 날 후속 요청: 하단 합계 칸을 같은 방향의 가격 주문 칸으로 드래그하면 현재
계좌·종목의 해당 방향 정정 가능한 미체결 주문을 그 가격으로 모아 정정한다. 호가
밖 주문도 포함하며, 이미 목표 가격인 주문은 유지한다. 반대 방향 칸으로 드롭은 무시하고
호가 영역 밖 드래그 일괄 취소·우클릭 개별 주문 목록·고액 확인·신선도 검사는 유지한다.
호가주문 상세정보의 `정보` 글자 라벨은 제거하며 페이지 표시와 전환은 유지한다.
같은 날 사용자 후속 요청: 호가주문 정보 1페이지의 예상 체결가·예상 체결량을
거래대금 아래 마지막 두 행으로 옮기고, 예상 체결가 행 위에 기존 `border` 토큰의
구분선을 표시한다. 좁은 창의 정보 팝오버에도 같은 순서를 적용하며 행 높이·정보 영역
높이·페이지 전환과 10호가창의 기존 순서는 유지한다.
이어진 사용자 요청으로 호가주문 정보 2페이지의 상승VI 행 위에도 같은 구분선을
표시한다. VI 발동 여부와 관계없이 넓은 창·정보 팝오버에 동일하게 적용한다.
2026-10-23 사용자 요청: 10호가창에도 위 호가주문 상세정보 배치를 동일하게 적용한다.
`정보` 글자 라벨을 제거하고, 예상 체결가·예상 체결량을 거래대금 아래 마지막 두 행에
배치하며 예상 체결가와 상승VI 위에 `border` 토큰 구분선을 표시한다. 넓은 창·정보
팝오버 모두 적용하고 기존 높이·페이지 점·전환 동작은 유지한다.
같은 날 사용자 요청: 호가주문 창의 최근 체결은 종목 전환 직후 등 데이터가 없는
슬롯의 체결가·체결량을 대시 대신 빈칸으로 표시한다. 9개 슬롯의 높이와 실제 체결
표시는 유지한다.
이어진 사용자 요청으로 10호가·호가주문의 최근 체결 9건은 체결창과 같은 당일
체결 이력 API로 먼저 채우고 실시간 틱과 중복 없이 합친다. 동일 종목·거래일·
유효 거래소의 조회 캐시를 공유하고 호가창에서는 과거 페이지나 주기 조회를 추가하지
않는다. 과거 커서에서는 현재 체결을 숨기고 시간외 단일가의 합성 체결은 유지한다.
현재가 행을 강조한다. 사용자 후속 요청에 따라 최신 호가의 기준 시각 행, 호가 열 제목과 거래원·체결·잠정투자자의
상시 설명 행, 관심종목·히트맵 패널의 기본 조작 안내를 제거한다. 드래그 목적지와 처리
결과·실행 취소는 동작 중에 표시한다. 라이브 화면에서 80rem 이하의
보조 패널은 겹쳐 열려 차트 영역 폭을 유지하고, 그 이상에서는 기존 도킹을 따른다.

### 2026-10-21 — 종목 선택 즉시 추가와 실패 안내

히트맵 보드·우측 패널, 관심종목 추가 팝오버·편집창은 공통 추가 폼을 사용한다.
검색 결과 클릭 또는 Enter로 즉시 추가하며 별도 추가 버튼은
제거한다. 성공하면 검색어를 비우고 검색창과 포커스를 유지해 연속 입력한다. 공통 토스트로
5초간 추가 성공과 마지막 추가의 실행 취소를 제공하며 호버·포커스 시 타이머를 멈춘다.
실행 취소는 해당 그룹의 등록만 해제한다. 이미 등록된 결과에는 `추가됨`을 표시하고
클릭·키보드 추가를 막는다. 전송 중 검색과 선택을 잠가 중복 전송을 방지한다.
그룹 선택은 검색 위에 두고 전송 중에는 잠근다. 그룹 전환 시 검색·오류·실행 취소를
초기화하며 이전 그룹에서 시작한 응답으로 새 그룹의 입력을 바꾸지 않는다.
`추가됨`의 기존 행 보기로 해당 행을 가리킬 수 있고, 자리 지정 팝오버에서는 기존의
`그 행을 여기로 이동`을 유지한다.
저장·실행 취소 실패 시 공통 오류 배너로 사유와 `다시 시도`를 표시하고 검색과 팝오버를
유지한다. 재시도·다시 검색·닫기 때 이전 오류를 지운다. 영문 포함 코드도 같은 흐름을 사용한다.
이 팝오버의 결과 목록은 내부에서 펼쳐 오류·실행 취소 버튼을 덮지 않게 한다.
화면 높이를 넘는 팝오버는 내부 스크롤하며 추가 완료 뒤 그룹 위치에 다시 맞춘다.

### 2026-10-12 — 차트 현재 종목의 관심종목 추가

차트 제목 표시줄의 종목 식별 바로 옆에 하트를 상시 표시한다. 빈 하트는 미등록,
채워진 하트는 한 개 이상 관심 그룹에 등록된 상태다. 등록 그룹 수와 툴팁의 그룹명은
각 창이 보고 있는 종목을 기준으로 표시하며, 좁은 창에서는 그룹 수만 접는다.
하트는 기존 그룹 선택 팝오버를 직접 연다. 그룹 선택은 즉시 반영하고, 마지막 소속
변경은 실행 취소할 수 있다. 종목 전환 시 열린 팝오버를 닫고, 하트와 팝오버 조작은
창 드래그를 시작하지 않는다. 지수 차트에서는 종목 등록 하트를 표시하지 않는다.

### 2026-10-16 — 설정·보조지표 공통 편집기

사용자 승인 시안에 따라 두 중앙 모달의 폭은 최대 880px, 높이는 min(860px, 86vh),
좌측 탐색 열은 184px로 통일한다. 전체 폭 헤더에 제목·적용 범위·닫기를 두고,
하단에는 즉시 반영 상태와 직전 변경 되돌리기를 고정한다. 좁은 화면에서는 탐색 열과
입력 그리드를 조정하고, 본문·목록은 각자 스크롤한다. 설정의 단일 문서·스크롤 목차와
인라인 검색, 보조지표의 내 지표·지표 추가 구분은 유지한다.

설정 목차는 화면·환경·관리로 묶고, 본문은 소그룹 간격으로 구분한다. 종속 옵션은
부모 아래 세부 설정으로 접으며 검색할 때는 펼친다. 이동평균 편집은 기간·기준가·
색상/두께 순서의 공통 그리드를 사용한다. 스타일 미리보기는 예시 데이터로 현재
색상·두께를 보여주며 실제 시세를 요청하지 않는다.

되돌리기는 이 편집기에서 변경한 필드에만 적용한다. 지표는 원래 창·봉 범위를
보존하고, 다른 경로에서 같은 필드가 바뀌면 오래된 복원을 허용하지 않는다. 서버
설정은 저장 성공 후에만 되돌리기를 등록하고 실제 PATCH로 복원한다. 팔레트의
Escape는 팔레트만 닫으며 편집기와 포커스를 유지한다.

### 2026-10-16 — 호가 주문 보조 창의 공통 편집기 구조

사용자 요청으로 주문 설정·미체결 주문·보유종목에도 제목과 적용 범위가 있는 고정
헤더, 탐색 영역, 스크롤 본문, 고정 푸터를 적용한다. 주문 설정은 640px, 계좌 목록은
800px를 최대 폭으로 사용하고 좁은 화면에서는 탐색을 상단으로 옮긴다. 계좌 목록의
숫자 표는 금액을 자르지 않고 가로 스크롤한다. 미체결 주문은 방향 필터와 목록 건수를,
보유종목은 보유 수량·평단가·평가금액·수익을 정렬된 표로 표시한다. 사용자 후속 요청으로
`수익` 열에는 수익금(원)을 위에, 수익률(%)을 작은 글씨로 아래에 표시한다. 두 값은
기존 주문창과 같은 원본 소수 평단가로 계산하며 수익은 빨강, 손실은 파랑을 사용한다.

기존 버튼 앵커 팝오버를 유지한다. 주문 설정은 사용자 후속 요청으로 변경 즉시
자동 저장한다. 적용·취소 버튼 대신 자동 저장 안내와 닫기를 표시한다. 닫기·Escape·
바깥 클릭은 저장된 값을 유지한다. 비어 있거나 범위를 벗어난 프리셋은 저장하지 않고
마지막 유효 값을 유지하며, 다른 항목의 유효한 변경은 계속 저장한다.
주문 취소는 기존과 같이 즉시 요청하고 진행 상태를 표시한다.
두 동작의 차이는 푸터의 짧은 안내로 명확히 한다. 계좌 탐색은 키보드 방향키를
지원하며, 닫을 때 현재 계좌 탭의 호가 주문창 버튼으로 포커스를 돌려준다.

### 2026-10-16 — 보조지표 목록 이름의 가독성

사용자 요청으로 보조지표의 탐색 열을 기본 184px에서 240px로 넓힌다. 640px 이하에서는
200px, 460px 이하에서는 152px, 360px 이하에서는 132px로 조정해 상세 입력 공간도
확보한다. 긴 지표명은 글자 크기를 유지하고 단어 단위로 줄바꿈하며 말줄임으로 숨기지
않는다. 추가·삭제 버튼은 독립된 영역을 유지한다. 앱 설정의 탐색 폭은 기존대로 둔다.

### 2026-10-16 — 모든 보조지표의 반복 추가

사용자 승인: 카탈로그는 이미 쓰는 종류도 계속 표시하고 항목 수를 보여준다. 설정 후
추가는 새 항목을 생성하고, 내 지표는 종류 아래에 설정 요약을 가진 항목들을 묶는다.
각 항목은 독립적으로 편집·숨김·삭제할 수 있고 설정을 복사해 추가 전 초안으로 연다.
좁은 화면에서는 목록의 항목 선택에 폭을 배정하고 숨김·삭제는 상세 영역에서 제공한다.
캔들 위 지표는 중첩하고 하단 지표는 추가 항목마다 별도 pane을 사용한다. 연속체결
매물대 분포 카드는 서로 겹치지 않게 차트 아래에 세로로 배치한다.

같은 날 사용자 후속 요청: 목록의 항목 수는 지표 이름 옆에 `#1`처럼 한 줄로 표시한다.
좁은 화면의 삭제는 상세 영역에서 제공하고 이름과 개수의 표시 폭을 확보한다.


### 2026-10-20 — 호가 주문 설정을 창 헤더로 통합

사용자 요청으로 본문 계좌 행의 설정 버튼을 제거하고 헤더의 최대화 앞에 공통
톱니바퀴 버튼을 둔다. 캔들 차트와 같은 `WindowSettingsPopover`를 사용하며 폭은
380px, 제목·적용 범위(`이 창에 적용`)·닫기와 스크롤 본문·고정 저장 안내로 구성한다.
2026-10-16 주문 설정의 탐색 영역과 최대 폭은 이 결정으로 대체한다. 주문 입력·호가
표시·주문 알림을 한 본문에 표시하고 공통 설정 행·토글·폰트·간격을 사용한다.
2026-10-21 사용자 요청: 주문 알림에 `매수 체결 소리`·`매도 체결 소리`를 추가한다.
각각 기본 끔이며 창별 즉시 저장과 독립 미리듣기를 제공한다. 같은 날 사용자 후속
요청으로 각각 0.5초로 변경한다. 사용자 선택에 따라 매수는 소프트 코드(부드러운
화음), 매도는 레이더(삐·삐·핑)를 사용한다. 현재 계좌·종목의 새 체결 수량 증가를 알리며 최초
조회 이력은 울리지 않는다.
주문 처리·드래그 중 설정 잠금, 창별 즉시 저장, 잘못된 프리셋의 마지막 유효 값 유지는
계속 적용한다. 좁은 창에서도 다른 헤더 액션과 함께 버튼을 유지한다.


### 2026-10-20 — 스크리너 조건의 항상 편집 방식

사용자가 선택한 `항상 편집` 시안을 적용한다. 조건의 접기·펼치기와 반복되는 범위 배지를
없애고 모든 입력을 항상 표시한다. 라벨·입력·단위를 같은 줄에 배치하며 조건 안에서
남는 폭에 따라 줄바꿈한다. 봉 주기와 비교·검색 방식은 네이티브 선택 상자로 묶고,
볼린저의 기간·표준편차 배수·계산가격도 접지 않는다. 긴 설명은 헤더 도움말로 옮긴다.
기존 글자 크기·테마·밀도 토큰과 키보드 포커스를 유지하고, 검색 의미·파라미터·저장·
조회·조건 조합식·드래그 순서 변경은 그대로 보존한다.

### 2026-10-20 — 스크리너 결과 선택·CSV UI 제거

사용자 요청으로 결과 행·헤더의 체크박스와 선택 건수, 선택 해제, 선택 CSV,
검색 결과 CSV 버튼 및 CSV 안내를 제거한다. 체크박스 열을 없애 결과표 폭도 줄인다.
결과 내 검색·정렬·현재 시세/조회 당시 전환·종목 열기·관심종목 버튼은 유지한다.

### 2026-10-22 — 호가 미수신 상태 안내

10호가·호가주문은 공통 상태 안내로 초기 조회, 실시간 등록 진행, 첫 호가 대기,
구독 슬롯 부족, 연결 복구, 조회 실패를 구분한다. 슬롯 부족은 창 안에 남고
`구독 현황`으로 서비스 상태 패널의 열람 등록 사용량·시장별 대기 종목을 연다.
초기 조회 실패는 `다시 조회`로 해당 종목의 공유 조회를 갱신한다. 체결 수신을
호가 수신으로 해석하지 않으며, 미수신만으로 장 종료·거래정지를 추정하지 않는다.
기존 정상 호가는 날짜 만료 정책 안에서 유지하고 수신 지연 시 마지막 호가 시각을
함께 표시한다. 과거 커서·저장 사다리·시간외 총잔량의 출처 안내와 주문 신선도
검사는 보존한다. 정상 수신 중에는 추가 안내를 표시하지 않는다.
