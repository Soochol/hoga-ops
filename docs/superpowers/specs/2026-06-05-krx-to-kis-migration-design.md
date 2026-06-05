# KRX 로그인·종목 검색·거래일을 KIS로 이전 — 설계서

- 날짜: 2026-06-05
- 상태: 설계 승인 대기
- 관련 모듈: `hoga/api/symbols.py`, `hoga/api/calendar.py`, `hoga/live/kis_client.py`, `hoga/api/models.py`, 신규 `hoga/api/kis_master.py`, 신규 `hoga/api/kis_holidays.py`

---

## 1. 배경과 목표

지금 이 프로젝트는 두 가지를 **pykrx 라이브러리 + KRX 로그인(`KRX_ID`/`KRX_PW`)** 으로 받아온다.

1. **종목 목록** — 종목 검색의 데이터. KRX에 로그인해 KOSPI/KOSDAQ 보통주 약 2,600개의 `(코드, 이름)`을 종목당 한 번씩 긁어온다(`symbols.py`).
2. **거래일 달력** — 캘린더·기간 캡처·라이브 폴러가 쓰는 거래일 목록. 삼성전자 시세가 있는 날인지로 거래일을 *짐작*한다(`calendar.py`).

"KRX 로그인"은 그 자체가 기능이 아니라 이 두 데이터를 받기 위한 통로일 뿐이다. 이 둘을 이미 성숙하게 갖춰진 **KIS Open API**로 옮기면 KRX 로그인을 통째로 없앨 수 있다.

**목표**: `KRX_ID`/`KRX_PW`와 pykrx 의존성을 **완전히 제거**하고, 종목 목록과 거래일을 KIS로 받는다.

**검증된 사실(1차 소스)**:
- 종목 목록 → KIS가 배포하는 정적 압축 파일 `kospi_code.mst.zip` / `kosdaq_code.mst.zip` (`koreainvestment/open-trading-api : stocks_info/kis_kospi_code_mst.py`). **로그인·토큰 불필요.**
- 거래일 → KIS REST `chk-holiday`(CTCA0903R, `/uapi/domestic-stock/v1/quotations/chk-holiday`). **토큰 필요.**

---

## 2. 범위

| 항목 | 결정 |
|---|---|
| 이전 대상 | **둘 다** (종목 목록 + 거래일). 하나라도 pykrx에 남으면 `KRX_ID`/`KRX_PW`가 계속 필요하므로 "로그인 제거"가 안 된다. |
| 검색 종목 범위 | **보통주 + ETF + ETN**. ELW·SPAC은 제외. (현재는 보통주만) |
| 검색 로직 | **그대로**. 부분일치·코드 prefix 매칭. 데이터 출처만 바뀐다. |
| 갱신 자동화(일일 스케줄) | **범위 밖**. 후속 과제(§10). |

---

## 3. 접근 방법 — "데이터 받는 함수의 속만 교체"

두 모듈 모두 pykrx 호출이 **단일 함수에 격리**돼 있다:
- `symbols.py` → `_fetch_from_pykrx()` 한 곳
- `calendar.py` → `_trading_days_for()` 한 곳

이 두 함수의 **내부 구현만** KIS 방식으로 바꾼다. 그 위에 얹힌 저장·검색·캐시·달력·폴백 코드는 건드리지 않는다. 새로 위험해지는 코드는 "압축 파일 파싱"과 "휴장일 조회" 두 군데로 좁혀진다.

기각한 대안:
- **종목+거래일을 한 모듈로 묶기** — 종목은 무인증 정적 다운로드, 거래일은 토큰 REST로 성격이 달라 응집도가 나쁘다.
- **pykrx + KIS 듀얼 토글** — pykrx가 남아 "로그인 제거" 목표와 배치된다.

---

## 4. 종목 목록 설계

### 4.1 신규 `hoga/api/kis_master.py`

`.mst` 압축 파일을 받아 종목 목록으로 만드는 책임만 갖는다. **다운로드와 파싱을 분리**해 테스트가 네트워크 없이 커밋된 fixture를 파싱할 수 있게 한다.

```
download_master(market) -> bytes          # zip 내려받아 압축 해제한 원본 바이트
parse_master(raw: bytes) -> list[MasterRow]   # 순수 함수, 네트워크 없음
fetch_symbol_master() -> list[MasterRow]  # 위 둘을 코스피+코스닥에 대해 합성
```

**파싱 규칙(함정 주의)**:
- 인코딩은 **cp949**.
- 각 줄은 `[앞쪽 코드 필드들][가변폭 한글명][뒤쪽 228바이트 고정블록]` 구조다. 한글명은 구분자(쉼표)로 잘린 CSV 필드가 **아니라**, 앞 코드 영역과 뒤 228바이트 사이의 **가변폭 중간 슬라이스**(`row[offset : len(row)-228]`)다. → **공식 스크립트의 byte-offset 슬라이싱을 그대로 차용**하고, 쉼표 split을 직접 만들지 않는다.
- 종목코드는 단축코드(앞쪽 9바이트 영역에서 추출).

**종류 판정**: 뒤쪽 고정블록의 **증권그룹구분코드**(`ST`=주식 / `EF`=ETF / `EN`=ETN / `EW`=ELW 등) 단일 필드에서 도출한다. ETP/SPAC/ELW 불리언 플래그를 조합하지 않는다(취약). `ST`/`EF`/`EN`만 남기고 나머지(ELW·SPAC 등)는 버린다. → fixture 고정 시 이 그룹코드 필드가 `ST`/`EF`/`EN` 분류를 담는지 실제 파일로 확인한다.

`MasterRow` = `(code, name, market, security_type)` 여기서 `security_type ∈ {stock, etf, etn}`.

### 4.2 `hoga/api/symbols.py` 변경

- `_fetch_from_pykrx()`의 **본문만** `kis_master.fetch_symbol_master()` 호출로 교체하고, 출처에 매이지 않는 이름 `_fetch_symbol_master()`로 바꾼다.
- 이 함수가 반환한 뒤의 모든 코드(디스크 저장, 메모리 캐시, 검색, 캐시 상태머신)는 **그대로**.
- 동기 블로킹 함수 그대로 유지 — 현재 `refresh()`가 threadpool에서 호출하는 구조를 깨지 않는다.

### 4.3 디스크 저장 형식

- 종목 항목에 `security_type` 칸을 추가하고 `schema_version`을 2로 올린다. `source`는 `"kis_mst"`.
- 부팅 시 옛 v1 파일은 "형식 불일치"로 무시된다(기존 동작). **단**, 아래 자동 받기로 빈 화면을 피한다.

### 4.4 업그레이드 날 자동 받기 — **명시적 결정**

기존의 "수동 Update 버튼만" 정책은 *pykrx가 느리고 로그인이 필요했기 때문*에 있었다. `.mst`는 빠르고 무인증 단일 다운로드라 그 근거가 사라졌다. 따라서:

- **부팅 시 캐시가 비어 있으면(또는 형식 불일치면) 백그라운드로 자동 1회 받아온다.** 부팅 자체는 막지 않는다(현재처럼 디스크만 읽고 즉시 기동, 받아오기는 비동기 백그라운드 태스크).
- 수동 Update 버튼은 그대로 유지(강제 갱신용).

이로써 스키마 업그레이드 직후에도 검색이 빈 채로 남지 않는다.

### 4.5 `hoga/api/models.py`

- `SymbolHit`에 `security_type: Literal["stock","etf","etn"]` 칸을 추가한다.
- `market`은 그대로 `Literal["KOSPI","KOSDAQ"]`(ETF/ETN도 상장 시장은 KOSPI/KOSDAQ).
- 검색 결과 화면에서 `etf`/`etn`에 작은 종류 표시를 단다(보통주는 표시 없음 — 현재 모습 유지).

---

## 5. 거래일 설계

### 5.1 동기 유지 — async 파급을 만들지 않는다

`_trading_days_for()`를 부르는 곳은 `calendar.py` 내부 3곳(`get_month_map`, `trading_days_in_range`, `is_trading_day`)에 더해 **외부 5곳**(`captures.py`, `scheduler.py`×2, `screener.py`, `poller.py`)이다. 특히 `screener.status()`는 **동기 FastAPI 라우트**다. 이 함수들을 비동기로 바꾸면 라우트 시그니처까지 연쇄로 async화해야 한다.

거래일은 월별로 캐시되는 저빈도 cold-path다. 따라서 **`_trading_days_for()`를 동기 블로킹 함수로 그대로 두고**, 그 내부에서 휴장일 조회를 **동기로** 호출한다. 다른 5개 파일은 한 줄도 바뀌지 않는다.

### 5.2 신규 `hoga/api/kis_holidays.py` — 동기 휴장일 조회

`chk-holiday`를 **동기 httpx**로 호출한다(`KisClient`의 async 경로를 거치지 않는다).

**토큰 공유(핵심 결정)**:
- KIS 토큰의 조율점은 **디스크 캐시 `kis-token.json`**(`{access_token, expires_at}`)이다. `KisClient._read_cache()`가 이미 순수 동기 읽기다 — 같은 파일·같은 형식을 재사용한다.
- 동기 경로는 캐시를 읽어 만료 전이면 그 토큰을 쓴다.
- **만료/부재 시 동기로 발급한다** — 작은 동기 httpx `POST /oauth2/tokenP` → 같은 캐시 파일에 기록. **평일-폴백으로 떨어지지 않는다.** (떨어지면 검색 전용 프로세스는 토큰을 영영 못 얻어 달력이 항상 폴백이 된다.)
- 1분 쿨다운 상태(`_last_issued_monotonic_ms`)는 `KisClient` 메모리에 있어 동기 발급기가 못 본다. 그러나 동기 경로는 *진짜 만료 시에만* 발급(재시도 폭주 없음)하므로 쿨다운에 걸리지 않는다. 최악은 만료 경계에서 `/live`와 동시 이중 발급 1회 — KIS가 6시간 내 같은 토큰을 돌려주므로 **무해**(lockout 아님)하다.

**응답 처리(방어적 — 호출 횟수를 단정하지 않는다)**:
- 1차 소스로도 `chk-holiday`가 하루치만 주는지 한 달치를 주는지 단정할 수 없다(범위 파라미터 없음, 예제가 output을 단일/리스트 양쪽으로 coerce, "1일 1회 호출 권장"만 명시).
- 따라서 **양쪽 모두에 견고하게** 구현한다: output을 `단일 dict 또는 list`로 받아 정규화하고, **요청한 월이 다 덮일 때까지 `BASS_DT`를 앞으로 옮겨가며 반복**한다(한 번에 다 오면 1회로 끝나고, 하루치면 그 달 일수만큼 반복). 거래일 판정은 `opnd_yn`(개장일 여부)으로 한다.
- 최악인 31회 순차 동기 호출도 네트워크 RTT로 자연히 분산되어(~1–2초) 별도 rate-limit 처리가 필요 없다. spec은 "월 1회"라고 주장하지 않는다.
- 정확한 응답 키 이름(`opnd_yn` 등)은 자체 생성 fixture로는 틀려도 통과하므로, **실제 응답 캡처로 확정**한다.

### 5.3 `hoga/api/calendar.py` 변경

- `_trading_days_for()` 본문의 pykrx 호출을 `kis_holidays`의 동기 조회로 교체. 반환 형식(`set[str] | None`)·캐시(`_month_cache`)·실패 사유 노출은 그대로.
- `is_trading_day`/`trading_days_in_range`/`get_month_map`/폴백 `_all_weekdays_in_month`는 **변경 없음**.

### 5.4 폴백 — KIS 실패 시

기존 폴백을 유지한다: 휴장일 조회가 실패하면 `_all_weekdays_in_month`(평일=거래일)로 달력은 계속 뜨고, 라이브 폴러는 계속 돈다(관대한 기본값). 단 §5.2대로 토큰 발급 실패는 폴백이 아니라 동기 발급으로 먼저 해소를 시도한다.

---

## 6. KRX 흔적 정리

두 경로를 옮기고 나면 아래가 모두 죽은 코드가 되어 함께 제거한다.

| 위치 | 제거/교체 |
|---|---|
| `env.py` | `KRX_ID`/`KRX_PW`, `krx_creds_present()` |
| `symbols.py` | `_ensure_krx_credentials`, `KrxCredentialsMissing`, `KrxFetchFailed` → KIS 마스터용 에러로 교체 |
| `error_codes.py` | `KRX_CREDENTIALS_MISSING`, `KRX_FETCH_FAILED` → KIS 상황 코드로 교체 |
| `calendar.py` | `KrxUnavailableError`(코드값만 KIS로) |
| `captures.py` | "Configure KRX_ID / KRX_PW …" 503 메시지 → KIS 안내로 |
| `frontend/src/api/upstream-hints.tsx` | KRX 자격증명 안내 문구 → KIS 안내 |
| `.env.example`, `CLAUDE.md` | KRX_ID/PW 설명 제거 |

---

## 7. 에러 처리와 인증 비대칭

| 기능 | KIS 토큰 필요? | 실패 시 |
|---|---|---|
| 종목 목록 | **불필요**(정적 다운로드) | 받기/파싱 실패 → 기존 캐시 있으면 `stale`, 없으면 `unavailable`. (기존 처리 그대로) |
| 거래일 | **필요** | 조회 실패 → 평일=거래일 폴백. 토큰 만료는 동기 발급으로 우선 해소. |

**인증 비대칭은 순이득이다(명시)**: 이전 후 KIS 자격증명만 가진 사용자(이 프로젝트의 `/live` 사용자)는 종목 검색(무인증 `.mst`)과 달력(토큰) **둘 다** 동작한다. 지금은 둘 다 `KRX_ID`/`KRX_PW`가 있어야 한다. → 엄밀히 더 나아진다.

---

## 8. 의도적으로 건드리지 않는 것

- **거래일 호출자 5개 파일**(`captures`/`scheduler`/`screener`/`poller`) — §5.1 동기 유지로 변경 없음.
- **월별 캐시 `_month_cache`에 락을 추가하지 않는다** — 동기 유지 하에서는 check-then-populate 경쟁이 *지금과 동일*하다(executor 스레드 + 이벤트루프 스레드, GIL-원자적 dict 연산, 비원자적 check-then-set). 결과는 같은 값을 한 번 더 받아오는 무해한 중복이며, 스레드 모델을 바꾸지 않으므로 **새 위험이 없다**.
- **검색 로직·캐시 상태머신·달력 셀 상태** — 데이터 출처만 교체.

---

## 9. 테스트 전략

- **`.mst` 파서**: 실제 파일 조각을 커밋된 fixture로 둔다(직접 만든 가짜 데이터는 byte-offset이 틀려도 통과하는 함정). 보통주·ETF·ETN·ELW를 한 개씩 넣어 **걸러내기와 `security_type` 판정**을 검증. `parse_master(bytes)`는 네트워크 없이 테스트.
- **휴장일 조회**: 실제 응답을 fixture로 두고 `opnd_yn` 읽기 + single/list 정규화 + `BASS_DT` 전진 루프를 검증. **응답 키 이름을 실제 응답으로 확정.**
- **토큰 공유**: 만료 전 캐시 재사용 / 만료 시 동기 발급 / 발급 실패가 폴백이 아님을 검증.
- **회귀**: 기존 검색·캐시·달력 테스트는 데이터 받는 함수만 monkeypatch하므로 **대부분 그대로 통과해야 한다**. 통과하지 않으면 그게 회귀 신호다.

---

## 10. 후속 과제(범위 밖)

- 종목 목록·거래일의 **일일 자동 갱신 스케줄**(현재는 부팅 시 자동 1회 + 수동 Update).
- ETF/ETN의 **캡처·라이브 시세 동작 검증** — 검색 노출과 별개로, 선택된 ETF 코드가 hogaplay 캡처/KIS 라이브에서 제대로 처리되는지는 별도 확인이 필요(사용자도 인지).

---

## 11. 손대는 파일 요약

| 파일 | 변경 |
|---|---|
| `hoga/api/kis_master.py` | **신규** — `.mst` 다운로드/파싱(분리), `security_type` 판정 |
| `hoga/api/kis_holidays.py` | **신규** — 동기 `chk-holiday` 조회 + 토큰 공유 발급 |
| `hoga/api/symbols.py` | 받는 함수 본문·이름 교체, 디스크 스키마 v2 |
| `hoga/api/calendar.py` | `_trading_days_for` 본문 교체(동기 유지) |
| `hoga/api/models.py` | `SymbolHit.security_type` 추가 |
| `hoga/live/kis_client.py` | 토큰 캐시 파일 형식·경로를 동기 경로와 공유(필요 시 동기 토큰 헬퍼 노출) |
| `hoga/env.py`, `error_codes.py`, `captures.py`, `frontend/.../upstream-hints.tsx`, `.env.example`, `CLAUDE.md` | KRX 흔적 제거/교체 |
