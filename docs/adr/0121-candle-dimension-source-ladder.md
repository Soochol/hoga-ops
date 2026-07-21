# ADR-0121 — 캔들 차원 소스 사다리를 호가 사다리에서 분리

- 상태: Accepted (2026-07-21)
- 관련: ADR-0039(소스 우선순위 사다리), ADR-0040/0043(실시간 승격본은
  `candles.parquet`을 쓰지 않는다), ADR-0109(저장뷰 캡처 공백 KIS 분봉 복구),
  ADR-0116/0118(kiwoom_live 승격본 도입 — 본 ADR이 그 부작용을 해소)

## 맥락

`/study` 저장뷰를 열면 **마지막 날(최근 날짜) 분봉이 보이지 않는다**는 신고.
실측 재현(042660, 20260602~20260720, 저장 구간은 7/20 15:30까지 온전히 포함):

```
세그먼트: [..., ('20260720', 'kiwoom_live')]   ← 마지막 날 세그먼트는 정상 생성
캔들:     마지막이 07-16 15:30                 ← 20260720 캔들 0개
```

디스크에는 데이터가 **멀쩡히 있었다**:

| Source | 분류 | `candles.parquet` |
|---|---|---|
| `hogaplay` | INVALID (`meta.close_after_open`: close_ms=0) | 9행 (09:06 캡처 중단) |
| `kiwoom_live` | SOURCE_PARTIAL (healthy) | **없음** ← 사다리 승자 |
| `kis_api` | SOURCE_PARTIAL (healthy) | **381행 (ADR-0109 복구본)** |

## 문제 — 사다리의 차원 비대칭

`resolve_source_result`는 Stock-Date 하나당 **단일 승자**를 고르는데, Source마다
보유 차원이 다르다. `kis_live`/`kiwoom_live`는 호가·체결만 쓰고 캔들을 아예 쓰지
않는다(ADR-0040/0043). 그래서 **"건강한 승자가 이겼는데 그 승자에겐 캔들이 없다"**
가 성립하고, 같은 Stock-Date의 실제 캔들이 통째로 가려진다.

`sources.py`의 기존 주석은 이 비대칭의 **한쪽 방향만** 인식하고 있었다 — "kis_api는
캔들 전용이니 호가 차원에서 억제한다(`orderflow_ok`)". 대칭인 반대 방향, 즉
"kis_live/kiwoom_live는 호가 전용이니 캔들 차원에서 억제한다"가 빠져 있었고, 그
구멍으로 hogaplay 캔들과 ADR-0109 복구본이 **동시에** 가려졌다.

ADR-0109의 "읽기 경로 변경 없이 복구본이 공백일에 이긴다"는 전제도 여기서 깨진다.
전제는 "hogaplay 없는 날 = 다른 Source도 없는 날"이었는데, 실제로는 "hogaplay가
**존재하지만 캔들을 서빙하지 못하는** 날"이 있고 그 날엔 승자가 캔들 없이 이긴다.

**왜 지금 터졌나.** `kis_live`가 이기던 케이스는 산발적이었으나, ADR-0118(키움
전담) 이후 **모든 거래일이 `kiwoom_live` 파티션을 갖는다**. `kiwoom_live`는 항상
healthy이므로, 이제 hogaplay가 조금이라도 INVALID면 **반드시** 캔들 미보유 Source가
이긴다. 산발적 결함이 구조적 결함으로 승격됐다. 전수 스캔 결과 13,614 Stock-Date 중
**253건**이 이 상태였다(대부분 정상 hogaplay 캔들이 가려진 것).

## 결정

**캔들 차원 후보를 사다리에서 분리한다.** 사다리 순서(우선순위 *정책*)와 "그 Source가
그 차원을 보유하는가"(*물리적 사실*)는 서로 다른 축이고, 후자를 전자에 섞으면
정책이 디스크 레이아웃에 오염된다.

- `sources.CANDLE_BEARING_SOURCES = {"hogaplay", "kis_api"}` — 캔들을 실제로 쓰는 Source.
- `sources.resolve_candle_source(engine, date, code, pref) -> SourceName | None` —
  정책 사다리 순서를 유지한 채 후보를 위 집합으로 좁히고, **INVALID가 아니면서
  `candles.parquet`이 실제로 있는** 첫 Source를 고른다. 없으면 `None`.
- `bundle.build_range_bundle`은 캔들만 이 승자에서 읽는다. 호가 승자·세그먼트
  `source`·`orderflow_ok`는 **무변경** — 한 Stock-Date의 호가 승자와 캔들 승자가
  갈릴 수 있다(예: 호가 `kiwoom_live`, 캔들 `kis_api`).
- `repaired_candle_dates`(프론트 "KIS 보충 캔들" 배지) 판정도 캔들 승자 기준으로
  옮긴다. 승자가 갈린 날은 `kis_api/meta.json`을 따로 읽어 `created_from` 마커를
  확인한다(레거시 rest30 kis_api 파티션과 복구본을 구분).
- `candle_repair._has_served_candles`(공백 판정 SSOT)도 같은 함수를 쓴다. 서빙과
  공백 판정이 다른 사다리를 쓰면 "복구했는데 여전히 공백"(재복구 반복)이나 "이미
  서빙되는데 또 복구"가 생긴다.

파일 존재까지 보는 이유: 캔들 없이 끝난 hogaplay 캡처가 healthy로 남아 복구본을
가리는 경우를 막는다.

## 결과

A/B 실측 (동일 요청, 수정 전 코드 vs 수정 후 코드):

```
수정 전: 캔들 1253개 | 마지막 날짜 20260716 | 20260720=0개  | 복구배지=[]
수정 후: 캔들 1292개 | 마지막 날짜 20260720 | 20260720=39개 | 복구배지=['20260720']
```

- 정상일은 무변경(호가·캔들 승자 모두 hogaplay). 백엔드 2569 tests green.
- hogaplay가 INVALID이고 복구본도 없는 날은 여전히 캔들 없음 — 이것은 **정직한
  상태**이며, `_has_served_candles`가 같은 함수를 쓰므로 그 날은 복구 대상으로
  정확히 잡혀 다음 저장 훅/CLI 스윕에서 채워진다.

## 기각한 대안

- **캔들 유무를 `healthy` 판정에 포함.** 호가 차원까지 같은 기준으로 흔들려
  캔들 없는 정상 실시간 승격본이 호가 서빙에서도 탈락한다. 차원 하나를 고치려고
  다른 차원을 깬다.
- **사다리에서 kis_live/kiwoom_live를 통째로 제거.** 이들은 호가 차원의 정당한
  승자다. 우선순위 정책 자체를 바꾸는 것은 과잉.
- **INVALID Source의 캔들도 폴백으로 서빙.** `bundle`의 excluded 정책(INVALID면
  그 날 제외)과 충돌한다. 정책 변경은 별도 판단 사안이며, 본 ADR은 "건강한
  데이터가 가려지는" 결함만 해소한다.
