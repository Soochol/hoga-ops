# 0161 — 단별 잔량 증감 지표를 제거한다

**Status:** accepted (2026-08-25) — 사용자 결정. `docs/plans/2026-07-20-depth-delta-indicator.md`
의 설계를 **폐기**하고, 그 지표가 차지하던 프론트·백엔드·캐시·계약 가드를 전부 걷어낸다.

**Related:**

- ADR-0004 — 프론트가 wire model 을 손으로 미러한다. 슬라이스가 사라질 때도 **양쪽을
  같은 PR 에서** 지운다는 규율은 추가할 때와 같다.
- ADR-0147 — RangeBundle 슬라이스 등록. `depth_delta` 항목이 레지스트리에서 빠졌다.
  그 ADR 의 결정(손 등록 + 양방향 가드)은 **그대로 유효**하다 — 오히려 이 제거가 그
  가드 덕분에 누락 없이 끝났다.
- ADR-0157 — `/study` 폐지. **기능 하나를 통째로 걷어내는 절차의 선례**다.
- ADR-0158 — 오늘분 지표 증분 커서(**이미 rejected**). 그 문서의 분류표와 §D3·§Q3 는
  `depth_delta` 를 "겹침이 필요한 유일한 슬라이스" 로 들고 있었다. 그 항목은 이제
  대상이 없다 — 표를 다시 볼 일이 생기면 그 줄은 **역사**로 읽을 것.

## 무엇이 사라지는가

**지표 표면 전체.** 차트 캔들 뒤에 유입/유출을 색으로 깔던 오버레이, 지표 패널의
「단별 잔량 증감」 카테고리와 그 설정(유입·유출 색, 최대 불투명도), 레전드 행, 그리고
그 값을 만들던 계산 경로 전부:

| 층 | 사라진 것 |
| --- | --- |
| 프론트 오버레이 | `DepthDeltaOverlay` · `depthDelta` · `depthDeltaAlpha` · `depthDeltaSession` · `indicators/DepthDeltaConfig` |
| 프론트 집계 | `buildLiveBundle` 의 오라클(`bucketDepthDelta`)과 증분 미러(`IncrementalHogaBucketer` 의 delta 상태·`foldDelta`) |
| 프론트 상태 | `depthDelta*` 설정 5필드 · flag 지표 id `depth-delta` · 프리셋 enable 키 |
| wire | `RangeBundle.depth_delta` · `DepthDeltaPoint` · `depth_delta_enabled` 쿼리 파라미터 |
| 백엔드 | `build_depth_delta_slice` · `query_bucketed_depth_delta` · `reaggregate_depth_delta` · `DepthDeltaBucket` · `tick_from_ladder_prices` |
| 캐시 | kind `depth_delta` · kind `depth_delta_prices`(굵은 봉 파생용 1분 사다리 원료) |

## 무엇이 남는가 — **표면이 둘이었다**

**10호가 카드의 증감 뱃지(`sidebar/orderbookDeltaBadges`)는 그대로다.** 이것은 같은
아이디어의 **다른 표면**이지 같은 기능이 아니다: 차트 오버레이는 분봉 버킷 합(과거일
포함)을 가격×시간 격자에 깔았고, 뱃지는 직전 수신 스냅샷 대비 순간 증감을 10호가
카드 안에 잠깐 띄운다. 사용자가 원래 요청한 것이 뱃지 쪽이었다는 사실이 기록으로
남아 있다(2026-07-20).

그래서 삭제 순서가 중요했다. 두 표면이 **공유하던 유일한 계산**인 `sameDeltaChain`
(연속 두 스냅샷을 이어서 diff 해도 되는가 = 같은 거래소인가)을 먼저
`live/liveVenuePolicy` 로 옮기고 나서 모듈을 지웠다. venue 정책이 그 술어의 실체이므로
그 파일이 원래 자리이기도 하다.

`wall_surge`(호가벽 급증)도 남는다. 재료(연속 스냅샷)는 같지만 **규칙이 정반대**라
(`depth_delta` 는 관측창 이동분을 INNER JOIN 으로 배제, `wall_surge` 는 그 배제분을
셋으로 가른다) 코드를 공유하지 않았고, 자체 쿼리(`query_wall_surge`)를 갖고 있었다.

## 부수 효과 — 좌팬 워크백이 빨라진다

실측(2026-08-25)이 `mode=sidecar` 좌팬 비용을 **`depth_delta` 가 단독 지배**한다고
말하고 있었다: 그 슬라이스만 끄면 1.19s → 0.11s. 캔들 0.3s · 호가 0.2~1s 대비
사이드카 4.5~6.3s 였던 구간이 이 제거로 직접 줄어든다. **제거의 근거가 성능은
아니지만**(사용자 결정이다) 그 방향이 뒷걸음이 아니라는 것은 적어 둔다.

## 교차 PR — #1602 의 야간 사전 계산도 함께 걷어냈다

이 제거가 진행되는 동안 **병행 세션이 같은 지표를 강화했다.** PR #1602 가
`hoga/api/depth_delta_precompute.py` 를 추가하고 스케줄러에 Stage 10 을 달아,
`depth_delta` 1분 산출을 야간에 미리 만들어 좌팬 콜드를 없애는 작업이었다. 그쪽 근거도
같은 실측표였다(워크백 비용의 지배항 = 이 지표).

**지표가 사라지면 그 사전 계산은 존재 이유가 없다.** 그래서 모듈·테스트·Stage 10 을
같이 지웠다 — 그런데 **같은 판단을 병행 세션도 내렸다**: #1603 이 #1602 를 통째로
revert 했고(`Revert "Merge pull request #1602..."`), 그것이 이 브랜치의 삭제와 **바이트
단위로 같았다.** 리베이스가 중복분을 스킵해 남은 것은 이 기록뿐이다. 두 세션이 서로를
모른 채 같은 결론에 도달했다는 사실 자체가, 이 결합이 자명했다는 방증이다.

#1602 가 산 것은 「비싼 계산을 야간으로 옮긴다」는 **패턴**이고, 그 패턴이 다시
필요하면 그때의 지배항을 새로 측정해서 붙이면 된다.

⚠ **이 충돌은 `mergeStateStatus: CLEAN` 이었다.** #1602 가 추가한 것은 **새 파일 3개**라
텍스트가 겹치지 않았고, 리베이스도 조용히 성공했다. 그러나 그 모듈은
`from hoga.api.bundle import build_depth_delta_slice` 와 `cache.get_depth_delta(...)` 를
직접 부르므로, 그대로 머지했으면 **`pytest` 가 collection error 로 통째로 실패**하고
스케줄러 Stage 10 이 매 실행 예외를 물었을 것이다. CLAUDE.md 「로컬 검증」 절이 말하는
그 사각 — 워크트리 검증은 base 와 합친 상태를 원리적으로 못 본다 — 이 정확히 여기서
현실이 됐다. **머지 직전 `git fetch origin main` 후 재확인이 유일한 방어다.**

## 잔여 — 지우지 않은 것

1. **디스크 캐시의 고아 파일.** `{data_dir}/kis-past-indicators/**/*.depth_delta.*.json`
   과 `*.depth_delta_prices.json` 은 읽는 코드가 없어져 그대로 남는다. 사용자 데이터라
   이 PR 은 건드리지 않는다. 실측(2026-08-26 사용자 머신): **11,796 파일 · 2.0 GB**
   (`depth_delta.<bucket>` 11,577 + `depth_delta_prices` 219), 캐시 전체 27 GB 중.

   ⚠ **`$HOGA_DATA_DIR` 로 경로를 만들지 말 것.** 그 환경변수는 **보통 설정돼 있지
   않고**, 빈 문자열이면 `find "/kis-past-indicators"` 가 되어 루트를 뒤진다(실측으로
   한 번 겪었다 — 다행히 그 경로가 없어 에러로 끝났다). 경로의 진실 소스는
   `hoga.config.resolve_data_dir()` 이므로 거기서 뽑는다:

   ```bash
   D=$(uv run python -c "from hoga.config import resolve_data_dir; print(resolve_data_dir())")/kis-past-indicators
   ```

   **지우기 전에 세어 본다** — 글롭이 살아 있는 `depth.<bucket>`(히트맵)이나
   `wall_surge` 를 건드리지 않는지가 요점이다:

   ```bash
   find "$D" -name '*.depth_delta*.json' -printf '%f\n' | sed -E 's/^[0-9]{8}\.//; s/\.[0-9]+\.json$/.<bucket>/; s/\.json$//' | sort | uniq -c
   ```

   `depth_delta.<bucket>` 과 `depth_delta_prices` 두 줄만 나오면 지운다:

   ```bash
   find "$D" -name '*.depth_delta*.json' -delete
   ```

2. **브라우저 localStorage 의 `depthDelta*` 키.** 지표 설정 정규화가 화이트리스트
   방식이라 **조용히 버려진다**. 그 성질에 의존하므로
   `liveIndicatorsPersistence.test.ts` 에 「제거된 지표의 옛 키는 조용히 버린다」를
   못 박아 뒀다 — 정규화가 spread 방식으로 바뀌면 그 테스트가 빨개진다.

3. **설계 문서.** `docs/plans/2026-07-20-depth-delta-indicator.md` 는 **삭제하지 않고**
   폐기 배너를 붙였다. 다시 만들 일이 생기면 그 문서의 §2(델타의 정의: 가격 교집합만
   diff · side 분리 · 배제 구간에서 체인 끊기)와 §5(과거일 소스가 없는 이유)를 먼저
   읽는 편이, 같은 함정을 다시 밟는 것보다 싸다.

4. **역사 서술.** 다른 ADR·spec·측정 계획의 `depth_delta` 언급은 그 결정이 내려진
   시점의 사실이므로 본문을 소급 수정하지 않았다(ADR-0157 이 세운 관례). 커밋된
   측정 manifest JSON 2개만 예외로 키를 지웠다 — 그것은 기록이 아니라 **테스트가
   strict 로 검증하는 실행 입력**이라, 남겨 두면 파싱이 깨진다.

## 되살린다면

wire 왕복이 없던 v1 의 구조(오늘 = SSE 세션 누적, 과거 = 백엔드 슬라이스)가 나중에
백엔드 슬라이스로 확장되면서 **오라클과 증분 미러 두 벌**을 갖게 됐다는 점이 이
기능의 가장 큰 유지비였다. 다시 만든다면 그 이중화가 정말 필요한지부터 정할 것 —
패리티 테스트가 동어반복이 되지 않게 하려던 의도였고, 그 대가로 규칙을 바꿀 때마다
두 곳을 같이 고쳐야 했다.
