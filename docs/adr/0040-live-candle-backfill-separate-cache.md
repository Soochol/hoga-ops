# 0040 — Live Candle Backfill은 별도 cache namespace + 별도 wire

**Status:** accepted (2026-05-28)

**Related:**
- ADR-0013 — RangeBundle is the single read-path Wire Model
- ADR-0020 — Data integrity invariant catalog
- ADR-0036 — 로컬 전용 배포: retry/enqueue 상한 미설정
- ADR-0037 — Source별 서브폴더 layout
- ADR-0038 — Live Capture는 JSONL append + 17:00 Promotion
- ADR-0039 — Source Preference + fallback
- `docs/superpowers/specs/2026-05-28-live-kis-past-candles-design.md`

## Decision

`/live` 페이지의 분봉 candle 데이터는 새 endpoint `GET /api/live/past-candles`가 서비스한다. 이 path는:

1. **별도 wire**. RangeBundle을 거치지 않고 자체 `LivePastCandlesResponse` 모델을 반환한다.
2. **별도 cache namespace**. 결과를 `~/.local/share/hoga-ops/kis-past-candles/<code>/<YYYYMMDD>.json`에
   영구 cache한다. `<data_dir>/parquet/{date}/{code}/kis_live/` (ADR-0037)의 promoted Parquet 디렉토리에는 쓰지 않는다.
3. **/api/range 비-영향**. /replay 페이지가 사용하는 read path는 변경하지 않는다.

ADR-0013 ("RangeBundle은 read-path 단일 wire")의 *spirit*과 정합하지 않는다는 사실은 인정한다 — 본 ADR은 그 정신과의
*의도된 균열*을 명문화한다.

## Why

대안 A (promoted Parquet 통합)를 검토했고 거부했다. KIS dailychartprice (FHKST03010230)의 결과를 직접
`parquet/{date}/{code}/kis_live/candles.parquet`로 작성하면 기존 `/api/range`가 `source_pref=kis_live` fallback
(ADR-0039)으로 자연 처리하고 ADR-0013의 single read-path 정신과 완전 정합한다.

거부 사유:

1. **/replay 영향 차단이 spec brief의 명시 제약.** Alt A 채택은 `source_pref=kis_live` 사용자에게 *자동 파급*. 현재
   kis_live source는 promoted Parquet에 candles.parquet 자체가 없어서 /replay의 candle 차원이 비어 있고, Alt A는
   그것을 풍부한 KIS dailychartprice candle로 채운다. UX 변경은 별도 검토를 받아야 한다.
2. **Promotion 패턴과의 충돌.** ADR-0038은 Promotion을 "17:00 batched + idempotent + cold path"로 정의. Alt A의
   on-demand mid-day write는 그 정의에 어긋난다. 한 디렉토리에 두 writer (cold path Promotion + hot path on-demand)가
   공존하려면 idempotency 정책 + concurrent write 보호가 추가 필요.
3. **메타-시스템 적용 부담.** Alt A는 `DiskState.classify_from_meta` (ADR-0007)의 새 부분-promotion 상태 인지,
   ADR-0020 invariant 카탈로그에 KIS candle 무결성 invariants (예: `close > 0`, `t_ms` 단조성) 추가, `hoga validate
   --fix` CLI sweep 확장 등을 동반한다. 본 spec의 즉시 unblock 목표 (hogaplay invariant fire 일자의 candle 표시 +
   today 30-bar micro-scale 해소)를 그 부담 안에서 진행하는 비용이 크다.
4. **인크리멘털 도달 경로 존재.** Alt A로 출발한 후 별도 spec ("KIS Past Candles → Promoted Parquet Migration")로
   자연스럽게 본 ADR과 다른 미래 상태에 도달 가능. 반대 방향은 의미 없으므로 *큰 결정을 미루는* 옵션이 안전.

## Trade-offs and what we considered

- **(채택) 별도 cache namespace + 별도 wire (Alt A).** RangeBundle 외 second wire를 도입. ADR-0013 single
  read-path 정신과 표면적 균열. 그러나 본 ADR의 명문화로 균열의 *지역성* (scope: /live 페이지 한정)을 보존.
- **(거부) Promoted Parquet 통합 (Alt B).** 위 1-4 사유.
- **(거부) /api/range 자체에 KIS dailychartprice fallback 분기 추가.** /api/range의 read path가 cold-path Parquet
  read + hot-path KIS REST fanout 두 모드를 갖게 됨. 단일 endpoint의 응답 시간 분포가 cache hit/miss에 따라 한
  자릿수 ms ~ 수 분으로 폭발. ADR-0013의 wire 단일성보다 더 무거운 read-path 단일성을 무너뜨림.

## Consequences

- `/live`만 새 wire (`LivePastCandlesResponse`) + 새 cache namespace를 사용한다. /replay는 변화 없음.
- KIS dailychartprice 데이터가 *두 곳* 존재할 가능성을 future-spec까지 허용: (a) kis-past-candles cache (현재),
  (b) 만약 Alt B로 migrate하면 kis_live/candles.parquet. 두 곳이 동시에 같은 데이터를 담는 일은 *없도록* migrate spec이
  본 ADR을 supersede 시 cache namespace를 삭제하는 것을 명문화해야 한다.
- ADR-0013의 "single read-path Wire Model" 정책은 *RangeBundle 도메인 한정* 의미로 재독해된다 — /live 페이지의
  분봉 데이터는 RangeBundle 도메인의 일부가 아니라 별도 도메인 ("Live Candle Backfill", CONTEXT.md 등록)이다.
  ADR-0013은 본 균열에 의해 약화되지 않는다.
- ADR-0020 invariant 카탈로그는 변경 없음. KIS dailychartprice 응답에 대한 series-level invariants (close > 0,
  t_ms 단조 증가, OHLC 일관성)는 본 spec의 cache write 시점에 *defensive parse*로 처리하고 위반 시 그 일자를 cache에
  쓰지 않고 `data_warnings`로 surface. 미래에 Live Candle Backfill 데이터를 promoted Parquet로 합치는 spec이 나오면
  그때 카탈로그 확장.

## Trigger Conditions

다음 중 하나라도 만족 시 본 ADR을 supersede하고 Alt B로 migrate해야 한다:

- **/replay 페이지가 KIS candle을 필요로 함**: `source_pref=kis_live` 사용자에게 KIS candle을 노출하는 UX 결정이
  /replay에서 채택되면, 두 cache (kis-past-candles + kis_live/candles.parquet)가 중복 운영되는 비용이 unified path
  비용을 초과한다.
- **Cache namespace의 데이터 양이 promoted Parquet 비용을 압도**: 사용자당 ~1MB/code/year로 추정하지만, 실제 사용
  패턴에서 50+ 종목 × 1년 = ~50MB를 초과하면 운영적으로 Parquet (compression) 우위가 명확해진다.
- **두 path 간 데이터 불일치 사고**: same (code, date)에 대해 cache와 promoted Parquet이 다른 값을 가진 incident가
  발생하면 unification이 강제된다.
