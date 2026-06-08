# 안정성 원포인트 3건 — EGW00201 가시화 · 일봉 워크백 조기 종료 · 장외 quotes 게이트

- **Date**: 2026-06-08
- **Status**: Implemented (2026-06-08)
- **Scope**: `both` — backend 2파일(`hoga/live/kis_client.py`, `hoga/live/api.py`) + frontend 1파일(`frontend/src/api/liveQuotes.ts`)
- **Topic slug**: `stability-one-pointers`
- **관련 ADR**: [ADR-0050](../../adr/0050-kis-rate-limit-retry-in-client.md) (EGW00201 재시도 중앙화 — ⑤가 가시화하는 대상), [ADR-0056](../../adr/0056-live-quote-overlay.md) (quote 오버레이 = 표시 전용 — ⑧의 캐시도 표시 전용)

> 원 조사 목록의 ⑥(watchdog 동기 HTTP)은 커밋 0a67a3e(게이트 to_thread 격리)로
> **이미 수정 완료** — 전 호출처 스윕 결과 이벤트 루프 위 잔여 동기 사이트 0건.

---

## 1. 문제 (검증 완료 2026-06-08)

| # | 문제 | 근거 |
|---|------|------|
| ⑤ | EGW00201 재시도(+1~7초 지연)가 완전 무로그 — kis_client.py는 `logging`을 import조차 안 함 | `_get` 재시도 경로(kis_client.py:318-324)에 로그 0줄 |
| ⑦ | `fetch_past_daily_candles` 워크백 루프에 from 도달 조기 종료 분기 누락 — 형제 `fetch_investor_net`(:720-726)에는 있음 | 콜드 갭마다 +1콜, 일봉 차트 열어둔 동안 today 프로브(60s TTL × 60s refetch)가 분당 2콜→1콜이어야 함 |
| ⑧ | quotes 폴링이 24시간 무게이트 — 프론트 `refetchInterval: 10_000` 무조건, 백엔드 `_quote_phase`에 "closed" 개념 자체가 없음(`pre_open`/`open`뿐), fetch 무단락 | liveQuotes.ts:32-34, api.py:313-317·383-396. 드로어 시나리오 일일 ~8,640폴(30종목 청크 기준; 원 주장 ~3.5만은 ~4배 과장) |

## 2. 결정 사항 (사용자 확정 2026-06-08)

1. **장외 표시 = 마지막 시세 유지** — 백엔드가 장중 마지막 quotes를 메모리에 보관해 closed에도 서빙. 가격 공백('—') 회귀 금지.
2. **폴링 창 = 평일 08:50–16:00** — KRX 장전 동시호가 08:50 시작(사용자 정정 — 구 08:30 아님) ~ 장후 종가매매 종료 16:00. 시간외 단일가(16–18시)는 미추적.
3. 시계 기반 판정 — 평일 공휴일의 드문 낭비는 수용. 캘린더 게이트는 동기 KIS HTTP 문제를 재도입하므로 배제.

## 3. 설계

### ⑤ 재시도 가시화 (`kis_client.py`, ~6줄)

- 모듈 로거 신설(`log = logging.getLogger(__name__)` — 타 모듈 관례).
- `_get` 재시도 except 분기: **첫 재시도(attempt==0)는 WARNING, 이후는 DEBUG** —
  지속 장애 시 로그 벽 방지(병렬 fetch 도입으로 동시 재시도 최대 5×3). 소진 후엔
  기존 `kis_rate_limit` data_warning이 최종 신호로 이미 존재.
- 내용: path, 시도 n/총, 대기 초.

### ⑦ 워크백 조기 종료 (`kis_client.py`, ~3줄)

`fetch_past_daily_candles` 루프에서 `page_earliest` 계산 후, 형제 함수와 동일하게
`if page_earliest <= from_yyyymmdd: break` — cursor 갱신 전에. `page_earliest is
None → continue`(violation-only 페이지) 경로는 유지.

### ⑧ 장외 quotes 게이트 (`api.py` ~20줄 + `liveQuotes.ts` ~5줄)

**백엔드**:
- `_quote_phase` → `Literal["pre_open", "open", "closed"]`:
  주말 또는 `t < 08:50` 또는 `t >= 16:00` → `closed`; `08:50 ≤ t < 09:00` →
  `pre_open`; 나머지 → `open`.
- `build_router` 스코프 `_last_quotes: dict[str, KisQuote]` — open/pre_open 윈도의
  성공 fetch마다 갱신(표시 전용 — ADR-0056 결 유지, 디스크 미영속).
- closed 분기: 요청 코드를 캐시에서 서빙. **캐시 미스 코드가 하나라도 있으면
  `fetch_multi_price` 1회만 호출해 캐시를 채운 뒤 서빙** — 서버 재시작 직후 페이지
  로드에서도 종가 표시 보장(KIS는 장외에도 종가를 반환). 프론트가 closed에 폴링을
  사실상 멈추므로 이 경로는 드로어 마운트 시에만 탄다.

**프론트엔드** (`liveQuotes.ts`):
- phase 타입에 `'closed'` 추가.
- `refetchInterval`을 함수로: `data?.phase === 'closed' ? 600_000 : 10_000`.
  **`false` 금지** — 완전히 끄면 재평가 계기가 없어 다음 개장에 폴링이 재개되지
  않는다. 600초 하트비트는 08:50 후 최대 10분 내 자동 복귀하면서 절감률 유지.

효과: 일일 폴링 ~8,640 → ~2,680 (**~69% 절감** — 창 7h10m × 6폴/분 ≈ 2,580 +
나머지 16h50m × 0.1폴/분 ≈ 100).

## 4. 테스트 전략 (TDD — 각각 RED 먼저)

1. ⑤ caplog: 재시도 1회째 WARNING(경로·시도수 포함) + 2회째 DEBUG — 기존
   rate-limit retry 테스트(test_kis_client.py) 확장.
2. ⑦ from 도달 시 추가 KIS 콜 없음 — `fetch_investor_net`의 기존 조기 종료 테스트
   패턴을 미러(호출 핸들러의 anchor 기록 단언).
3. ⑧-a `_quote_phase` 경계: 평일 08:49→closed, 08:50→pre_open, 09:00→open,
   15:59→open, 16:00→closed, 토요일 10:00→closed.
4. ⑧-b closed 캐시 서빙: open에서 1회 fetch 후 closed 요청 → KIS 무호출 + 직전
   quotes 반환. ⑧-c closed 콜드 스타트: 캐시 빈 상태 closed 요청 → KIS 정확히
   1회 + 이후 요청 무호출.
5. ⑧-d 프론트: refetchInterval 함수 단위 테스트(phase별 반환값) — 기존
   liveQuotes 테스트 파일 관례를 따름.

## 5. 수용한 트레이드오프

- 평일 공휴일에 08:50–16:00 동안 폴링 지속(시계 게이트의 한계) — 연 ~15일 ×
  ~2,700폴, 캘린더 게이트의 복잡도·동기 HTTP 위험보다 싸다.
- 시간외 단일가(16–18시) 가격 변동 미추적 — 사용자 결정(정규장 중심 사용).
- `_last_quotes`는 메모리 전용 — 재시작 시 소실되나 콜드 스타트 1회 fetch가 보정.

## 6. plan 단계에서 확정할 것

- ⑦ 테스트의 fixture 형태 — test_kis_rest_methods.py의 기존
  fetch_past_daily_candles 페이지네이션 테스트 유무 확인 후 그 패턴 재사용.
- ⑧ 백엔드 테스트 거처 — test_live_quotes_route.py 존재 확인(있으면 거기).
