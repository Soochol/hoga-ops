# 0106 — 피크 cutoff(보이는 최신 봉 기준) 증분 소스 cutoff-aware 재설계

**Status:** accepted (2026-07-11)

**Related:**
- ADR-0085 — peak-wall 쿼리 OOM: 비등가조인 → Fenwick 선형 스윕 재작성(백엔드 배치의 근본)
- ADR-0062 v3 — 동시호가 배제 공용 술어(isIndicatorEligibleBook, consumeOb 유효성 게이트)

## Context

`askPeakVisibleTimeCutoff`/`bidPeakVisibleTimeCutoff` pref("보이는 최신 봉 기준",
기본 off)를 켜면 당일 최대벽을 "오른쪽 끝에 보이는 분봉 시각(cutoff)까지의 후보만"으로
계산한다. cutoff 는 정규 최대벽과 의미가 다르다 — cutoff 이하 ob/trade 로 **벽과 터치
관계를 재평가**한다(터치가 cutoff 이후면 그 벽은 as-of-cutoff 로는 미체결).

이 cutoff 경로만 `IncrementalPeakWallSource`(no-cutoff 증분)를 못 쓰고
`LiveChartRoot`의 4개 memo(ask/bid × dayPeaks/todayAll)가 배치
`deriveDay*Peaks(cutoff)`를 호출했다. 배치는 SSE 틱(150ms)마다
`liveObSnapshots`/`liveTradeSnapshots` 전량을 `filter → toWallEventsFromOrderbooks(ob×10레벨)
→ toTouchTicksFromTrades → classify` 로 **재스캔·재빌드**한다. deps 에 두 스냅샷 배열이
있어 매 틱 4개 memo 가 full-scan → 증분 소스(LivePage)와 이중 계산이기도 했다.

배경 관찰: cutoff pref 의 실사용은 "스크롤백 상태에서 과거 구간 최대벽 확인"이다. 이때
새 틱은 cutoff 밖에 append 되어 결과가 불변인데도 배치는 매 틱 전량 재계산했다.

기각된 대안:
- **안전 시그니처 가드**(배치 유지 + (cutoff.tMs, cutoff 이하 prefix 길이)로 memo
  스킵): 스크롤백 케이스는 잘 커버하나 live-view-with-cutoff(cutoff=live edge, 틱마다
  prefix 성장)에서는 매 틱 전량 재계산이 남는다. 커버리지가 부분적이라 기각.
- **sparse table 로 터치 range-max 상시 유지**: cutoff 가 팬으로 이동하므로 range
  extreme 이 필요하지만, cutoff 이하 터치 prefix 에 대한 suffix-extreme 를 classify
  호출마다 O(hi) 로 빌드하면 충분(아래). 상시 sparse table 은 과설계라 기각.

## Decision

`IncrementalPeakWallSource`에 **as-of-cutoff 분류**를 추가한다. 누적
(`consumeOb`/`consumeTrade`)은 cutoff 무관하게 델타만 소비하고, **cutoff 는 classify
단계에서만** 적용한다.

1. **`accumulate(ob, trade)` 추출** — `update`(no-cutoff)와 `updateAsOf`(cutoff)가
   공유. append-only prefix-guard(마지막 원소 참조 비교)로 델타만 소비하고, 비-append
   (종목 전환·버퍼 리셋)에는 전체 재소비 폴백. 누적 구조(events/touches)는 cutoff 와 무관.
2. **`classifyAsOf(extras, cutoffMs)`** — 이벤트·extras·터치를 `t_ms <= cutoffMs` 로
   제한. cutoff 가 팬으로 이동하므로 suffixExtreme 를 캐시하지 않고, cutoff 이하 터치
   prefix `[0, hi)`(upper-bound 이진탐색)에 대한 suffixExtremeC 를 **호출마다 O(hi)**
   로 빌드한다(sparse table 불필요). 터치 판정 = `[event.t_ms, cutoff]` 범위 극값 비교
   → 배치 `mergedAskFamilies` cutoff 분기와 동일하게 터치 관계까지 cutoff 기준 재평가.
   no-cutoff classify 의 dedup(`price:qty:t_ms`)·top-3(pushTopK) 규칙을 그대로 상속.
3. **`deriveDay*PeaksIncrementalAsOf` / `deriveTodayAllPrice*IncrementalAsOf`** —
   배치 cutoff assembly(`rankPeakCandidates(postTouch)`, `rankUnique(postUntouched \
   tradedKeys)`, `rankPeakCandidates(all)`)를 라인 단위로 미러링.
4. **LiveChartRoot 배선** — 4계열이 각자 누적 상태를 갖는 ref 소스 사용. todayAll 은 빈
   trade 로 update 하므로 dayPeaks 와 소스 공유 불가(공유 시 canAppendTrade 실패 → 리셋
   스래싱). memo deps 는 그대로라 매 틱 재실행되지만 내부 연산이 델타-only 가 된다.

## Consequences

- cutoff pref ON 사용자의 틱당 비용이 히스토리 재빌드(O(ob×레벨 + trades))에서 분리된다.
  누적은 델타만 소비(perf 테스트로 잠금: `updateAsOf` append-only = consumeOb 델타 1,
  cutoff 이동 = consumeOb 0), classify 는 누적된(재빌드 없는) 구조를 스캔.
- 정확성: cutoff 스윕(정/역방향)·성장·live-edge·경계(cutoff == 벽/터치 시각) 전부 배치와
  **바이트 동일** 오라클 테스트(`incrementalPeakWallSource.test.ts`). 배치가 정확성의
  기준선(ADR-0085 재작성으로 이미 검증됨)이고 증분은 "같은 결과를 덜 계산"한다.
- cutoff pref 껐다 켜기: OFF 동안 성장한 ob/trade 를 ON 시 append-only prefix-guard 가
  누락분만 회수(참조 안정한 라이브 버퍼 전제). 종목 전환은 참조 불일치 → 전체 재소비.
- 트레이드오프: cutoff 는 opt-in 니치 pref(기본 off)라 활성 사용자에게만 이득. 배치
  경로는 완전 제거(no-cutoff 는 LivePage 의 useDay*Peaks 증분 소스가 이미 담당).
- 되돌림: `deriveDay*PeaksIncrementalAsOf` 를 배치 `deriveDay*Peaks(cutoff)`로 되돌리면
  된다(배치 함수·테스트 존치). 소스의 `updateAsOf`/`classifyAsOf` 는 additive.
