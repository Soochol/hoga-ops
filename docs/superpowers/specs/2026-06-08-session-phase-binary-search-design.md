# sessionPhaseAt 이진 탐색화 — 차트 projector 핫패스 선형 스캔 제거

- **Date**: 2026-06-08
- **Status**: Implemented (2026-06-08)
- **Scope**: `frontend` — `frontend/src/util/sessionTime.ts` 단일 함수
- **Topic slug**: `session-phase-binary-search`

---

## 1. 문제 (머지 후 재검증 2026-06-08)

`sessionPhaseAt`(sessionTime.ts:87)이 세그먼트 배열을 선형 워크한다. 모든 차트
projector가 캔들/포인트마다 `axis.contains` + `axis.inClosingAuctionWindow`를
부르고 둘 다 여기로 위임하므로(candle.ts:28·30), 250일 스크롤(~170세그먼트 ×
~65k 분봉 × 5패널) 기준 **projection 1회당 수천만 세그먼트 비교**가 발생한다.
`computedBundle`이 SSE 틱마다 재계산되므로 WS 전환 후엔 틱당 비용이 된다.

재산정 결과(원 조사와의 차이): `toVirtual`은 main의 Virtual Axis 리팩터로
**이미 이진 탐색**(findByReal) — 잔여 선형은 `sessionPhaseAt`뿐. `isInGap`도
선형이나 프로덕션 호출처 0건이라 **비범위**(YAGNI).

## 2. 설계

`findByReal`(virtualAxis.ts:160)과 동일한 lower-bound 이진 탐색, 키만
`preOpenStart = sessionOpenMs − PRE_OPEN_WINDOW_LENGTH_MS`:

```
idx = preOpenStart ≤ realMs 인 마지막 세그먼트 (이진)
  해당 없음        → 'pre-axis'  (기존 조기 반환 유지)
  realMs ≤ close  → classifyWithinSegment(seg)  # pre-open/regular/auction
  realMs > close  → idx == last ? 'post-axis' : 'gap'
```

- 시그니처·반환 시맨틱 불변 — 소비처(projector 6종·CandleTooltip·
  useViewportBackfill·virtualAxis 위임 3종) 무수정.
- 동치 전제: 세그먼트 정렬·비중첩(`buildSegments` 불변식, virtualAxis.ts:93-96
  문서화). 선형과 결과가 갈리는 유일한 입력은 중첩 세그먼트인데 불변식상 불가.

## 3. 테스트 전략 (TDD)

1. **접근 횟수 상한(진짜 RED)**: 200세그먼트 축을 Proxy로 감싸 인덱스 접근을
   카운트, `sessionPhaseAt` 1콜 ≤ 24 단언 — 선형은 ~200회라 RED, 이진으로
   GREEN. 시간 측정 없이 O(log n)을 결정적으로 핀.
2. **동치 스윕 가드**: 기존 선형 구현을 테스트 로컬 reference로 보존,
   다중 세그먼트(반장 포함) 축의 모든 경계 ±1ms + 1분 간격 전수 스윕으로
   `binary(t) === linear(t)` 단언.
3. 기존 sessionTime 14개·virtualAxis 46개 그린 유지 + 프론트 전체(1510)·tsc.

## 4. 효과 / 트레이드오프

- 캔들당 세그먼트 비교 ~340 → ~16 (**~20배**), projection 1회당 ~22M → ~1.6M.
- 성능 실측(렌더 체감)은 비범위 — 접근 횟수 단언이 결정적 대체물.
- 코드가 4줄 → ~15줄로 늘지만 findByReal과 같은 관용 패턴이라 비용 낮음.
