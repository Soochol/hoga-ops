# 설계안 — 키움 WS 실시간 분봉 캔들 합성 (방식 a')

- 작성: 2026-07-23
- 상태: **제안(미구현)** — 구현 전 승인 대기
- 관련: ADR-0040/0043(실시간 승격본 candles.parquet 금지 — **본 설계가 개정 요구**),
  ADR-0109(kis_api 분봉 복구본), ADR-0118(키움 WS 전담), ADR-0121(캔들 차원 소스 사다리),
  ADR-0124(완결성 우선 소스 정책), ADR-0038(hot-path polars 금지)

## 1. 목표

키움 WS 체결(0B) 틱을 **장중 실시간으로 1분봉 OHLCV**로 집계해
`kiwoom_live/candles.parquet`에 영구 저장한다. 이로써:

- 캔들 차원에 **실시간 자체 수집 소스**가 생긴다(지금은 hogaplay 사후 캡처·kis_api
  사후 복구뿐 — 둘 다 실시간 아님).
- hogaplay가 오전을 영구 소실(업스트림 ~18h)한 날의 공백을 **1년 만료 없이 영구히**
  메운다(kis_api 복구본은 KIS 1년 보존·저장뷰 저장 시에만 생성이라는 한계가 있음).
- 캔들에도 "실시간 WS 우선"·"완결성 우선"(ADR-0124)이 **실제로 성립**한다.

**비목표**: 전 종목 커버(키움 구독 종목만), KIS 실시간 캔들 대체(당분간 병존), NXT 캔들
(저장 경로는 KRX 전용 — ADR-0118 성역 격리 유지).

## 2. 왜 방식 (a') 인가

두 방식을 검토했다.

- **(b) 사후 집계** — 저장된 `trades.parquet`(10초 (가격,방향) 집계본)을 분봉으로 묶음.
  **기각**: (1) 다운샘플러가 `side==0`(동시호가·장전 단일가) 물량을 버려
  (`downsampler.py:44-49`) 시가/종가 봉 **거래량이 체계적으로 언더카운트**된다.
  (2) `trades.parquet` ts_ms가 10초 윈도 시작 라벨이라 분 내 **시가/종가 순서가 ±10초
  소실**된다. 복기 분석에 틀린 거래량/시종가를 주는 건 "정직한 공백"보다 나쁘다.

- **(a') 실시간 집계** ← 채택. `on_tick`의 **raw 틱**은 다운샘플 이전이라
  per-tick `price`·`qty`(동시호가 포함)·`cum_volume`(FID 13)을 전부 본다
  (`kiwoom_frames.py:217-250`). 여기서 분봉을 만들면 거래량·시종가가 **정확**하다.

## 3. 핵심 사실 (실측)

수신 흐름(0B 체결):

```
kiwoom_ws_client → kiwoom_frames.parse_real_message
  → WsTick(kind=TRADE, payload={trades:[{t_ms,price,qty,side}], cum_volume, day_open/high/low, ...})
  → LiveStream.on_tick (stream.py:340)
      ├─ 표시: buffer.publish (즉시·무게이트)
      └─ 저장: if venue==KRX and gate_open: self._ds.ingest(tick)   ← (stream.py:410-411)
  → run_flush_loop 10초 (stream.py:457) → TickDownsampler.flush → writer.append → live_kiwoom/{date}/{code}.jsonl
  → promote_kiwoom_today 5분 (promote.py:415) → parquet/{date}/{code}/kiwoom_live/{snapshots,trades,brokers,fills}.parquet
```

- **raw 틱 payload(다운샘플 이전) 보유 필드**: `trades[].t_ms`(Unix ms)·`price`·`qty`(abs,
  동시호가 포함)·`side`, 최상위 `cum_volume`(FID 13, 있을 때만)·`day_open/high/low`.
- **저장 경로 trade는 이미 손실됨**: `_ds.ingest`가 `trades[]`의 `price/qty/side`만 읽고
  10초 (가격,방향) 합산으로 뭉갠다. `cum_volume`은 저장 경로에 **도달하지 않는다**.
- **candles.parquet 스키마**(`hoga/tables/candles.py`): `ts_ms(자정기준 ms), open, close,
  high, low, vol_a, vol_b`(int32). 빌더 템플릿 = `candle_repair.py:141-154`
  (`vol_a=거래량, vol_b=0` 관례).
- **리더는 이미 source-agnostic**: `bundle.build_candles_slice(source=...)`가 임의 소스의
  `candles.parquet`을 읽는다 — kiwoom_live를 캔들 소스로 올리면 **리더 변경 0**.

## 4. 설계 (a')

### 4.1 신규 모듈 `hoga/live/minute_candle_agg.py`

`TickDownsampler`와 **대칭**인 sync 상태형 애그리게이터. `on_tick`에서 raw 틱을 받아
per-code·per-minute 버킷을 갱신하고, **분 경계**에 완성된 봉을 flush한다.

```
@dataclass
class _BarState:
    minute_ms: int           # 이 봉의 분 시작(자정기준 ms, KST) — 버킷 키
    open: int; high: int; low: int; close: int
    first_cum_vol: int | None   # 분 진입 시점 cum_volume (delta 기준점)
    last_cum_vol: int | None
    qty_sum: int             # cum_volume 미수신 폴백용 per-tick qty 합

class MinuteCandleAggregator:  # 모든 메서드 sync (다운샘플러와 동일 계약)
    def ingest(self, tick) -> None: ...       # trades[]·cum_volume 반영, 분 바뀌면 직전 봉 봉인
    def flush(self, *, now_ms) -> dict[str, list[Candle]]: ...  # 봉인된(완성) 봉만 반환
    def set_active_codes(self, codes) -> None: ...   # 퇴출 코드 상태 제거(다운샘플러와 동일)
    def reset(self) -> None: ...              # 일경계 초기화
```

**봉 구성 규칙(per-tick, 정확)**:
- `open` = 그 분 첫 틱 price, `close` = 마지막 틱 price
- `high/low` = 그 분 틱 price의 max/min
- **volume = 분 경계 간 `cum_volume` delta** (`last_cum_vol − 직전 봉 last_cum_vol`).
  cum_volume 미수신 프레임이면 `qty_sum`(per-tick qty 합, 동시호가 포함) 폴백.
  → 두 경로 모두 다운샘플의 side==0 누락을 겪지 않는다.

### 4.2 배선 지점 (기존 코드 최소 변경)

- `stream.on_tick` 저장 게이트 옆(`stream.py:410-411`)에 한 줄:
  `if self._gate_open: self._candle_agg.ingest(tick)` — **다운샘플러와 나란히**, KRX·게이트
  가드를 그대로 상속(NXT·장외 자동 제외).
- `stream.flush_once`(`stream.py:413`)에서 `_ds.flush` 뒤에 `_candle_agg.flush(now_ms)`를
  호출해 완성 봉을 JSONL에 append. **flush-durability 계약 준수**: append 성공한 코드만
  commit(다운샘플러 `commit_code` 패턴과 동형 — 완성 봉은 재방출 안 되게 봉인 후 제거).
- `run_flush_loop` 게이트 닫힘 전환 drain·`reset`에 애그리게이터도 포함(밤 넘김 방지 —
  `downsampler.reset`과 동일 위치).

### 4.3 JSONL & promote

- `snapshot.py`에 `SnapshotKind.CANDLE` 추가. JSONL 라인은 기존 `{t_ms, kind, payload}`
  형식 재사용, payload = 완성 봉 1개(`{ts_ms, open, high, low, close, volume}`).
- `promote.py` 키움 경로(`_sync_parse_and_write`, `_apply_jsonl_line`)에 CANDLE kind 파싱
  추가 → `candles_tbl.write_parquet`로 `kiwoom_live/candles.parquet` 기록
  (`vol_a=volume, vol_b=0`). 나머지 4파일 경로 무변경.

### 4.4 인코딩 함정 (3종 혼재 — 빌더에서 정확 변환)

- raw 틱 `trades[].t_ms` = **Unix ms** → 봉 키(자정기준 ms)로 `unix_ms_to_ms_from_midnight`.
- `trades.parquet.ts_ms` = HHMMSSmmm 패킹(방식 b였다면 문제 — a'는 raw Unix ms를 쓰므로 무관).
- `candles.parquet.ts_ms` = 자정기준 ms → `build_candles_slice`가 Unix ms로 재베이스(기존).

## 5. 소스 배선 & ADR 결정 (가장 큰 사안)

`sources.py:56-67`이 **"실시간 WS 승격본은 candles.parquet을 절대 안 쓴다
(ADR-0040/0043)"**를 못박고 `CANDLE_BEARING_SOURCES={hogaplay, kis_api}`로 강제한다.
kiwoom_live를 캔들 소스로 만들려면 이 불변식을 건드려야 한다. 두 길:

- **(개정) ADR-0040/0121 개정 + `CANDLE_BEARING_SOURCES`에 kiwoom_live 추가** ← 권장.
  가장 정직한 모델(kiwoom_live가 실제로 캔들을 보유). 개정 ADR은 "실시간 승격본은 캔들을
  *합성하지 않는다*"가 아니라 "*틱에서 합성한 캔들은 예외적으로 허용*"으로 경계를 다시 긋는다.
- **(우회) 별도 네임스페이스**(예: `kiwoom_candles/`)에 써서 불변식 무손상. 리더·사다리에
  새 소스 추가는 마찬가지라 이득이 적고, "왜 호가는 kiwoom_live인데 캔들은 다른 폴더냐"는
  질문을 낳는다. 비권장.

### 5.1 캔들 사다리 재설계 (ADR-0121 확장)

캔들 후보가 hogaplay·kis_api·**kiwoom_live** 셋이 된다. `resolve_candle_source`의 정책별
우선순위(ADR-0124 완결성 우선 포함) 재정의 필요:

| 정책 | 캔들 사다리(안) |
|---|---|
| hogaplay 우선 | hogaplay → kiwoom_live → kis_api 복구본 |
| 실시간 WS 우선 | kiwoom_live → hogaplay → kis_api |
| 완결성 우선 | 완결성 등급 → 동급이면 kiwoom_live(WS) |

- 화질 서열(tick hogaplay > 실시간 1m 합성 > kis_api 복구)과 정책이 충돌할 수 있음 —
  **결정 필요**: hogaplay 우선에서 kiwoom_live를 kis_api보다 앞에 둘지(실시간 자체수집이
  사후복구보다 최신·영구라 앞이 타당). `_CANDLE_POLICY_ALIAS`(ADR-0124)도 재검토.

## 6. 크래시/재시작·부분봉

- **완성 봉만 저장**: 진행 중(현재 분) 봉은 flush하지 않는다 → 재시작 시 유실되는 건
  최대 현재 1분. 표시(/live)는 KIS REST 분봉 + WS 오버레이가 계속 담당하므로 실시간 화면엔
  영향 없다(저장 캔들은 사후 조회·study용).
- **멱등**: promote가 같은 (date,code) 재적재 시 candles.parquet 덮어쓰기(기존 관례).
  hogaplay 재캡처가 나중에 이기면 정본 복원(ADR-0121 사다리).

## 7. 커버리지 한계 (명시)

- 키움 WS 구독 종목만: 히트맵 800(200×4앱키) + 관심종목. 그 밖은 캔들 없음(hogaplay/kis_api
  폴백 유지).
- 정규장 KRX만(성역 격리). 장전/장후·NXT 캔들 없음.
- 화질: 1분 합성이라 hogaplay tick 캔들보다 미세도가 낮음(단 OHLCV 자체는 정확).

## 8. 테스트 계획

- `minute_candle_agg` 단위: 골든 틱 시퀀스 → 분 경계 봉인, cum_volume delta 거래량,
  동시호가 volume 포함, 분 걸침 틱 귀속, 재시작 부분봉 미방출.
- `stream` 통합: on_tick→flush→JSONL, KRX 격리(NXT 미저장), 게이트 drain·reset.
- `promote` 통합: CANDLE JSONL → kiwoom_live/candles.parquet 스키마·인코딩.
- `sources`/`bundle`: 새 사다리(정책별 캔들 승자), build_candles_slice 서빙.
- 정규장 스모크: 실 키움 틱으로 합성 봉 vs KIS 분봉 OHLCV 대조(거래량 정합 실증).

## 9. PR 분할(안)

1. **PR-1** `minute_candle_agg` 모듈 + 단위테스트 (배선 없음, 순수 추가).
2. **PR-2** stream 배선(ingest/flush/reset) + snapshot CANDLE kind + 통합테스트.
3. **PR-3** promote 캔들 write + parquet 통합테스트.
4. **PR-4** ADR-0040/0121/0124 개정 + sources 사다리 + bundle 서빙 + 계약테스트.
5. **PR-5** 정규장 스모크·거래량 정합 실증 후 기본 사다리 확정.

## 10. 미결정 (승인 필요)

1. **불변식 개정 vs 별도 네임스페이스** (§5) — 권장: 개정.
2. **hogaplay 우선에서 kiwoom_live vs kis_api 순서** (§5.1) — 권장: kiwoom_live 먼저.
3. **거래량 기준** — cum_volume delta 우선 + qty_sum 폴백(권장) vs qty_sum 단독.
4. 규모: 총 2~3일(스모크 제외). 정규장 스모크는 장중 1회 필요.
