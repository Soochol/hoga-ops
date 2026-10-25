# VIX 실제 조회 및 미국 지수 경로 추가

2026-10-25 KST. 사용자 요청에 따라 KIS·키움 범위에서 VIX 조회를 검증하고 기존 미국 지수 방식에 추가했다.

## 실제 조회

- KIS 공식 해외지수 마스터에 `VIX / Volatility Index / VIX 지수 / CBOE`가 있다.
- `FHKST03030100`: `VIX`, 시장 `N`, 일봉 `D` 조회 성공. 최초 20260901–20261025 요청은 35봉을 반환했다.
- 실제 앱의 `fetch_index_daily` 날짜 커서 어댑터로 20260801–20261023을 조회해 3페이지, 60봉(20260803–20261023), `truncated=false`, 오류 메시지 0건을 확인했다. 날짜별 봉의 존재를 공급자의 전체 보관 하한으로 일반화하지 않는다.
- `FHKST03030200`: 정규장 구분 `0`, 과거 포함 `Y`에서 102봉. 2026-10-23 뉴욕 14:34–16:15이며 최신 종가는 19.45다. 당일 전체 OHLC는 19.18/20.66/18.87/19.45다.
- 미국 장이 닫힌 주말의 조회다. 최신 시세의 장중 변화, 거래소 대비 지연, WS 수신, VIX 전체 거래시간은 검증하지 않았다.

기존 실행 중인 앱의 SOX GET 조회 후, 앱이 관리하는 유효 캐시 토큰을 읽기 전용으로 재사용했다. 독립 probe는 토큰을 발급·수정하거나 WS 연결·주문 요청을 하지 않았다. 운영 서버의 정상 인증 생명주기는 기존 앱이 소유한다. 개발/E2E 서버는 무자격을 유지했다.

- [최초 일봉·분봉 원본 응답](kis-live-probe.json)
- [실제 날짜 커서 조회 원본·정규화 봉](daily-history-probe.json)
- [실제 HTTP 라우터를 통과시킨 재생 응답](chart-replay.json)

## 구현

제품 소스는 대표지수 레지스트리, 미국 지수 분봉의 허용 코드, 프론트 지수 ID/미국 판별만 변경했다. `VIX`를 `VIX 지수`로 검색·선택하며 `/live?index=VIX`로 연다. 기존 D/W/M과 1/3/5/10/15/30/60분봉, 헤더, 2초/60초 갱신 정책, 최근 분봉 공유 캐시, 일봉 이력 revision 전송을 재사용한다.

국내 수집·WS 계정 할당·실행 중인 서버 파일은 수정하지 않았다. `VIX`의 국내 투자자 조회는 차단되며, 프론트 회귀 검사에서 국내 일봉·호가·수급 경로에 미국 지수 ID가 들어가지 않는지 확인한다. 분봉 과거 스크롤과 영속 저장은 추가하지 않는다.

## 검증

- 백엔드: VIX 실응답의 HTTP 직렬화·7개 분봉 집계·D/W/M·일봉 compact 응답·당일 전체 OHLC·공유 캐시와 기존 미국/국내 지수 회귀 및 wire 계약 검사.
- 프론트: VIX 검색·URL/그룹/핀·소수점·가격 단위·시간축·국내 API 제외 및 기존 일봉 전송 검사.
- E2E: 기록된 실제 시세 응답을 무자격 서버에서 재생한다. 브라우저가 실자격증명으로 KIS에 직접 연결한 검사가 아니다. VIX 검색 선택·시세 헤더·실제 102봉 표시·5분 전환·재열기·D/W/M 전환·과거 요청 차단·오류 시 마지막 봉 유지·WS 구독 제외를 검사한다.
- 최신 main 반영으로 추가된 Excalidraw 의존성이 기존 워크트리에 없던 첫 타입 검사/서버 빌드 실패는 `npm ci`로 해결했다. 제품 코드를 우회 수정하지 않았다.

검사 결과와 입력 지문은 `verification.json`, 각 명령 출력은 같은 폴더의 로그를 참조한다. 운영 서버에는 이번 VIX 변경을 아직 배포하지 않았다.

공식 근거: [KIS 해외지수 마스터 안내](https://github.com/koreainvestment/open-trading-api/blob/main/stocks_info/overseas_index_code.py), [일봉 API 샘플](https://github.com/koreainvestment/open-trading-api/blob/main/examples_llm/overseas_stock/inquire_daily_chartprice/inquire_daily_chartprice.py), [분봉 API 샘플](https://github.com/koreainvestment/open-trading-api/blob/main/examples_llm/overseas_stock/inquire_time_indexchartprice/inquire_time_indexchartprice.py).
