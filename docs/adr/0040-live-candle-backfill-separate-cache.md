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

## 2026-07-04 Amendment: cache is memory-only

The separate KIS candle endpoint remains, but its cache is no longer disk
durable. Minute candles now match daily candles as process-memory-only
temporary results. `kis-past-candles` JSON files are legacy artifacts and are
not part of runtime cache behavior.

## 개정: 초 단위 관측 체결 (2026-09-30)

초봉은 분봉 벤더 캐시를 축소하지 않는다. 원본 `Live Tick`에서 1초 OHLCV와
가격·방향별 수량을 함께 생성하고 `second_trades`에 격리한다. UI는 주식 1·5·10·30초봉,
관측 거래량, 20봉 MA이다. 대표 지수는 지원하지 않는다. 비관측 초를 가격 carry로
채우지 않으며, 기존 분봉 파이프라인·분봉 점프·저장 캐시는 계속 별도로 사용한다.
시간축은 KST 실시각이며 초를 표시한다. 날짜 선택·이전/다음 날짜·오늘 복귀로
저장된 과거 일자를 조회하며, 연결 매물대도 같은 날짜를 사용한다. 과거 일자는
실시간 폴링하지 않는다. 날짜 선택은 창 세션 한정이며 새로고침하면 오늘로 복귀한다.
다일 탐색과 기본 봉 개수는 아래 후속 개정을 따른다.


### 과거 체결 원본 조회 보완 (2026-09-30)

초봉 날짜 선택 방식은 유지한다. `second_trades`에 해당 일자의 관측 데이터가
없으면 KRX의 `hogaplay/trades.parquet` 원본 체결을 읽어 1초 OHLCV·가격 셀을
생성하고 1·5·10·30초로 집계한다. 원본 HHMMSSmmm는 KST Unix ms로 변환하며
동일 시각의 시가·종가는 `seq`로 결정한다. 가격 0인 요약행은 제외한다.
두 출처를 더하지 않고 하루 전체에 하나를 선택한다. 새 저장소가 있으면 우선한다.
키움의 기존 10초 집계 및 KRX 원본을 NXT/UN으로 대체하는 폴백은 금지한다.
응답 `source`는 `second_trades`/`hogaplay`/null이며 과거 원본임을 UI에 표시한다.
원본 읽기는 워커 스레드에서 수행하고 파일 변경 시 갱신되는 4항목 캐시를 사용한다.


### 초봉 다일 탐색과 기본 봉 개수 (2026-09-30)

사용자 요청에 따라 초봉도 Virtual Axis로 거래일을 연결한다. 날짜 선택 UI는 후속 사용자 요청으로 제거하고
오늘을 조회의 오른쪽 끝으로 삼는다. 과거 날짜는 왼쪽 팬으로 탐색한다. 최초 화면은 주기와 무관하게 최근 관측
240개 봉이다. 거래가 드물면 이전 구간·거래일을 추가 조회해 확보하고, 저장된 데이터가
240개 미만이면 있는 봉만 표시한다. 밤·휴일은 압축하고 일중 미관측 구간은 유지한다.
시각 라벨·커서·호가·매물대 조회는 축의 원래 KST 날짜/시각으로 역변환한다.

한 페이지는 최대 240개 주기만큼의 시간 범위를 요청하며, 왼쪽 팬/이전 구간 버튼으로
계속 확장한다. 초기 자동 확보 및 한 뷰의 로드는 최대 64페이지로 제한한다.
현재 한 뷰에서 최대 64페이지까지 과거를 탐색할 수 있다.
당일 최신 구간만 별도 폴링해 과거 전체를 매초 재조회하지 않는다.
저장 날짜 목록은 새 초봉 저장소와 KRX hogaplay 원본만 포함하며 기존 10초 집계는 제외한다.


### 창별 정규장 표시 필터 (2026-10-01)

분봉·초봉의 더보기 메뉴에 `정규장만 보기`를 제공한다. 기본 OFF이고 창의
`chart.regularSessionOnly`로 영속화하여 봉 전환·새로고침·레이아웃 복원에 유지한다.
일·주·월에서는 비활성화하며 기존 일봉 종가 정책을 바꾸지 않는다.

ON이면 venue와 무관하게 각 날짜의 KST 09:00–15:30을 표시한다. 분봉은 벤더 및
디스크의 1분 원천을 먼저 필터링한 뒤 표시 주기로 재집계하고, 실시간 체결도
같은 시간 범위로 제한한다. 시간별 보조지표도 1분 원천으로 조회한 뒤 필터링하여
큰 버킷의 마감 이후 값이 남지 않게 하며, 축도 같은 범위를 사용한다.
연결된 분봉 매물대는 기존 단일 일자 cutoff 조회를 15:30 이하로 제한하며
그 경계를 큰 분봉 시작 시각으로 내림하지 않는다.

초봉은 서버에서 1초 원천을 필터링한 뒤 집계한다. 관측 메타데이터 역시 필터링된
원천에서 계산하여 시간외 마지막 체결 때문에 초기 240개 확보가 빈 구간을
걷지 않게 한다. 15:30:00 마감 체결의 1초 저장 버킷은 포함한다. 버킷보다 세밀한
밀리초 단위 경계로 재분리하지 않는다. 매물대 가격 셀도 같은 조회 조건을 사용한다.
수집·원본 저장·venue 선택은 표시 필터로 변경하지 않는다.

### 초봉 공통 분석 도구와 가격 지표 (2026-10-25)

사용자 승인으로 최초 초봉의 고정 MA 20·거래량 전용 화면을 확장한다. 초봉 원천과
`second_trades`/hogaplay 조회·64페이지 예산은 유지하고, 표시 어댑터를 통해 분봉과
같은 `LiveChartRoot`·도구 모음·드로잉·이미지 캡처·복기 노트 추가·레전드·패널 조절을
사용한다. 최초 최근 관측 240봉과 거래일 압축, 실제 KST 초 표시는 유지한다.

지원 지표는 관측 OHLCV로 계산하는 이동평균선·볼린저 밴드·엔벨로프·슈퍼트렌드·
거래량이다. 기존의 여러 지표 항목·선 스타일·숨김·삭제·초기화를 공유한다. 기간은
관측 봉 수이며 미관측 초를 가격으로 채우지 않는다. 호가·체결강도·프로그램·일별 수급·
일봉 이동평균 등 별도 원천은 초봉 지표 목록과 추가 항목 렌더링에서 제외한다.
기존 호가·매물대 데이터 창의 커서 연결은 유지한다.

지표 설정과 indicator-modal chartPrefs는 기존 창 스코프 안의 `seconds` 버킷에
영속화한다(ADR-0152 개정). 1·5·10·30초는 이 버킷을 공유하고 `minute` 버킷은
상속하거나 덮어쓰지 않는다. 기존 분봉 저장값을 그대로 보존하며 최초 초봉 지표는
공장 기본 구성을 사용한다. 패널 높이도 독립 `seconds` 프로필을 쓴다(ADR-0172 개정).
분봉→초봉 기간 점프·저장 학습뷰의 초봉 지원은 이번 확장에 포함하지 않는다.

### 초봉 구간 이동·저장과 관측 체결량 (2026-10-25 후속)

사용자의 다음 단계 요청으로 위 절의 후속 범위를 구현한다. 분봉의 화면 오른쪽
봉 또는 측정 도구의 두 시각을 같은 그룹·Code의 초봉 창으로 연다. 기존 일치 창을
재사용하고, 없으면 5초봉 창을 만든다. 고정 종목이 그룹과 다르면 새 창만 같은
종목으로 고정한다. 구간은 창 런타임이며 종목 교체·분봉 복귀에 제거한다.

선택 시각은 표시 주기 경계에 정렬해 API의 배타적 상한으로 요청한다. 오늘부터
역으로 걷지 않고 해당 날짜·시각부터 읽으며, 선택 시작까지 같은 64페이지 예산으로
확보한다. 과거 구간은 최신 폴링을 하지 않는다. 정규장 필터로 범위 전체가 제외되면
빈 결과로 표시하며 선택 이전의 마지막 체결로 이동하지 않는다.

초봉 체결강도만 위 절의 제외 항목에서 해제한다. `include_prices`의 방향별 1초
가격 셀을 표시 주기로 합산하며 미확인 방향 0은 세지 않는다. 실제 관측이 없는 봉을
추가하지 않으며 분봉 호가·프로그램을 보간하지 않는다. 조회 창에 장 시작부터의
완전한 관측이 보장되지 않으므로 체결강도·거래량의 당일 누적선은 초봉에서 끈다.
초봉 저장 학습뷰 복원·KRX 정책은 ADR-0157의 같은 날짜 후속 절을 따른다.

### 초봉 주기 전환의 시간 구간 보존 (2026-10-25 후속)

원래 제안의 「같은 시점을 유지하며 주기 전환」을 보완한다. `setChartTimeframe`은
초봉 사이의 전환 전에 해당 창의 뷰포트를 동기적으로 읽는다. 초봉 화면은 등록된
캡처 함수만 제공하고, 창 런타임에 저장된 일회성 전달값은 새 화면이 받아 즉시 제거한다.
종목·시장과 목적 주기를 검증하며 localStorage·레이아웃 프리셋에는 저장하지 않는다.
툴바 외 키보드·메뉴도 같은 store action을 거친다.

과거 화면은 우측 시각부터 직접 읽고 좌측 시각에 닿을 때까지 기존 64페이지 예산으로
확보한다. 명시적 저장/이동 구간의 조회 범위는 유지하면서 그 안의 팬·줌을 전달한다.
연속 관측 구간은 이전 논리 폭을 주기 비율로 환산해 가장자리의 부분 봉 때문에 반복
전환 때마다 줌이 늘지 않게 한다. 밤·휴일·드문 체결 구간은 새 관측 인덱스의 두 시각을
사용한다. 새 주기의 해상도보다 작은 경계 차이는 봉 경계로 조정한다.

범위를 제한한 과거 조회의 마지막 봉은 최신 추종 상태가 아니다. 연속 주기 전환에도
이를 유지하며, 날짜 칩의 최근 복귀는 제한 조회를 해제하고 평소 최신 조회로 돌아간다.
빠른 연속 전환 중에는 아직 도착하지 않은 새 데이터 대신 직전 유효 전달값을 유지한다.
새 분봉→초봉 구간 명령·종목 변경·venue 변경은 이전 전환 위치를 재사용하지 않는다.

### 초봉의 거래일 날짜 구분선 (2026-10-25 후속)

사용자 요청으로 공통 렌더러의 분봉 전용 구분선 게이트를 분봉·초봉에 적용한다.
새 거래일의 첫 실제 렌더 봉을 경계로 하며 공통 `DayBoundaryPrimitive`가 모든 pane에
같은 프레임으로 그린다. 기존 테마 토큰·1px 점선·날짜 라벨의 시간축 소유를 유지하고
D/W/M에는 세우지 않는다.

### 초봉 팬·축소의 연속 자동 채움 (2026-10-25 후속)

사용자 승인으로 초봉의 제스처당 1페이지 제한을 고정된 화면 부족분 채움으로 바꾼다.
입력 후 안정된 논리 범위의 왼쪽 부족분과 기존 50봉 prefetch 여유를 목표로 잡고,
페이지 설치 때 실제 prepend한 축 슬롯만 차감한다. 빈 페이지도 커서는 전진하지만
목표를 줄이지 않으며, 폴링·복원 이벤트는 새 목표를 만들지 않는다. 한 요청의 완료를
기다려 다음 페이지를 읽고 `cancelRefetch: false`로 진행 중인 조회를 중복 시작하지 않는다.

이전 관측 날짜로 이어가되 기존 64페이지·저장 데이터 끝·선택/저장 구간 하한·조회
오류에서 멈춘다. 끝·한도·실패 안내와 수동 추가 조회를 유지하며 추가 페이지 실패의
재시도는 실패한 페이지를 다시 읽는다. 날짜 목록 실패도 데이터 끝과 구분해 재시도한다.
최초 관측 240봉·페이지의 최대 시간 폭·원천·미관측 구간 정책은 유지한다.

목표만 고정한다. 뷰포트는 요청 시작이 아니라 응답 설치 직전의 실제 시각 앵커와
논리 범위를 캡처해 prepend 차이만큼 옮기고 봉 간격을 유지한다. 로딩 중 사용자의
팬·줌을 덮어쓰거나 fitContent로 확대하지 않는다. 미국 차트의 3페이지 예산은 유지한다.
