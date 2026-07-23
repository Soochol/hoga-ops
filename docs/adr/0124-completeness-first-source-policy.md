# ADR-0124 — 완결성 우선 소스 정책 (completeness_first)

- 상태: Accepted (2026-07-23)
- 관련: ADR-0039(Source Preference = 선호+폴백, 사다리 첫 non-INVALID),
  ADR-0007(disk_state = 완결성 판정 SSOT), ADR-0115(kis_live 완결성 판정+캡처
  게이트), ADR-0121(캔들 차원 소스 사다리 분리), ADR-0116/0118(kiwoom_live 승격본)

## 맥락

호가·체결 데이터 소스 선호에는 두 옵션만 있었다 — `hogaplay_first`,
`kis_ws_first`. 두 옵션의 차이는 **사다리 순서**뿐이고, 선택 로직
(`resolve_source_result`)은 사다리에서 **첫 non-INVALID Source**를 고른다(ADR-0039).

`healthy` 집합은 `DiskState.INVALID`만 배제하므로, `SOURCE_PARTIAL`(갭 존재)이나
`CLIENT_INCOMPLETE`(중도 중단)도 healthy로 취급돼 사다리 앞 Source가 그대로 이긴다.
즉 **완결성은 판정만 하고 선택에는 쓰지 않는다.**

실무에서 이게 함정이 되는 대표 사례: hogaplay가 업스트림 보유(~18h) 한계로 다음날
아침 수집 시 오전을 영구 소실(`SOURCE_PARTIAL`)한 날. `hogaplay_first`면 반쪽짜리
hogaplay가 이기고, 같은 날 완결(`COMPLETE`)한 실시간 WS 승격본이 있어도 폴백이
발동하지 않는다. 사용자는 "완결한 소스가 있는데 왜 반쪽을 보여주나"를 겪는다.

ADR-0039의 "Future signal to revisit"이 이미 예고한 지점이다 — "세 번째 source가
추가되면 두 값 enum이 부족, ordered list 의미론으로 진화 필요."

## 결정

호가·체결 차원에 **완결성 우선(`completeness_first`)** 옵션을 추가한다. 두 소스 중
**그날 데이터가 더 완결한 쪽**을 자동 선택하고, **완결도가 같으면 실시간 WS 우선**으로
타이브레이크한다.

**판정은 재구현하지 않는다.** `resolve_source_result`는 이미
`classify_stock_date`(→ `classify_from_meta`, 캡처 게이트·달력과 동일 SSOT,
ADR-0007/0115)로 소스별 `Classification.state`를 전부 계산해두고 **INVALID 한 비트만**
쓰고 나머지를 버린다. `completeness_first`는 그 상태를 더 소비할 뿐 — 새 I/O도,
새 판정 로직도 없다.

선택 규칙 = 후보를 `(완결성 등급, 사다리 위치)`로 정렬해 최상을 고른다.

- 1차 키: 완결성 등급. `disk_state.completeness_rank(state)`(lower=better)로
  뽑았고, 달력·캡처가 쓰는 `_AGGREGATE_PRIORITY`(COMPLETE > SOURCE_PARTIAL >
  CLIENT_INCOMPLETE > …)와 **공유**한다 — "어느 상태가 더 완결한가" 순서가 두
  소비자 사이에서 드리프트하지 않게 한다.
- 2차 키(동급 타이브레이크): WS-first 사다리
  `(kis_live, kiwoom_live, kis_api, hogaplay)`.
- `INVALID`는 `healthy`에서 이미 배제 — "부패 데이터는 서빙 안 함" 계약 유지.

이 한 규칙이 요구를 모두 만족한다:

| 상황 | 승자 | 근거 |
|---|---|---|
| 둘 다 `COMPLETE` | WS | 동급 → WS-first 타이브레이크 |
| hogaplay만 `COMPLETE` | hogaplay | 등급 우선 |
| WS만 `COMPLETE` | WS | 등급 우선 |
| 둘 다 `SOURCE_PARTIAL`(예: 오전 소실) | WS | 동급 → WS-first |
| hogaplay `COMPLETE`, WS `PARTIAL` | hogaplay | 등급 우선 |

**캔들 차원은 완결성 타이브레이크 대상이 아니다.** 이 설정은 호가·체결 전용이고
캔들은 'KIS API 우회' 토글이 단독 결정한다. `resolve_candle_source`가 같은 pref
사다리를 쓰는데(ADR-0121), `completeness_first`의 WS-first 사다리를 그대로 캔들에
쓰면 후보가 `(kis_api, hogaplay)` 순이 되어 ADR-0109 복구본이 hogaplay를 앞서는
미묘한 변화가 생긴다. `_CANDLE_POLICY_ALIAS = {completeness_first: hogaplay_first}`로
캔들 차원만 오늘 기본(hogaplay 우선)으로 되돌린다.

## 결과

- 새 옵션은 실질적으로 **과거일**(한쪽만 COMPLETE)에서 힘을 발휘한다.
- **장중 당일은 자연히 WS로 수렴한다.** promote `_collection_finished`가 오늘·장중
  실시간을 15:35 KST 전까지 `CLIENT_INCOMPLETE`로 묶어 조기 COMPLETE flip을 막으므로
  (ADR-0115), hogaplay도 WS도 아직 미완결 → 동급 → WS 채택. 버그가 아니라 원하는
  동작이며 설정 설명 문구에 반영했다.
- 기본값은 여전히 `hogaplay_first`(ADR-0039 — 더 fine-grained 데이터를 default 노출).
- 검증: 백엔드 314 tests green, 프론트 12 tests green, `tsc --noEmit` 0. 라우트
  검증(`_validate_source_policy`)·라디오 UI·스토어는 각각 `ordered_sources`·옵션
  배열 기반이라 무변경으로 자동 반영.

## 기각한 대안

- **`hogaplay_first` 폴백을 완결성 조건부로 바꿔 기존 옵션에 흡수.** 기존 두 옵션의
  "선호+폴백" 의미(ADR-0039)를 조용히 바꿔 사용자 mental model을 깬다. 완결성 우선은
  성격이 다른 정책이므로 별도 옵션이 맞다.
- **자동(auto) 단일화 — 항상 완결성으로 결정.** hogaplay는 tick, kis_live는 10s로
  해상도가 달라 "어떤 source를 봤는지"가 분석에 영향을 준다(ADR-0039 "Why expose").
  자동화하면 사용자가 한 종목의 두 측정을 비교할 수 없다. 명시적 선택으로 남긴다.
- **완결성 순서를 sources.py에 따로 정의.** 달력·캡처의 `_AGGREGATE_PRIORITY`와
  갈라져 판정이 두 벌이 된다. `completeness_rank` 공유 헬퍼로 SSOT를 지킨다.
- **캔들에도 완결성 타이브레이크 적용.** 이 설정은 호가·체결 전용이고 캔들은 별도
  토글 소관이라 범위를 넘는다. `_CANDLE_POLICY_ALIAS`로 캔들은 오늘 기본을 유지.
