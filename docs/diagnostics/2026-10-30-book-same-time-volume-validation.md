# 호가 정보 전일 전체/동시간 거래량 비교 검증

- 검증일: 2026-10-30 KST.
- Base: `f9ad45cd13fe2bd0c9f719f2de5cf77c39f3b180` 위의 작업 소스.
- 10호가·호가주문의 `어제보다` 행은 클릭으로 `동시간비`와 전환한다. 라벨·값을
  함께 바꾸고 기존 행 높이·위치·중립색·소수 둘째 자리를 유지한다. 100%가 동일한
  거래량이며 증감률이 아니다. 선택은 창별로 인라인 정보와 팝오버가 공유한다.

## 데이터 출처와 계약

- [키움 공식 0B 예제](https://github.com/Kiwoom-Securities/Kiwoom-REST-API/blob/main/examples/국내주식/실시간시세/subscribe_domestic_stock_trade_pubsub.py)의
  FID 851은 `전일 동시간 거래량 비율`이다. 기존 0B 구독에서 이 필드를 전달한다.
- 기존 정규장 실채록 `tests/fixtures/kiwoom_t2/golden_frames_20260720.json`에서
  000660/005930/373220의 851 원본은 `13878`/`11690`/`9395`다. 0.01% 정수를
  서버에서 `138.78`/`116.90`/`93.95`로 정규화한다. 30의 소수 문자열과 구분한다.
- wire 키는 `vs_prev_same_time_volume_pct`. 같은 프레임의 시장·시각 태그를 보존해
  기존 선택 시장 필터와 초기 series hydration/WS 경로로 전달한다.
- [키움 공식 ka10095 예제](https://github.com/Kiwoom-Securities/Kiwoom-REST-API/blob/main/examples/국내주식/종목정보/get_domestic_watchlist_stock_info.py)에는
  동시간비 필드가 없다. REST 전일 전체 비율로 동시간비를 대체하지 않는다.
- 851 미제공·빈 값·0·불량은 키를 생략하고, 관측값이 없으면 대시로 표시한다.
  새 REST 호출·구독·자격증명은 추가하지 않는다. 기존 버퍼의 키별 마지막 관측값
  유지 정책을 따른다. 과거 커서에서는 기존 요약 비움 정책을 유지한다.
- `/api/live/series`의 동적 프레임 계약을 유지하고 FE `TradeSnapshot`에 optional
  필드를 명시했다. REST `LiveQuote`의 필드나 모델은 변경하지 않았다.

## 검사와 결과

저장소 루트:

```sh
uv run --extra dev ruff check .
uv run --extra dev pytest -q tests/unit/live/test_kiwoom_frames.py tests/unit/live/test_series_route_venue.py tests/unit/live/test_buffer.py tests/unit/live/test_stream.py tests/unit/api/test_rest_wire_schema_contract.py
```

`frontend/`:

```sh
npm run typecheck
npx vitest run src/live/liveSidebarAdapters.test.ts src/live/workspace/BookPanel.test.tsx src/live/workspace/OrderWindow.test.tsx src/live/workspace/DataWindow.test.tsx src/live/workspace/useOrderColumnLayout.test.ts
npx playwright test tests/e2e/live-orders.spec.ts --grep '거래량 비교는 두 창|동시간비가 없으면|예상 체결·VI 가격|정보 시고저 함께 전환' --reporter=line
```

- Ruff 전체 통과, 백엔드 169개 통과, 앱·단위·E2E 타입 검사 통과.
- Vitest 5개 파일 / 444개, Playwright 4개 통과. E2E 서버 기동의 production build 통과.
- 실채록 파싱, 불량 필드가 체결을 제거하지 않는 동작, 버퍼→실제 HTTP 응답의
  필드·값·시장 보존, REST 대체 방지, 초기 hydration과 WS 갱신을 검사했다.
- 마우스·Enter/Space, 창별 독립 선택, 페이지·420px 팝오버 재개방 후 유지,
  타 시장 틱 무시와 전환 전후 호가·정보 행 위치 불변을 확인했다.
- 양쪽 창의 동시간비 스크린샷과 `git diff --check`를 확인했다.

환경: Node v24.13.1, npm 11.8.0, TypeScript 6.0.3, Vitest 4.1.7, Vite 8.0.16,
Playwright 1.60.0, Python 3.14.7, 시스템 Chrome. workers=1, 빈 벤더 자격증명과
슬롯 291의 전용 포트 20291/21291·데이터·dist를 유지했다.

## 입력 지문

2,850개 경로의 SHA-256:
`e4b988c368c2cc48f8440bcd128e6b578d2287ed90d741a0af2b155dbb8bc1e6`.

`git ls-files --cached --others --exclude-standard`의 일반 파일 중 `frontend/`, `hoga/`,
`tests/` 아래와 루트 `pyproject.toml`, `uv.lock`, `.python-version`, `VERSION`, `ruff.toml`을
정렬했다. 각 `UTF-8 경로 + NUL + SHA-256(파일 바이트)`를 이어 붙여 해시를 계산했다.
진단 문서·CONTEXT.md·DESIGN.md는 검사 입력에서 제외했다. 검사 입력과 실행 조건이
동일할 때만 기록을 재사용하며, 변경 시 영향받는 검사를 다시 실행한다.

최신 main 병합 후 검사 대상 HEAD: `95602b2ff8127fb4c7194f797ceea9ba0d4a3c58`. 위 검사를 모두 다시 실행했다.
