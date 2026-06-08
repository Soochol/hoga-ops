# 거래원 궤적 today-aware 디스크 seam (#9)

- **Date**: 2026-06-08
- **Status**: Implemented (2026-06-08) — 백엔드+프론트 유닛 완료, 브라우저 실측만 장중 이월
- **Scope**: `both` — `hoga/tables/brokers.py`, `hoga/api/routes.py`(백엔드), `frontend/src/api/brokerSeries.ts`, `frontend/src/live/LiveSidebar.tsx`(프론트)
- **Topic slug**: `broker-trajectory-today-seam`
- **관련**: ADR-0023(거래원 day-anchored), ADR-0013(RangeBundle 단일 read 경로 선례), ADR-0043(Today Promotion), spec 2026-05-24-broker-day-trajectory-design, spec 2026-06-08(seam 사이징 가드 — retention>promote+refetch)

---

## 문제

`/live` 실시간(latest) 모드에서 거래원 궤적이 **당일 09:00부터가 아니라 최근 15분만** 그려진다. 근거(`LiveSidebar.tsx:77-79`): latest 모드의 `brokerSeriesForCard`가 `aggregateBrokerSeries(broker)` — **SSE 라이브 버퍼(15분 시간 eviction)** 스냅샷만 집계한다. `useBrokerSeriesForDay`(전일 디스크 읽기)는 `/replay`에서만 쓰인다(`brokerSeries.ts:15`).

즉 **스크럽/replay는 이미 당일 전체**(parquet 디스크 읽기)지만, **실시간으로 /live를 보는 동안엔 누적 패턴(09:00~지금)을 볼 수 없다** — 거래원 카드의 본질(누가 장 시작부터 매집해왔나)이 latest 모드에서만 깨진다.

근본 원인: 거래원 데이터에 **호가(orderbook) seam의 대응물이 없다.** 호가는 `/api/range`(승격 parquet) + 라이브 버퍼(최근 15분)를 `pastMaxQrT`로 봉합해 당일 전체를 실시간 표시한다. 거래원은 라이브=버퍼 전용 / replay=디스크 전용으로 **두 경로가 한 번도 만나지 않는다**.

인프라는 이미 있다: today-promoter가 brokers.parquet을 5분마다 승격(ADR-0043)하고, `/api/brokers/series`가 그걸 전일로 읽는다. **빠진 건 /live latest(=date==today)에서의 디스크+버퍼 봉합 하나뿐.**

## 접근

**B: 백엔드 today-aware seam** (대안 A 프론트 봉합·C 버퍼 전일화 대비 선택).

- **A(프론트 봉합, 호가 정확 복제)**: 클라이언트가 disk 시리즈 + SSE 버퍼 꼬리를 머지. 꼬리 실시간(SSE 10초)이 장점이나 누적net·top-10 정체성 재조정을 TS에 구현 — `useLiveBundle` prepend 게이트(과거 viewport 순간이동 버그)와 같은 부류의 위험. 기각.
- **C(버퍼 전일화)**: BROKER kind만 15분 eviction 해제. 최소 코드지만 **재시작 시 이전 궤적 소실**(디스크 백필 없음), /replay와 미통일, 버퍼(짧은 봉합용)를 일일 저장소로 확대. 기각.
- **B(선택)**: `date==today`일 때 `/api/brokers/series`가 parquet + 라이브 버퍼를 **서버에서** 합쳐 당일 전체 반환. /live·/replay를 한 read 경로로 통일, 누적net 연속성을 서버 1곳에서 계산(위험한 TS 머지 회피), **재시작 견고**(parquet + JSONL 꼬리로 복원), 방금 ship한 seam 가드가 꼬리 커버리지 보장. 비용: 꼬리 신선도 ≤refetch 주기(~60초) 지연 — 6.5h 스파크라인에서 시각상 미미(사용자 수용).

## 인코딩 (봉합의 핵심)

- 라이브 버퍼 broker 스냅샷: `t_ms = now_ms` = **unix-ms**(`downsampler.py:80`, `/api/live/series`의 `session_open_ms`도 unix-ms).
- parquet `ts_ms`: HHMMSSmmm 인코딩 → 라우트에서 `hhmmssms_to_unix_ms(date, ts)`로 unix-ms 변환(현행 `routes.py`).
- **봉합은 unix-ms 공간에서** 수행: parquet 행을 먼저 unix로 변환한 뒤 버퍼(이미 unix)와 합친다.

## net 연속성 (오프셋 불요)

KIS broker 프레임의 qty는 **당일 누적**(qty_today). 따라서 각 스냅샷의 `net = Σ(buy qty_today) − Σ(sell qty_today)`는 그 시각까지의 **누적net 그 자체**(델타 아님). parquet 마지막 점과 버퍼 첫 점은 연속이므로 **단순 concat**으로 궤적이 이어진다 — 브로커별 오프셋 보정 불필요.

## 봉합점 (중복 제거)

`seam_ms = max(parquet unix ts)`. parquet 점은 `ts ≤ seam`(정착분 권위), 버퍼 점은 `ts > seam`(미승격 꼬리)만 채택 → 겹침 이중계상 방지(`pastMaxQrT` 패턴의 거래원판).
- parquet 비어있음(장 초반 첫 승격 전): `seam_ms = None` → 버퍼 점 전부 채택.
- 버퍼 비어있음/미배선(replay, 또는 buffer 503): parquet 점만 → 현행 동작과 동일.

## source 게이트

라우트는 `source_pref`를 resolve한다(`hogaplay`|`kis_live`). 라이브 버퍼는 **kis_live 캡처**만 대표하므로, **resolved source == kis_live일 때만** 버퍼 꼬리를 합친다. hogaplay 소스는 자체 승격 cadence가 있고 라이브 버퍼와 무관 → parquet-only 반환(현행). 이로써 잘못된 소스의 꼬리가 섞이지 않는다.

## 유닛 경계

`hoga/tables/brokers.py`를 **live-import 없이 순수 유지**(버퍼 스냅샷은 plain dict 리스트로 주입):

1. `series_entries_from_rows(rows: Iterable[tuple[str, int, int]]) -> list[BrokerSeriesEntry]`
   - 현 `query_day_series`의 SQL 이후 꼬리(canonical collapse → 브로커별 group → top-10 by |final_net|)를 **순수 함수로 추출**. parquet·버퍼 공용 → 집계 구현 1개(divergence 차단).
   - 입력 `rows`: `(broker_raw, ts_ms_unix, signed_net)` 튜플. 같은 (canonical broker, ts)는 합산.
2. `broker_rows_from_snapshots(snapshots: Iterable[dict]) -> list[tuple[str, int, int]]`
   - 버퍼 broker 페이로드(`{t_ms, buy_top:[{name,qty}], sell_top:[...]}`)를 `(broker_raw, t_ms, signed_net)` 튜플로. 한 스냅샷 내 buy +qty / sell −qty, 양측 등장 브로커는 합산 — `query_day_series` SQL과 동일 의미.
3. `query_day_series_today(con, path, *, date: str, buffer_snapshots: list[dict]) -> list[BrokerSeriesEntry]`
   - parquet 행 SELECT → `hhmmssms_to_unix_ms(date, ts)` 변환 → unix 행. `seam_ms = max(unix ts)` (없으면 None).
   - `broker_rows_from_snapshots(buffer_snapshots)` → `ts > seam_ms`(또는 seam None이면 전부) 필터.
   - `merged = parquet_unix_rows + buffer_tail_rows` → `series_entries_from_rows(merged)` → **unix-ms entries 직반환**(라우트 재변환 없음).
4. `query_day_series(con, path)` — **무변경**(replay 경로). 내부적으로 `series_entries_from_rows` 재사용하도록 리팩터(동작 동일, HHMMSSmmm ts 유지 → 라우트가 변환).

`hoga/api/routes.py` `brokers_series`:
- `date == today_kst` **and** `resolved source == kis_live` and 버퍼 배선됨:
  - `buffer = lifecycle.get_buffer()`; `snaps = await buffer.get_series(code)`의 broker 스냅샷; `query_day_series_today(...)` → unix entries 직반환(HHMMSSmmm→unix 변환 **건너뜀**).
- 아니면: 현행(`query_day_series` + 점별 `hhmmssms_to_unix_ms` 변환).
- today 판정: `hoga/api/calendar.py`의 KST today helper(`now_kst` 기반 yyyymmdd 비교). 버퍼 미배선/`get_buffer` None이면 parquet-only 폴백.

## 프론트 (최소 전환)

1. `frontend/src/api/brokerSeries.ts`: today-inclusive freshness 추가(`range.ts`의 `rangeFreshnessOptions`와 동형) — `date == todayKst`면 `{ staleTime: 60_000, refetchInterval: 60_000 }`, 과거면 `{ staleTime: Infinity, refetchInterval: false }`. 60초 = 승격 cadence보다 짧아 꼬리가 적시에 전진(seam 가드 불변식과 정합).
2. `frontend/src/live/LiveSidebar.tsx`: latest 모드 `brokerSeriesForCard`를 `aggregateBrokerSeries(broker)`(SSE 15분)에서 `useBrokerSeriesForDay(code, todayKst)`로 전환. spot 모드(`useLiveBrokersAtCursor`)는 무변경. 결과적으로 /live·/replay 거래원 카드가 동일 day-keyed 훅 사용.
3. `aggregateBrokerSeries`는 더 이상 카드에 안 쓰이나 **제거하지 않음**(테스트·잠재 재사용; YAGNI — SSE broker 전송도 무해하니 유지). 후속 audit에서 미사용 확인 시 삭제.

## 에러 처리

- 버퍼 미배선(`get_buffer() is None`)·`buffer.get_series` 예외: parquet-only 폴백(today라도) — 라이브 꼬리 없을 뿐 당일 정착분은 표시, 500 안 냄.
- parquet 없음(승격 전 + 미배선): 기존대로 빈 시리즈.
- canonical 미지 별칭: `broker_names`의 `_unknown_seen` dedup(기존) — 폭주 없음.

## 재시작 견고성

장중 백엔드 재시작 시: parquet(마지막 승격까지) + JSONL 꼬리(writer가 디스크 append, 다음 today-promotion이 흡수)로 당일 궤적 복원. 버퍼는 새 틱부터 다시 채워지고, 그 사이도 parquet+JSONL이 메운다. (C와 달리 메모리 의존 없음.)

## 테스트 전략

**백엔드 유닛**(TDD RED→GREEN):
- `series_entries_from_rows`: canonical collapse(별칭 2개 같은 ts 합산) + top-10 by |final_net| + dominant_side — 기존 `query_day_series` 동작 보존(리팩터 회귀 핀).
- `broker_rows_from_snapshots`: buy/sell 페이로드 → signed 튜플, 양측 등장 브로커 합산, 빈 페이로드 무시.
- `query_day_series_today` 봉합:
  - parquet[09:00..seam] + 버퍼(>seam) → 당일 전체, final_net = 마지막 버퍼 점.
  - seam 경계: `ts == seam_ms` 버퍼 점 **제외**(parquet 권위), `ts > seam` 포함.
  - parquet 빈 → 버퍼 전부.
  - 버퍼 빈 → parquet만(replay 동치).
  - 누적net 연속: 브로커가 parquet 초반 + 버퍼 꼬리 양쪽 존재 → 점이 끊김 없이 이어지고 top-10 정체성은 **합친 당일 전체** |net| 기준.
- 라우트: `date==today & source==kis_live` → merged(unix) / `date==과거` → 현행 무변경 / `source==hogaplay` → parquet-only / 버퍼 미배선 → parquet-only.

**프론트 유닛**: `brokerSeries` today freshness(today→refetch, past→Infinity). `LiveSidebar` latest가 day 훅 사용(spot 무변경).

**브라우저 실측(장중 이월, 비범위)**: 라이브 거래원 틱이 필요(현재 마감). 장중 한 세션에 /live 거래원 궤적이 09:00부터 그려지고 ~60초 내 꼬리 전진, 봉합점 불연속 없음 확인. 회귀: 봉합점 근처 중복/구멍 없음.

## 비범위

- A의 클라이언트 봉합(SSE 실시간 꼬리) — 위험/복잡, 기각.
- SSE broker 전송 제거·`aggregateBrokerSeries` 삭제 — 후속 audit.
- `/api/brokers/series` 외 새 엔드포인트(`/range`류) 신설 — 불요(기존 day-keyed 재사용).
- 브라우저 실측 — 장중 이월.
