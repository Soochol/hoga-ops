# P2 cleanup 3건 — 개장 sleep · 브로커 canonical · refresh 상태 순서

- **Date**: 2026-06-08
- **Status**: Implemented (2026-06-08)
- **Scope**: `both` — `hoga/live/ws_client.py`(#3), `hoga/live/ws_frames.py`(#10), `hoga/live/lifecycle.py`(#13)
- **Topic slug**: `p2-cleanup`
- **관련 리뷰**: 2026-06-07 멀티에이전트 리뷰 #3·#10·#13 (cleanup 클래스). 작고 독립적인 3건을 한 묶음으로.

---

## #3 — 개장 sleep 단축 (매 거래일 30초 유실)

### 문제
`ws_client.run`의 게이트 닫힘 분기(ws_client.py:79)가 `await asyncio.sleep(30)`. 게이트가 09:00에 열려도 직전 체크가 08:59:3x였으면 다음 체크가 09:00:0x~09:00:29 → 연결+approval+39 구독이 최대 30초 늦음. **매 거래일 개장 직후(하루 중 최대 체결 밀도) 최대 30초 유실** — 표시·저장 양쪽.

### 설계
`sleep(30)` → `sleep(1)`. 개장 ~1초 내 진입(구 poller가 1초 게이트 주기로 보장하던 것 승계).

**부하 안전성**: 게이트 닫힘 동안 1Hz로 `to_thread(ws_capture_window)` 호출되지만 — 한밤중(market_phase=="closed")엔 `should_run_now`가 시계만 보고 즉시 False(캘린더 호출 0). 개장 임박~장중에만 캘린더를 보는데 month_cache(24h) + failure negative-cache(60s)로 캐시 히트가 싸다. to_thread 1Hz 스레드 오버헤드도 미미.

**의식적 결정**: 동적 "09:00까지_초, 상한 캡" 대신 고정 1초 — calendar closed-path가 시계만이라 한밤중 폴링이 사실상 무료이고, 동적은 코드·테스트만 늘린다(gold-plate 회피, advisor). line 79는 게이트-닫힘 대기 전용이고 재연결 백오프(line 114)와 별개라 이 변경이 재연결 페이싱을 안 건드린다.

### 테스트
게이트가 닫힘→열림으로 바뀔 때 연결까지의 폴링 간격이 짧음을 핀. 기존 `test_run_does_not_connect_while_gate_closed` 패턴 + IDLE 단축 monkeypatch로 sleep 값 확인(또는 sleep을 monkeypatch해 호출 인자 1.0 단언).

---

## #10 — 브로커명 canonical (live/replay 식별자 분기)

### 문제
`ws_frames._parse_member`(ws_frames.py:150·154)가 회원사명을 `f[n].strip()` raw로 방출. 삭제된 REST `fetch_brokers`가 경계에서 보장하던 `broker_names.canonical()` 정규화가 누락 → live(raw '신한증권')와 replay(brokers.parquet 읽기 시 `query_day_series`가 canonical '신한투자증권')가 **같은 거래원을 다른 이름으로 표시**, unknown_alias 계측도 캡처 경로에서 소실.

### 설계
`_parse_member`의 두 `f[n].strip()`을 `broker_names.canonical(f[n].strip())`로. import 추가. broker 틱은 on_tick→buffer(표시)와 게이트 시 downsampler→JSONL→promote→brokers.parquet(저장) **양쪽으로 흐르므로**, parse 경계 1곳 정규화가 표시·저장·SSE·parquet 전부를 정규명으로 통일. replay 읽기 canonical은 멱등(이미 정규명이면 그대로) → live=replay 일치.

**경보 안전**: `canonical`은 `_unknown_seen` set으로 미지 raw당 1회만 warning(broker_names.py:104-107) — 매 틱 폭주 없음. 부수효과로 unknown_alias 계측이 live 캡처 경로에 복원된다.

### 테스트
`_parse_member`가 별칭 raw(예: '신한증권')를 정규명('신한투자증권')으로 방출함을 핀 — "canonical이 호출됨"이 아니라 **방출된 name이 정규명**임을 단언(live=replay 동치의 직접 증거). `broker_names._CANONICAL`의 실제 매핑 1건을 fixture로.

---

## #13 — refresh_live_stream 상태 갱신 순서 (failure-domain ordering)

### 문제
`refresh_live_stream`(lifecycle.py:475-477)이 `await ws.update_codes` → `set_active_codes` → `await drop_codes_except` → `_state = replace(...)` 순. **durable 상태(`_state.watchlist_codes`) 갱신이 마지막 줄**이라 위 어디서든(특히 ws send 또는 drop) 예외가 나면 _state가 stale로 남아 **today-promoter가 옛 Live Set을 계속 promote**하고 downsampler가 퇴출 코드 carry를 유지한다(라우트 except가 삼켜 무재동기).

### 설계 (advisor: 전체 줄 고치는 순서 재배치 > update_codes만 try-wrap)
**failure-domain 순서**: durable·로컬 상태를 먼저 확정하고, ws send와 ring 정리는 best-effort로:

```python
codes_set = set(codes)
stream.set_active_codes(codes_set)   # sync, downsampler carry 정리 — raise 없음
global _state
_state = replace(_state, live_set=tuple(codes), watchlist_codes=tuple(codes))  # durable 확정(today-promoter가 읽음)
try:
    await _buffer.drop_codes_except(codes_set)
except Exception:   # noqa: BLE001 — ring 정리 실패는 다음 정리까지 메모리 잔존, 비치명
    _log.exception("live.stream.drop_codes_failed")
try:
    await stream.ws.update_codes(codes)   # ws send: 실패해도 내부 self._codes는 send 전 갱신돼 재연결 자가치유
except Exception:   # noqa: BLE001
    _log.exception("live.stream.update_codes_failed")
```

핵심: `_state`(promote가 보는 권위)와 `set_active_codes`(carry 정리)는 raise 없는 연산이라 **무조건 먼저 확정**. ws send/drop 실패는 로그 후 진행 — ws는 재연결 시 새 `self._codes`(send 전 갱신됨)로 전체 재구독해 자가치유.

### 테스트
`drop_codes_except` 또는 `ws.update_codes`가 raise하도록 스텁 → refresh 후에도 `_state.watchlist_codes`가 새 codes로 갱신됐고 `set_active_codes`가 적용됐음을 핀(durable 상태가 ws 실패와 무관하게 확정). 기존 `test_refresh_live_stream_updates_ws_and_buffer` 정상 경로 무수정 그린.

---

## 비범위
- #9 거래원 궤적 15분 절단(ADR-0023 row-churn): 디스크 seam 신설이 필요해 큼 — 별도(P2). 이 묶음은 작은 3건만.
- 크로스 스택 seam 상수: range.ts 5min/15min/promote env 동기화 검증 — 별도.

## 테스트 전략 요약
3건 각각 TDD(RED→GREEN). 백엔드 전체 회귀 + (#10은 프론트 거래원 표시 무영향 확인). ruff baseline 외 신규 0.
