# `/live` 성능 감사 — 6개 레인 통합 실행 문서

**요약 3문장.** 이 저장소의 렌더 층·네트워크 층·직렬화 층은 이미 잘 튜닝돼 있고, 여섯 레인이 찾아낸 진짜 비용은 **① `/live` 틱 파이프라인에서 꺼진 지표가 무조건 계산되는 것, ② 15분 슬라이딩 축출이 증분 누적기의 prefix-guard 를 깨는 것(#926 이 형제 하나만 고쳤다), ③ 60초 폴링 경로가 296개 값을 얻으려 871,100행을 파이썬 dict 로 만드는 것** 세 곳에 몰려 있다. 초기 번들 쪽은 절감 여지가 사실상 없고 — 「1071→1230 KB 회귀」는 **JS 전용 기준선과 JS+CSS 현재값을 섞은 지표 오류**이며 like-for-like 는 +111 KB, 그중 절반이 의도된 폰트 self-host 다 — 대신 청크 이름이 내용과 어긋나 이 감사 자체가 4배 오독을 일으켰다는 **계측 정직성 문제**가 드러났다. 적대적 검증에서 발견 24건 중 **12건 CONFIRMED · 12건 WEAKENED**(진짜지만 영향 축소), REFUTED 0건이었고 그와 별개로 각 레인이 **음성으로 닫은 의심이 30건 이상**(§3)이므로, 아래 순위는 원 발견자가 아니라 **검증자가 재측정한 수치**를 기준으로 매겼다. 검증자가 원 레인과 갈린 곳은 **전부 검증자 값을 채택**했고, 그 결과 두 항목의 영향이 **상향**(C-4 아침 콜드 폭발)·**하향**(§0.2 번들 회귀, @dnd-kit 4배 과대평가)됐다.

**지금 당장 하나만 한다면: `useLiveChartData.ts:158-201` 의 최대벽·POC 계산을 지표 토글로 게이트한다** — S 규모 한 줄짜리 수정으로, 지표를 한 번도 켠 적 없는 기본 상태 사용자가 매 150ms flush 마다 전액 부담하던 최상위 확인 비용을 0 으로 만든다(백엔드 fetch 는 같은 토글로 이미 꺼져 있다).

---

## 0. 실측 베이스라인과 지표 정의 정정 — 먼저 읽을 것

이 감사에 주어진 브리핑 수치 두 개가 틀렸다. 다른 결정에 앞서 이것부터 고정한다.

### 0.1 초기 로드 (2026-08-16, 이 워크트리 `npx vite build`)

| 항목 | raw | gzip |
|---|---:|---:|
| `dist/index.html` 의 entry + modulepreload + stylesheet **7파일 합계** | **1,259,038 B (1229.5 KB)** | **374,761 B (366.0 KB)** |
| 그중 JS 6파일 | 1,162,300 B | — |
| 그중 CSS `index-BphJ6pru.css` | 96,738 B | — |
| CSS 안의 `@font-face` 92블록 | 48,158 B (CSS 의 49.8%) | — |
| `live-workspace-*.js` (경고 임계 700 KB 에 3 KB 남음) | 696,983 B | — |
| `react-*.js` — 사실상 빈 청크 | **184 B** | — |

### 0.2 「1071 KB → 159 KB 회귀」는 지표 혼용이다

87f97567(2026-07-30) 트리를 `git archive` 로 꺼내 현재 node_modules 로 재빌드한 결과:

- 그때의 **JS 합계 = 1,097,770 B (1072.0 KB)** → vite.config 주석의 「1071 KB」와 일치
- 그때의 CSS 47,301 B 는 **그 수치에 포함돼 있지 않았다**(`@font-face` 0개). `routeSplitting.test.ts` 주석도 측정법을 "dist/index.html 의 modulepreload 집합" 으로 못박는데 stylesheet 는 modulepreload 가 아니다.

**like-for-like 정정:**

| 축 | 2026-07-30 | 현재 | 차이 |
|---|---:|---:|---:|
| JS | 1,097,770 | 1,162,300 | **+64,530 (+5.9%)** |
| CSS | 47,301 | 96,738 | +49,437 |
| └ 그중 `@font-face` | 0 | 48,158 | (앱 CSS 자체는 **+1,279 B**) |
| **합계** | 1,145,071 | 1,259,038 | **+113,967 B (+111.3 KB)** |

**회귀 분해:** 폰트 self-host 48,158 B(42%, #993/ADR-0134 의 **의도된 거래** — jsdelivr 렌더 블로킹 `<link>` 제거의 대가) · 7/30 이후 신규 eager 모듈 33개 28,174 B(25%) · 기존 eager 모듈 내부 성장 ≈36 KB(33%).

**결론: 되돌릴 것이 없다.** 159 KB 라는 숫자도, "절반이 잘못 들어왔다" 는 서사도 성립하지 않는다. 이 절의 산출물은 바이트 절감이 아니라 **지표 정의를 JS+CSS 로 통일하고 vite.config 주석을 재현 가능한 형태로 고치는 것**이다(→ 트랙 4).

---

## 1. 순위표 — 체감 개선 ÷ 비용

정렬 기준: **이 앱을 6시간 켜 두고 쓰는 트레이더가 가장 먼저 느낄 개선**. 상시 부담 > 조작마다 > 가끔.

| # | 항목 | 레인 | 검증 | 효과 | 규모 | 위험 |
|---|---|---|---|---|---|---|
| 1 | ✅ **구현됨** 꺼진 지표(최대벽·POC·firstTrailing)가 무조건 계산 | A-2 · B-3 | CONFIRMED×2 | 기본 상태 사용자의 최상위 항 → 0 | **S** | 낮음 |
| 2 | ✅ **구현됨** `hasDeep` 이 호출마다 배열 2개 할당 | A-4 | CONFIRMED | 창당 0.4~1.1 ms/flush + 전 호출부 확산 | **S** | 낮음 |
| 3 | 워크스페이스 `rect` 신원이 memo 를 항상 뚫음 | F-1 | CONFIRMED | 드래그·행 드롭 중 무관한 차트 창 전부 재렌더 → 0 | **S** | 낮음 |
| 4 | reveal 커버가 문구 없이 4.6~11.7초 침묵 | F-2 | CONFIRMED | 종목 첫 방문마다 "고장났나" 구간 제거 | **S** | 낮음 |
| 5 | `_load_daily_rows` 871k행 물질화 | C-1 | CONFIRMED | 60초마다 630 ms → ~120 ms (13×) | **S** | 낮음 |
| 6 | 슬라이딩 축출이 prefix-guard 를 깸 | A-1 · B-1 · E-1 | CONFIRMED×3 | 잠재 최대. **선행 측정 필수** | **M/L** | 중간 |
| 7 | `/api/live/quotes` 기준가 N+1 이 루프 위에서 | C-4 | **CONFIRMED** | **매 거래일 아침 첫 폴에 2.0~2.5초 루프 정지** → 한 자릿수 ms | S | 중간 |
| 8 | 섹터 랭킹 당일 경로가 캐시를 전부 우회 | C-3 | WEAKENED | #5 수정의 **두 번째 수혜처** — 독립 착수 불필요 | S | 중간 |
| 9 | `range-merged` identity 고아 2시간 상주 | E-2 | CONFIRMED | 지표 토글 시 23 MB 급 누적 차단 | M | 낮음~중간 |
| 10 | `manualChunks` 무력화 → 청크 이름이 거짓 | D-1 | WEAKENED | **0 바이트**. 계측 정직성 | S | 낮음 |
| 11 | `/live` 내부 lazy 경계 0개 | D-2 | WEAKENED | 초기 로드 −33.2 KB raw / −9 KB gzip | M | 낮음 |

C-2(이벤트 루프 기아)는 **1단계가 #5 와 동일 수정**이라 별도 항목으로 세우지 않고, 남은 계측 부분만 트랙 4 로 넘겼다.

---

## 트랙 1 — `/live` 틱 파이프라인 (항목 1 → 2 → 6)

**묶음의 논리:** 셋은 같은 150 ms 예산을 나눠 먹는다. 1·2 는 각각 S 규모이고 **6 의 착수 여부와 무관하게 즉시 이득**이며, 6 은 난도·위험이 한 단계 높고 **측정 선행이 필요**하다. 1·2 를 먼저 넣고 그 상태에서 6 의 N 을 재는 순서가 맞다.

**예상 효과:** 항목 1 은 기본 상태(지표 OFF) 사용자의 차트 창당 최대벽 4개 인스턴스 + POC + firstTrailing 을 전부 제거 — 축출 정상상태 기준 창당 **12~54 ms/flush**(1~5 ob/s) 또는 **125~310 ms/flush**(10~20 ob/s), append-only 상태에서도 **1.3~10.9 ms/flush**. 항목 2 는 창당 **0.4~1.1 ms/flush** + `buildLiveBundle.ts` 다수 지점 확산. 항목 6 은 위 12~310 ms 중 `consumeOb` 지배항(전부는 아님 — `classify()` 는 append-only 경로에서도 누적 이벤트 전량을 도는 설계다). **총 M/L 규모.**

### 1-1. 꺼진 지표가 무조건 계산된다 (A-2 · B-3, CONFIRMED×2) — S / 낮음 · ✅ 구현됨

> **구현 완료 (브랜치 `claude/project-performance-improvement-d9778c`).** 게이트는 `ob`/`trade` 인자만
> 끊고 `seeds`·`candles`·`segments` 는 흘린다 — 그래서 아래 「폴백 한 줄이 load-bearing」 이
> 요구한 백엔드 래칫 보존이 **별도 코드 없이** 성립한다(꺼진 경로가 일봉 경로와 같은 코드
> 패스를 탄다). 검증 ①②③은 유닛 가드로 닫혔고 red-check 을 눈으로 봤다. **④ 픽셀 대조는
> 미완**(워크트리 코드는 :5173 에 안 뜨고 오늘은 토요일이라 라이브 스트림이 없다) — 장중
> 계측과 함께 처리한다. 이 절은 배경 기록으로 남긴다.

**증거.** 게이트가 **있는** 쪽 — `frontend/src/live/useLiveBundle.ts:443-444`:

```ts
askPeaksEnabled: enableMinute && args.askPeakEnabled,
bidPeaksEnabled: enableMinute && args.bidPeakEnabled,
```

게이트가 **없는** 쪽 — `frontend/src/live/useLiveChartData.ts:158-201`. `isMinuteTimeframe(timeframe)` 이 유일한 가지치기이고, `askPeakEnabled`/`bidPeakEnabled` 는 **이 파일에 한 줄도 없다**:

```ts
const askPeakOb = isMinuteTimeframe(timeframe) ? live.ob : EMPTY_OB_SNAPSHOTS;
const dayAskPeaks = useDayAskPeaks(askPeakOb, askPeakTrade, ...);   // :162
const todayAllPriceAskPeak = useTodayAllPriceAskPeak(askPeakOb, ...); // :172
// bid 동일 (:184, :194), 그리고 :202 useTradeVolumePocs 도 무조건
```

기본값 OFF 는 `state/liveIndicatorsPersistence.ts:336`(`obj?.askPeakEnabled === true`)과 `state/indicatorSettingsV2.test.ts:32-33` 이 고정한다. 토글은 렌더 단계에서만 읽힌다(`LiveChartRoot.tsx:1381,1730`, `LiveAskPeakSegments.tsx:457`). 기본 봉이 분봉인 것도 확인됐다(`workspace/windowView.ts:105·283·343` 전부 `?? '1m'`) — 즉 **기본 상태가 이 경로를 탄다**.

**증상.** 최대벽·매물대를 한 번도 켠 적 없는 사용자가 장중 `/live` 분봉 창에서 이 비용을 전액 낸다. 화면에는 아무것도 안 그려지므로 사용자가 원인을 지목할 단서가 전혀 없다.

**기전.** 빈도 `LIVE_FLUSH_MS = 150`(`api/liveSeries.ts:87`) → 6.67 flush/s. 인스턴스 차트 창당 최대벽 4 + POC 1 + `firstTrailingSinglePriceBookMs` 1. `useTradeVolumePoc.ts` 의 memo 는 진입 조건이 `todaySegment` 와 `rangeCount > 0` 뿐인데 `volumeDistributionRangeCount` 기본값이 10 이라 **항상 만족**된다. 백엔드는 토글로 이미 seed 를 안 보내는데 클라이언트만 없는 데이터를 위해 버퍼를 훑는 **비대칭 상태**다.

**수정.** `isMinuteTimeframe` 게이트와 같은 자리·같은 모양으로 확장한다(`useLiveBundle` 이 이미 `useWindowIndicators()` 로 두 값을 읽으므로 새 배선이 아니라 인자 하나):

```ts
const peaksOn = isMinuteTimeframe(timeframe) && askPeakEnabled;
const askPeakOb = peaksOn ? live.ob : EMPTY_OB_SNAPSHOTS;
```

**⚠ 폴백 한 줄이 load-bearing.** `useLiveChartData.ts:225` 의 `liveSaveBundle.ask_peaks = dayAskPeaks` 가 `/study` 저장 뷰로 나간다. 꺼진 경로에서는 이미 export 된 백엔드 래칫 `buildTodayAllPriceAskPeak(liveInitial.ask_peak_today)`(`useDayAskPeaks.ts:204`)로 대체할 것. 이걸 빼면 "지표 끈 채 저장한 뷰에서 나중에 켜면 오늘 벽이 없다" 가 된다.

**적용 범위는 셋 다.** 최대벽만 게이트하면 POC(`useLiveChartData.ts:202`)와 `firstTrailingSinglePriceBookMs` 가 그대로 남는다.

**검증.** ① `isIndicatorEligibleBook` 스파이 + `askPeakEnabled:false` 렌더 → `consumeOb` 호출 수 **0**, 켜면 종전과 동일(red-check 은 게이트 on/off 교대). ② 토글 ON 에서 `dayAskPeaks` 스냅샷 패리티. ③ **저장 뷰 왕복**: 지표 OFF 로 저장 → `/study` 에서 열어 ON → 오늘 벽이 보이는지(폴백의 red-check). ④ 켜진 상태의 픽셀 대조 — 배선이 아니라 픽셀로 인수 판정할 것(#1321→#1325→#1333 이 같은 가정으로 3연속 미완성 머지됐다).

**선행 작업.** `git log -S 'depthHeatmapEnabled' -- frontend/src/live/buildLiveBundle.ts` → **#923(A안)** 이 같은 처방을 히트맵·증감에만 적용했고 그 근거 주석이 `buildLiveBundle.ts:79-95` 에 남아 있다("실측 2026-07-29 … 전체 재빌드 비용의 73~94% … 끈 사용자에게 이 비용은 전액 낭비였다"). `git log -S 'askPeakEnabled' -- useLiveChartData.ts` → **0건**. 기각이 아니라 **#923 의 적용 누락**.

### 1-2. `hasDeep` 이 호출마다 배열 2개를 할당한다 (A-4, CONFIRMED) — S / 낮음 · ✅ 구현됨

> **구현 완료 (같은 브랜치).** 모듈 레벨 `hasDepthBeyondLevel3` 무할당 루프. 재현 실측은
> 9k 0.58→0.18 ms · 18k 1.06→0.29 ms 로 아래 수치와 **9k/18k 에서 일치**하고 36k 는 방향만
> 같다(2.28 vs 감사 1.54). 경계 파리티 테스트를 따로 뒀다 — 길이 ≤3 · `undefined` · 한쪽만 깊음.

**증거.** `frontend/src/live/bucketHogaSeries.ts:51-52`:

```ts
const hasDeep = (lv) => !!lv && lv.slice(3).some((l) => l.qty > 0);   // 호출당 배열 2개
```

소비처 `frontend/src/live/continuousTradeVolumeDistribution.ts:160-185` 의 `firstTrailingSinglePriceBookMs` 는 조기 종료 없이 ob 창을 **두 번 완주**하고, 스냅샷마다 이 술어를 부른다. 호출부는 `useTradeVolumePoc.ts:66-68`(memo deps 에 `orderbooks`) **와** `workspace/DataWindow.tsx:577` 두 곳이다.

**실측(검증자 재현).** 9k / 18k / 36k 스냅샷에서 현행 **0.59 / 1.30 / 1.54 ms**, 무할당 변형 **0.17 / 0.17 / 0.68 ms**.

**수정.** 술어를 무할당 루프로 — `for (let i = 3; i < lv.length; i++) if (lv[i].qty > 0) return true; return false;`. 동작 동일. 이득이 이 함수 하나에 그치지 않는다: `isContinuousBook`/`isIndicatorEligibleBook` 은 `buildLiveBundle.ts:217,231,273,291,624,657,663` 과 `incrementalPeakWallSource.ts:147`(스냅샷당 1회)에서도 쓰인다. **수정 대상은 `firstTrailingSinglePriceBookMs` 가 아니라 `hasDeep` 이다.**

**선행 작업.** `git log -S 'lv.slice(3)'` → ADR-0062 도입 커밋 1건뿐. ADR-0062 는 "시간 대신 **구조**로 검출" 이라는 의미론 결정이라 무할당 재작성과 충돌하지 않는다.

### 1-3. 슬라이딩 축출이 prefix-guard 를 깬다 (A-1 · B-1 · E-1, CONFIRMED×3) — M/L / 중간

**증거.** `frontend/src/live/incrementalPeakWallSource.ts:133-137`:

```ts
private canAppendOb(ob: ReadonlyArray<ObSnapshot>): boolean {
  if (ob.length < this.obLength) return false;
  if (this.obLength === 0) return true;
  return ob[this.obLength - 1] === this.lastObRef;   // 앞이 한 건이라도 잘리면 항상 false
}
```

(`:139-143` 은 동형의 `canAppendTrade`.) `:109-116` 이 그 false 를 `reset()` + `consumeOb(ob 전량)` 으로 받는다. 입력은 `frontend/src/live/liveSnapshotBuffer.ts:23-28,86` 의 `evictOld` → `arr.splice(0, drop)` 로 **앞에서 잘리는** 15분 창이다. 형제 `IncrementalTradeVolumePoc` 도 같은 술어를 쓴다(`tradeVolumePoc.ts:297-298`).

이 파일 `:29` 의 자기 주석 "prefix-guard 는 IncrementalHogaBucketer 와 동일" 이 **지금 거짓이다** — 버킷터는 `buildLiveBundle.ts:425 locate()` + `:482 reconcileEviction()` 으로 갈라졌다. `git show --stat 62270593`(#926) 의 변경 파일은 `buildLiveBundle.ts` + `incrementalHogaEviction.test.ts` **둘뿐**이다.

**이 저장소가 이 병리를 자기 주석에 미리 적어 놨다** — `buildLiveBundle.ts:79-95`: "15분 슬라이딩 버퍼가 앞을 자르기 시작하면 prefix-guard 가 깨져 유입률 ≥ flush율(6.67/s)인 구간에선 **매 flush 가 전체 재빌드**".

**증상.** 장중 `/live` 분봉 창에서 크로스헤어·팬/줌·창 드래그가 끊긴다. **판별식은 "새로고침하면 한동안 괜찮다"**. 창을 여러 개 띄울수록 비례해 악화.

**증상 개시 시점 — 정정.** 원 레인 하나가 "장중에 페이지를 새로 열면 즉시" 라고 적었으나 **틀렸다**. 백엔드 링은 `hoga/live/buffer.py` 의 `maxlen = cap_for_retention(900_000) = 90×4 = 360` 이라 `/api/live/series` hydrate 는 kind 당 **최대 360건**만 준다. 따라서 개시는 어느 경로든 **프론트 버퍼가 스스로 15분을 채운 뒤**다.

**측정 상태 — 착수 전 반드시 읽을 것.** 벤치 수치는 확정이지만 **입력 N 이 미측정**이다.

| ob/s | 15분 창 | append-only | 축출 정상상태 (원 측정 → 검증자 재현) |
|---:|---:|---:|---:|
| 1 | 900 | 1.1 ms | 8.1 → **12.5 ms** |
| 2 | 1,800 | 1.0 ms | 14.8 → **18.9 ms** |
| 5 | 4,500 | 2.2 ms | 39.0 → **54.4 ms** |
| 10 | 9,000 | 4.4 ms | 87–100 → **124.8 ms** |
| 20 | 18,000 | 9.4 ms | 210–268 → **309.8 ms** |

(차트 창 1개의 4개 인스턴스 합계, 150 ms flush 1회당.) 그런데 9k/18k/36k 라는 버퍼 크기는 **#926 벤치의 입력 파라미터**(10/20/40 ob/s 가정)이고, 키움 0D 의 종목당 실제 틱률은 **이 저장소에서 한 번도 측정된 적이 없다**(메모리 #1316 항목이 "키움 WS 틱 주기 미실측" 이라고 남겨 뒀다). 아키텍처가 per-tick 인 것은 확정이고(`stream.py` `_on_tick` → `buffer.publish`, 키움 0D 경로에 throttle·dedup 없음), 리포 자신의 WS 실측(005930_NX 0D **2,217틱/2분 ≈ 18.5/s**)이 상단을 뒷받침한다. 그래도 평범한 종목은 1~5 ob/s 일 수 있고 그러면 12~54 ms/flush 다.

**⚠ 수정은 `locate()` 의 기계적 이식이 아니다.** 세 검증자가 독립적으로 같은 함정을 지적했다:

- `classify()`(`:234`)와 `classifyAsOf()`(`:300`)는 **매 호출 `this.events` 를 전량 순회**하는 설계이고, `events` 에는 `reset()` 말고 가지치기 경로가 없다.
- 가드만 축출에 강하게 만들면 `events` 가 세션 내내 단조 증가해 ① classify 비용이 오히려 커지고 ② **창 밖으로 밀려난 벽이 남아 배치 오라클(현재 배열만 본다)과 갈라진다.** #926 커밋 본문이 버킷터에서 실측한 "피크가 창 밖으로 밀리면 오라클 `ask_max` 는 5000→120 인데 누적본은 5000" 과 정확히 같은 실패다.
- 즉 **지금의 깨진 가드가 정확성과 메모리 상한을 우연히 지켜 주고 있다.** 올바른 수정은 `locate()` + **축출 조정**(`events` prefix 절단 + `eventIndexByKey` 의 `baseOffset` 리베이스 + `touchTimes`/`touchPrices` 각자 head 기준 prefix 컷 + `touchIndexDirty`) 이고, `events` 가 `price:t_ms` 키의 평면 배열이라 버킷터보다 난도가 한 단계 높다.

**착수 전 선행 조건 (코드 수정 아님).** 장중 1회 계측: 차트 창 1개에서 `live.ob.length` 와 **폴백 발생 횟수**를 찍는다. N 이 수백 급이면 이 항목은 순위가 내려가고, 수천 급이면 트랙 1 최상위다.

**검증.** ① 결정론적 호출 수 가드(벽시계 단언은 #434/#516/#977 이 이미 기각) — `useDayPeaks.perf.test.tsx` 에 축출 케이스 추가:

```ts
src.update(ob, [], OPEN_MS, []);                          // 2000건 소비
src.update([...ob.slice(1), mkOb(2000)], [], OPEN_MS, []); // 앞 1건 축출 + 뒤 1건 append
expect(spy.mock.calls.length - after).toBeLessThanOrEqual(2);  // 지금은 2000 (red)
```
**현재 코드에서 빨간 것을 눈으로 볼 것.** 기존 테스트 4개가 전부 append-only 배열(`:44`)과 배열 통째 교체(`:61`)라 **선두 절단을 원리적으로 못 본다** — 그게 이 결함이 숨은 이유다. ② 축출 후 incremental == 콜드 소스 패리티(이걸 빼면 값이 틀린 채 초록이 된다). ③ 장중 15분 이상 열어 둔 뒤 Performance 로 `consumeOb` self time — **새로고침 직후 재면 안 나온다**.

**POC 는 rider 로.** `IncrementalTradeVolumePoc` 은 같은 결함이 확인됐고(축출 정상상태에서 `fullRebuilds` 25 flush 중 **25회**) 비용은 **0.07 / 0.12 / 0.37 / 0.80 ms**(1/5/10/20 프레임/s) — 피크벽의 **100~400배 작다**(문자열 키도 Map 도 안 쓰고 정수 bin 만 더한다). 단독 수정 가치는 없고, 위 수정 시 같은 처방을 함께 적용하는 정도. 다만 버킷이 **합**이라 축출분을 빼거나 선두 분 하나만 다시 접어야 하고, 리셋 키에 `rangeMin|rangeMax` 가 박혀 있어(`tradeVolumePoc.ts:294`) **당일 신고가·신저가 갱신마다** 축출과 무관하게 전량 재소비가 한 번 더 발화한다.

**선행 작업.** ADR-0106 `docs/adr/0106-peak-cutoff-incremental-source.md:65` 가 전제를 "참조 안정한 라이브 버퍼 전제" 라 명시하고 폴백 트리거를 "종목 전환·버퍼 리셋" 으로만 열거한다 — 축출이 없다. #926(2026-07-29)이 형제에서 그 전제가 틀렸음을 실측으로 밝혔다. **이미 반증된 전제 위에 남은 코드**이지 의도적 기각이 아니다.

---

## 트랙 2 — 인터랙션 지연 (항목 3, 4)

**묶음의 논리:** 둘 다 S 규모·낮은 위험·CONFIRMED 이고, **트랙 1 과 파일이 겹치지 않아 병행 가능**하다. 프레임 예산이 아니라 "손끝 반응" 과 "시스템이 살아 있다는 신호" 를 고친다.

**예상 효과:** 항목 3 은 창 드래그·행 드롭 중 **드래그에 참여하지 않는 차트 창의 재렌더를 0 으로** — 창 4~6개 워크스페이스에서 드래그가 끌리는 체감의 직접 원인. 항목 4 는 종목 첫 방문마다 생기는 **4.6~11.7초 무문구 커버**에 안내를 붙인다. **총 S 규모.**

### 2-1. `rect` 객체 신원이 창 memo 를 항상 뚫는다 (F-1, CONFIRMED) — S / 낮음

**증거.** `frontend/src/workspace/WorkspaceCanvas.tsx:321`:

```ts
const rectOf = (w: W): Rect => preview?.get(w.id) ?? toPx(w.rect, canvasBox);
```

`workspace/rectSpace.ts:33-40` 의 `toPx` 는 매번 `{x,y,w,h}` **객체 리터럴을 새로** 반환한다. 그 값이 `:353 rect={rectOf(w)}` 로 들어가고, `frontend/src/live/workspace/WorkspaceCanvas.tsx:287` 의 `memo(function WorkspaceWindowItem(...))` 는 **비교자 인자가 없어** 기본 얕은 비교가 rect 에서 실패한다. 나머지 props(zIndex·focused·lifting 원시값, `itemCtx` useMemo, `onHandleDown`/`onFocus` useCallback)는 전부 안정 — **rect 가 유일한 파괴자**다.

바로 위 `:280-286` 주석은 **정반대를 약속한다**: "항목을 memo 컴포넌트로 끊고 원시/안정 참조 props 만 넘기면 드래그 중엔 rect 가 바뀐 창(드래그+follower)만 재렌더된다."

아래 방어선도 없다 — `workspace/WindowFrame.tsx:140`·`live/workspace/WindowFrame.tsx:143` 은 memo 지만 rect + children JSX 신원으로 통과하고, `ChartWindow`(`live/workspace/ChartWindow.tsx:70`)·`ChartWindowInner`(`:113`)·`LiveChartRoot`(`live/LiveChartRoot.tsx:396`)·`DataWindow`(`live/workspace/DataWindow.tsx:83`)는 **전부 memo 가 아니다**. LiveChartRoot 의 오버레이 자식 중 memo 인 것은 `LiveWallSurgeMarkers` 와 `chart/RangeSeriesPane` 둘뿐.

**증상 (3경로 중 2개 무조건, 1개 조건부).**
- ① **창 드래그/리사이즈 (~60Hz, 무조건)** — `workspace/WorkspaceCanvas.tsx:224,242` 의 `setPreview(next)` 가 코어를 재렌더 → `rectOf` 가 **모든** 창에 새 객체 발급 → 전 창 memo bail.
- ② **관심종목/스크리너 행 드래그 (rAF, 무조건)** — `state/useDragPointPublisher.ts` → `live/workspace/WorkspaceCanvas.tsx:84` 의 `dragPoint` 구독 → 같은 경로. (발행 측 rAF 스로틀은 #639bfa8c 에서 잘 고쳐졌다. 새는 곳은 그 아래다.)
- ③ **장중 5초 status 폴링 (조건부)** — `api/liveStatus.ts:124 refetchInterval: 5_000`. 검증자가 무자격 dev 서버에서 5초 간격 2회 GET 을 떠 보니 **응답이 바이트 동일**이었고, react-query v5 의 structural sharing 이 참조를 보존해 재렌더가 없었다. 장중 실계정에서는 `last_tick_ms`·`cycle_lag_ms`·`cache_stats` 가 바뀌어 원 주장대로 되지만 **이 세션에서 확인 못 했다** → "payload 가 바뀌는 폴에 한정" 으로 읽을 것.

**창 하나당 비용.** `ChartWindowInner` → `useLiveChartData` → `useLiveBundle`(react-query 훅 다발) → `LiveChartRoot`(훅 51개 + zustand 셀렉터 32개) → 비-memo 오버레이 ~25개 재조정. 메모는 대부분 캐시 히트지만 useQuery 재평가·훅 순회·자식 재조정이 창 수에 그대로 비례한다.

**수정 — 생산자 측에서 신원 고정** (#1330 의 "생산자 정렬" 선례):

```ts
const pxRects = useMemo(() => {
  const m = new Map<string, Rect>();
  for (const w of windows) m.set(w.id, toPx(w.rect, canvasBox));
  return m;
}, [windows, canvasBox]);
const rectOf = (w: W): Rect => preview?.get(w.id) ?? pxRects.get(w.id) ?? toPx(w.rect, canvasBox);
```

드래그 중에는 스토어를 안 건드리므로 `windows` 신원이 안정이다. **수정이 코어에 있으므로 `/study` 캔버스도 같이 고쳐진다.**

**남는 것(수정 후에도).** `TitleBarSymbolRow` 는 자체적으로 `useLiveStatus` 를 구독하므로(`:68`) 타이틀바는 payload 가 바뀐 폴마다 여전히 재렌더된다. 그리고 `:60` 의 `heatmapGroupNameOf` 전수 조회와 `:69-78` 의 `entries.map` 은 **관심종목 297건** 배열을 매 렌더 새로 만든다 — 원 레인이 "무시할 만하다" 고 했지만 그보다 크다. 이건 별건으로 남긴다.

**검증.** 코어의 `windowItem` 이 주입 슬롯인 점을 이용해 **결정적 유닛 테스트**로 — 렌더 횟수를 세는 더미 `windowItem` 으로 창 3개를 세우고 한 창에 pointerdown → pointermove 를 흘린 뒤 **참여하지 않은 창의 렌더 증가 = 0** 을 단언. 수정 전에는 +1 이어야 한다(red-check). 브라우저 교차 확인은 React DevTools Profiler.

**선행 작업.** `git log -S 'rectOf'` → `348baed6`(#804 코어 분리) 1건. `git log -S 'WorkspaceWindowItem'` → `453eddc9`(#719) 1건. rect 신원을 다룬 커밋 **0건**. 재렌더 경계를 다룬 ADR 없음(0122 좌표계·0123 코어 분리·0127 오프스크린 드래그는 다른 축). **코드 주석이 확보돼 있다고 잘못 기술하고 있고, 렌더 카운트 테스트가 없어 한 번도 검증된 적이 없다.**

### 2-2. reveal 커버가 문구 없이 침묵한다 (F-2, CONFIRMED) — S / 낮음

**증거.** 홀드 게이트 `frontend/src/live/LiveChartRoot.tsx:948`:

```ts
if (!isHogaLoading && !isSidecarLoading) reveal();
```

안내 문구 게이트 `:2422`:

```tsx
{cb !== null && cb.candles.length > 0 && !chartReady && isHogaLoading && (   // isSidecarLoading 없음
```

따라서 `캔들 도착 + isHogaLoading=false + isSidecarLoading=true` 에서는 `:2390-2402` 의 커버(`background: var(--bg-card)`, `opacity:1`, `zIndex:30`)만 남고 문구가 하나도 없다. `:2406` 의 `past-candles-loading-note` 는 `(!cb || cb.candles.length === 0)` 가드에 걸리고, 타이틀바 칩(`TitleBarSymbolRow.tsx:116-120`)은 백필 채널이라 이 구간을 못 덮는다.

**실측(검증자, dev 서버 :8000 병렬 GET).** `/live` 초기 분봉 창과 같은 5거래일 창, 006360, bucket 60s — 콜드 hoga **44 ms** vs sidecar **4.68 s** → 캔들이 앉은 뒤 **약 4.6초간 글자 없는 단색 사각형**. 028050 한 달 창(좌측 팬으로 넓힌 경우)은 **11.7초**. 웜은 43 vs 88 ms 로 무시할 수준.

**발동 조건 (좁혀야 한다).** ① 분봉 창 한정 ② 사이드카 지표 최소 1개 ON **또는** 같은 그룹에 매물대·프로그램 데이터 창이 열림(`useLiveBundle.ts:492-494` 의 `sidecarDemands` 가 토글과 무관하게 켠다) ③ 캐시 콜드일 때. **공장 기본값 사용자는 발생하지 않는다** — `state/indicatorSettingsV2.ts:83-92` 의 `FACTORY_INDICATOR_SETTINGS` 가 관련 토글을 전부 false 로 둔다.

**수정 — 한 줄.** 문구 게이트를 홀드 게이트와 같은 집합으로:

```tsx
{cb !== null && cb.candles.length > 0 && !chartReady && (isHogaLoading || isSidecarLoading) && (
```

**무한 홀드(#579)는 그대로 둔다** — 캡을 되살리는 게 아니라 이미 있는 문구의 적용 범위를 홀드 범위와 일치시키는 것. 기존 문구 "지표 불러오는 중…" 이 사이드카·일봉MA 케이스에도 정확하므로 새 시각 요소를 발명하지 않는다(DESIGN.md 규율에도 맞다).

**검증.** `LiveChartRoot.test.tsx:2061` 과 같은 조성으로 `isPastCandlesLoading=false, isHogaLoading=false, isSidecarLoading=true`, 캔들 100개 → `getByTestId('hoga-loading-note')` 가 보일 것. **수정 전에 빨간지 눈으로 확인**(현재는 null 이어야 정상). `:2079` 에 문구 소멸 단언도 같이.

**선행 작업.** `git log -S 'hoga-loading-note'` → `6ddd5790`(#457) 1건 — 문구는 **침묵 커버를 막으려고** 만들어졌다(`:2420` 주석: "침묵 커버가 '행' 처럼 보이는 걸 막는다"). 이후 `597cfcd2`(#479)·`00ec48c4`(#579)가 홀드 게이트만 넓히고 문구는 안 따라갔다. 테스트 3연(`:2061`·`:2079`·`:2109`)도 커버 opacity 만 보고 문구는 검사하지 않는다. **기각이 아니라 이관 누락.**

---

## 트랙 3 — 백엔드 60초 케이던스 (항목 5, 7, 8 + 루프 지연 프로브)

**묶음의 논리:** 셋 다 "히트맵·시세 폴링이 GIL 을 붙들고 도는 순수 파이썬 구간" 이라는 같은 병리이고, 처방도 같다 — **파이썬 행 물질화를 SQL/배치로 밀어낸다**. 이벤트 루프 기아(C-2)는 별도 수정이 아니라 이 셋의 결과다.

**예상 효과:** 항목 5 는 60초마다 **630 ms → ~120 ms**(실측 13× — `_load_daily_rows` 473 ms → 최소 쿼리 35 ms). 항목 7(C-4) 은 **매 거래일 아침 첫 폴의 2.0~2.5초 루프 정지 → 한 자릿수 ms**(검증자 실측 30코드 264.9 ms → 배치 13.8 ms, 약 19×) 이면서 그 구간을 루프에서 내린다. 항목 8(C-3) 은 **항목 5 를 하면 함께 해결**되므로 독립 착수 대상이 아니다. **실질은 S+S = M 규모.**

> **⚠ C-2(이벤트 루프 기아)의 판정은 WEAKENED 다.** 축소 사유는 기전이 아니라 **선행 인식 주장이 틀렸다**는 것 — 원 레인은 "`to_thread` 안쪽의 순수 파이썬도 GIL 로 루프를 굶는다" 는 축이 저장소에 없다고 적었으나, `grep -rn 'GIL' hoga/` 는 **7개 파일 20곳**을 낸다(`api/routes.py:53`·`:775-778` 등이 이 축을 명시적으로 논한다). 즉 **인지되지 않은 축이 아니라, 인지된 축의 새 사례**다. 기전과 처방은 유효하다.

### 3-1. `_load_daily_rows` 가 296개 값을 얻으려 871,100행을 만든다 (C-1, CONFIRMED) — S / 낮음

**증거.** `hoga/live/index_sector_rankings.py:91-105`:

```python
df = (pl.scan_parquet(path).filter(pl.col("code").is_in(codes))
        .filter(pl.col("date") <= basis).select(["code","date","close"])
        .collect().sort(["code","date"]))
by_code: dict[str, list[dict]] = {}
for row in df.iter_rows(named=True):
    by_code.setdefault(str(row["code"]), []).append(row)
```

소비처 `hoga/api/heatmap_group_flow.py:225-230` 은 **코드당 1행**(basis 직전 종가)만 쓴다:

```python
prev = next((r for r in reversed(rows) if r["date"] < basis), None)
```

두 번째 호출부는 `index_sector_rankings.py:405`.

**실측(검증자 재현, 실데이터 `daily_adjusted.parquet` 133 MB / 8,692,057행, 히트맵 308엔트리·296유니크).** rows=**871,099**, collect+sort 66 ms, `iter_rows` dict 빌드 **407 ms**, 합 473 ms. 최소 쿼리(`date < basis` → `group_by(code).agg(close.sort_by(date).last())`) = **35 ms / 296행**. `build_group_flow` cProfile 825 ms 중 `_load_daily_rows` **816 ms(99%)**.

**⚠ 사용자 체감 수치 정정.** 원 레인이 인용한 slow-log 집계(`/api/heatmap/group-flow` 521건 p50 3.85 s max 33.1 s)는 **단일 서버의 비용이 아니다** — `~/.local/share/hoga-ops/logs/hoga.log` 는 PID·포트가 줄에 없고 **여러 백엔드 프로세스가 같은 파일에 append** 한다(`hoga/api/app.py:537`). 병행 워크트리 세션들이 띄운 인스턴스가 다수 확인됐다. 검증자가 **머신이 한산한 상태에서 사용자 dev 서버 하나로** 직접 재니 버스트 창 밖 콜드 **630 ms**, 창 안 **1 ms**. 정직한 서술은 **"60초마다 약 0.5~0.6초의 GIL 보유 파이썬 구간"**.

**성장 축은 확인된다.** 필요 출력은 296행 고정인데 입력은 296 × 평균 2,943일 = 871k — 코퍼스가 하루 자랄 때마다 296행, 종목을 추가할 때마다 ~3,000행 늘어난다. 캐시도 없다(라우트의 30초 버스트 창은 프론트 폴링 주기 60초보다 짧아 단일 클라이언트에선 절대 히트하지 않는다 — 모듈 주석이 이미 인정한 사실).

**수정 — 전용 헬퍼를 새로 만든다. `_load_daily_rows` 자체는 건드리지 않는다**(다른 호출부는 `_latest_available_basis` 폴백 때문에 넓은 집합이 필요하다 — 시그니처를 바꾸면 조용히 깨진다):

```python
def _load_prev_closes(path, codes, basis) -> dict[str, float]:
    df = (pl.scan_parquet(path)
          .filter(pl.col("code").is_in(codes) & (pl.col("date") < basis) & (pl.col("close") > 0))
          .sort(["code","date"]).group_by("code").agg(pl.col("close").last()).collect())
    return dict(zip(df["code"].to_list(), df["close"].to_list(), strict=True))
```
`heatmap_group_flow.py:225-230` 의 6줄이 1줄이 된다.

**검증.** ① `close > 0` 필터 위치가 파이썬에서 SQL 술어로 옮겨가므로 종가 0/null 이 섞인 종목을 픽스처에 넣어 기존 `prev_close_of` 와 dict 완전 일치 대조(red-check). ② cProfile 에서 `_load_daily_rows` 프레임이 **아예 사라지는 것**이 성공 신호. ③ 루프 기아 카나리아: 수정 후 `grep 'path=/api/live/status' hoga.log` — 이 라우트는 원리적으로 2초를 넘을 일이 없으므로 한 줄이라도 남으면 기아가 남은 것.

**선행 작업.** `git log -S '_load_daily_rows'` → **2건뿐**(최초 작성 + #883 group-flow 재사용). 이 함수는 **한 번도 성능 관점으로 손댄 적이 없다**. 반면 같은 경로의 **JSONL 쪽은 두 번 최적화됐다**(2026-07-30 tail-append 증분화 243파일 947 MB, 11.67 s→2.52 s + `_CANDLE_HINT` 프리필터). 같은 주석이 30초 버스트 창을 늘리는 것을 명시적으로 기각하는데("신선도를 판다"), 이 수정은 **창을 늘리는 대신 compute 를 싸게 만드는** 방향이라 그 기각과 충돌하지 않는다.

### 3-2. 섹터 랭킹 당일 경로가 메모·디스크 캐시를 둘 다 우회한다 (C-3, **WEAKENED**) — S / 중간

> **⚠ 판정 정정 (2026-08-16, 문서 작성 후).** 이 항목은 최초 문서에서 "미검증" 으로 표기됐으나
> **검증자가 실제로 판정했고 결과는 WEAKENED 였다**(제목 표현이 달라 자동 병합에서 누락됐다).
> 축소 사유 둘: ① **노출 인구가 좁다** — `useIndexSectorRankings` 호출부는
> `live/workspace/SectorRankingWindow.tsx:41` 하나뿐이고, 그 창은 `state/workspace.ts:332-336`
> 의 `defaultWindows()` 에 **없으며** `WindowAddMenu.tsx:46` 이 `indexOnly: true` 로 표시하듯
> **지수 그룹 전용**이다. 즉 사용자가 지수 그룹에서 직접 추가한 세션에서만, 그것도 거래일에만 발생한다.
> ② **독립 항목이 아니다** — 3-1 과 **같은 함수·같은 수정**이라, 3-1 을 고치면 이쪽 비용도
> 473 ms → 35 ms 로 함께 떨어져 캐시 우회 자체가 무해해진다. **아래 캐시 축 분리는 3-1 을 하고도
> 남는 비용이 측정될 때만 착수한다.**

**증거.** `hoga/live/api.py:2339` — `date == today` 면 `intraday_prices` 는 **항상 dict** 다(오버레이가 빈 `{}` 를 줘도, 무자격이라 강등돼도). 그 결과 `hoga/live/index_sector_rankings.py:373`:

```python
use_cache = intraday_prices is None
```
가 세 지점을 전부 끈다 — `:380` 메모 읽기, `:391` 디스크 캐시 읽기, `:452` `if not use_cache: return response`(쓰기까지). 캐시 키(`:375-379`)는 `(data_dir, basis, heatmap fingerprint, corpus fingerprint)` 로 잘 설계돼 있는데 **가장 자주 보는 당일만** 통째로 비활성이다. 그래서 `:405` 의 `_load_daily_rows` 가 매 폴링마다 돈다(위에서 잰 473 ms).

프론트: `frontend/src/api/indexSectorRankings.ts:7,46` — `refetchInterval: isToday ? 60_000 : false`.

**증상.** slow-log 에 안 잡힌다(2000 ms 임계 미만) — 그래서 조용하다. group-flow 와 **주기가 같아 자주 겹치므로** 한 60초 창에 합쳐져 약 1초의 순수 파이썬 구간을 만든다. 사용자 체감은 "히트맵 화면이 유난히 무겁다" 이고 원인이 화면에 안 드러난다.

**캐시를 끈 이유 자체는 정당하다** — `intraday_prices` 는 매 폴링마다 다르므로 완성 응답을 캐시하면 시세가 얼어붙는다. 문제는 **비싼 부분(일봉 코퍼스)과 변하는 부분(장중 시세)이 같은 캐시 결정에 묶여 있다**는 것이다. 일봉은 하루 한 번(17:25) 바뀌고 키에 corpus fingerprint 가 이미 있다.

**수정 — 캐시 축을 응답 단위에서 daily_rows 단위로 내린다.** `use_cache` 는 그대로 두고(응답 캐시는 당일에 꺼진 게 맞다) `_load_daily_rows` 결과만 fingerprint 로 메모(슬롯 1개면 충분 — 당일 키 하나가 지배적이고 과거는 이미 응답 캐시가 잡는다). 락 밖에서 로드하고 락 안에서 교체.

**⚠ 반환값을 호출부가 변형하지 않는지 먼저 확인할 것** — 메모된 dict 를 공유하게 되므로 변형이 하나라도 있으면 캐시 오염이다. 확인이 안 되면 읽기 전용 계약을 테스트로 못박는다.

**검증.** ① 3회 연속 GET — 현재는 3회 모두 ~0.9~1.5 s, 수정 후 2·3회차 **<100 ms**. ② **정확성 red-check(핵심)**: 장중 2회 연속 호출에서 `sectors[*].stocks[*].close` 가 **실제로 갱신되는지**. 이 수정이 틀리는 방식은 "빨라졌는데 시세가 얼어붙었다" 이고 캐시 히트만 봐서는 안 드러난다. ③ parquet mtime 을 바꿔 메모가 버려지는지(가짜 fingerprint 로 실패 메시지를 본 뒤 되돌린다). ④ 히트맵 멤버 추가/삭제 시 `codes` 로 키가 갈리는지.

**선행 작업.** 관련 커밋·CHANGELOG·ADR **해당 없음**. 이 모듈은 2단 캐시가 fingerprint 키까지 갖춰 잘 설계돼 있고, `intraday_prices` 오버레이가 나중에 얹히며 한 줄로 꺼진 형태다 — **두 기능이 만난 지점의 사각**. 라우트 주석(`live/api.py:2345-2347`)이 `to_thread` 이유는 길게 적으면서 캐시가 꺼진다는 사실은 언급이 없는 것이 방증. (오버레이의 벤더 호출 축은 #1063·#1015·ADR-0138 이 이미 많이 다뤘으므로 **건드리지 않는다** — 이 발견은 로컬 parquet 축이다.)

### 3-3. `/api/live/quotes` 기준가 N+1 이 이벤트 루프 위에서 돈다 (C-4, **CONFIRMED**) — S / 중간

> **⚠ 판정 정정 + 영향 상향 (2026-08-16, 문서 작성 후).** 최초 문서의 "미검증" 은 자동 병합 누락이다.
> **검증자는 CONFIRMED 를 냈고, 체감 영향이 아래 서술보다 크다고 정정했다.**
>
> **빠진 콜드 계기 하나.** 캐시 키가 `(code, today.isoformat())` 이고 `today` 는 라우트
> `hoga/live/api.py:2452` 의 `datetime.now(_KST).date()` 다. 즉 **KST 날짜가 넘어갈 때마다 전 코드의
> 캐시가 무효화된다.** 콜드 폭발은 아래에 적힌 두 계기(재시작·17:25 코퍼스 갱신)가 아니라 **셋**이고,
> 추가되는 셋째가 **매 거래일 아침 첫 시세 폴링** — 하루 중 사용자가 화면을 가장 열심히 보는 순간이다.
>
> **재측정치.** 검증자 실측 30코드 합 **264.9 ms**(웜 버퍼 2회차 249.6 ms — 안 줄어든다), 같은 30코드
> 배치 1건 **13.8 ms**(약 19×). 296코드 환산 **약 2.0~2.5초의 이벤트 루프 정지**.
>
> **재현 시나리오 주의.** 재시작 직후 첫 폴이 `rest_bypass_enabled` 경로를 타면 `_last_quotes` 가 비어
> resolver 를 아예 안 부른다(빈 리스트 반환). 실제 폭발 시점은 "재시작 후 **첫 벤더 성공 응답**" 이다.
>
> **이 정정으로 순위가 8위 → 7위로 올라갔다.** 아침 첫 폴은 매 거래일 반복되고, 사용자에게는
> "장 시작할 때 앱이 순간 멎는다" 로 나타난다.

**증거.** `hoga/live/api.py:2447 _get_quotes`(async) → `:1148` → `_to_live_quote`(`:1049-1057`) → `quote_change_resolver.py:57` 이 **무조건** `_baseline_for` 를 부르고, 캐시 미스면 `:180-207` 이 133 MB parquet 에 코드마다 쿼리를 던진다. **전 경로가 async 인데 `to_thread` 가 한 군데도 없다.**

**실측(원 레인, 실데이터 종목 30개).** 첫 쿼리 11.6 ms, 이후 29건 p50 5.5 ms, **합계 159.0 ms**. 웜 버퍼 2회차도 **158.2 ms**(버퍼가 데워져도 안 줄어든다 — 파일 메타데이터 재파싱이 매번 붙는다). 배치 1건(`IN` + `max_by`, 30코드) = **24.5 ms**.

**증상.** 두 순간에만 터진다 — ① 백엔드 재시작 직후 첫 폴링, ② **매일 17:25 코퍼스 갱신 직후** 첫 폴링(캐시가 `_adjusted_daily_signature()` mtime/size 세대로 전량 폐기된다). 30종목 ~160 ms, 히트맵 규모 296종목이면 **~1.5초 동안 이벤트 루프가 멎는다**. 하루 2번뿐이라 재현이 어렵고 "가끔 앱이 순간 멎는다" 로만 보고된다. `wait_for(1.0)` 은 벤더 호출에만 걸려 있어 이걸 못 잡는다.

**수정 (a) 배치화 + (b) 루프에서 내리기, 둘을 같이.** `prime_baselines(codes, today)` 로 캐시에 없는 코드만 한 쿼리로 채우고(부재도 `None` 으로 캐시), `_get_quotes`/`_get_tab_metrics` 가 `code_list` 확정 직후 `await asyncio.to_thread(...)` 한 줄. `_load_baseline` 은 폴백으로 남긴다.

**⚠ `max_by` 의 tie-breaking 이 기존 `ORDER BY date DESC LIMIT 1` 과 다를 수 있다** — 배치 도입 전에 `SELECT code, date, count(*) ... HAVING count(*)>1 LIMIT 1` 로 (code,date) 중복 유무를 먼저 확인할 것.

**검증.** ① 종목 200개로 기존 vs 배치 전건 대조 — (a) 코퍼스에 없는 코드 → 양쪽 `None`, (b) `close<=0` 만 있는 코드, (c) `today=None` 분기. ② 재시작 직후 1회 GET 의 `duration_ms` 가 **두 번째 GET 과 차이 없어야** 한다(그게 "콜드 폭발이 사라졌다" 의 정의). ③ **(a)와 (b)를 구분하는 검사**: 296종목 요청을 던지는 동시에 `/api/live/status` 를 폴링 — 배치화만 하고 `to_thread` 를 빠뜨리면 이 검사만 실패한다.

**선행 작업.** 배치화·오프로딩 관련 **없음**. `:200-206` 주석이 N+1 을 **인지하면서도** "파일 세대당 종목 1회니 괜찮다" 고 판단한 근거다. 여기 더하는 사실 둘 — (a) "세대당 1회" 는 **종목당** 1회이고 296종목이면 1.5초, (b) 그 1.5초가 **루프 위**다. `connect_bounded` 는 2026-07-30 에 이미 최적화됐으므로(7.72 ms → 0.25 ms) 남은 5 ms 는 **쿼리 자체**다 — 배치화 말고는 줄일 방법이 없다.

---

## 트랙 4 — 계측 인프라 + 번들 위생 (항목 10, 11 + 프로브 3종)

**묶음의 논리:** 이 트랙은 **바이트를 줄이지 않는다.** 초기 로드 1071→1230 회귀가 아무에게도 안 알려진 것, 이 감사가 @dnd-kit 을 4배 과대평가한 것, slow-log 가 다중 프로세스 오염을 못 드러낸 것 — 셋 다 같은 결함이다. **다음 회귀를 자동으로 잡는 장치를 넣는다.**

**예상 효과:** 바이트는 항목 11 의 **−33.2 KB raw / −9 KB gzip 뿐**(항목 10 은 **+22 KB raw**로 오히려 는다). 실효는 회귀 탐지. **총 M 규모.**

### 4-1. `manualChunks` 무력화 — 청크 이름이 내용과 다르다 (D-1, WEAKENED) — S / 낮음

**증거.** `frontend/vite.config.ts:59-72` 의 `manualChunks` 가 Vite 8(rolldown)에서 사실상 동작하지 않는다. `dist/assets/react-CzuDPti3.js` = **184 B**, 본문은 `import{g as t}from"./dnd-CwEjQzg5.js"` 한 줄. 소스맵 VLQ 를 디코드한 `dnd-CwEjQzg5.js`(186,140 B) 귀속(원 레인·검증자 **바이트 단위 일치**):

| 소스 | 바이트 |
|---|---:|
| react-dom | 128,929 |
| @dnd-kit/core | 38,120 |
| react | 6,455 |
| @dnd-kit/sortable | 5,312 |
| scheduler | 3,828 |
| @dnd-kit/utilities | 2,931 |
| @dnd-kit/accessibility | 540 |
| **= react 계열 139,212 (74.8%) / @dnd-kit 46,903 (25.2%)** | |

기전은 `node_modules/rolldown/dist/shared/rolldown-build-CrPk_lZe.mjs` 가 `manualChunks` 를 **단 하나의** `advancedChunks` 그룹으로 감싸는 것 — 하나의 그룹 안에서 동적 name 으로 쪼개는 경로가 rollup 의 모듈별 배정을 재현하지 못한다.

**⚠ 주장된 피해가 반증됐다.** "앱 한 줄 고치면 React 139 KB 재다운로드" 는 **일어나지 않는다** — 소스 트리를 복제해 `App.tsx` 의 emit 되는 문자열 하나를 바꿔 재빌드하니 `dnd`·`charts`·`live-workspace`·`react`·`query` **전부 동일 해시**였다(dnd 는 100% 벤더라 앱 코드에 불변). 캐시 손실은 **방향이 반대로 존재한다**: `react-router` 40,921 B 와 `@tanstack/query-core` 26,369 B 가 **`live-workspace`(697 KB, 앱 코드 전체) 안에 있어서**, `src/live/*` 를 한 줄만 고쳐도 이 67 KB 가 매번 딸려 나간다.

**수정.** `codeSplitting.groups`(비-deprecated 이름 — `advancedChunks` 는 경고를 찍는다). 경로 구분자는 `[\\/]`:

```ts
rollupOptions: { output: { codeSplitting: { groups: [
  { name:'react',  test:/node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority:40 },
  { name:'router', test:/node_modules[\\/]react-router[\\/]/,               priority:39 },
  { name:'query',  test:/node_modules[\\/]@tanstack[\\/]/,                   priority:38 },
  { name:'charts', test:/node_modules[\\/](lightweight-charts|fancy-canvas)[\\/]/, priority:37 },
  { name:'dnd',    test:/node_modules[\\/]@dnd-kit[\\/]/,                    priority:36 },
  { name:'live-workspace', test:/[\\/]src[\\/](live|chart|sidebar)[\\/]/,     priority:10 },
] } } }
```

**프로브 빌드 실측:** `react` 139.93 / `dnd` 46.82 / `router` 42.20 / `query` 58.29 / `charts` 170.78 / `live-workspace` 624.88 / `index` 101.14 kB. **초기 로드 합계 1229.5 → 1251.5 KB raw (+22.0), 366.0 → 373.1 KB gzip (+7.2)** — 파일이 7→9개로 늘며 청크 경계 보일러플레이트가 붙는다. **이 수정이 바이트를 줄이지 않는다는 사실을 주석에 반드시 남길 것** — 안 그러면 다음 감사가 또 같은 착각을 한다.

**판별식은 크기가 아니라 소속.** 빌드 후 `dist/assets/*.js.map` 의 `sources` 를 읽어 `react-dom/cjs/react-dom.production.min.js` 가 `react-*.js` 안에 있는지 단언하는 스모크를 추가한다(현재 `npx vite build` 는 **아무 경고도 안 낸다**).

**선행 작업.** `git log -S'manualChunks' -- vite.config.ts` → `cc016c72`(2026-06-28) **1건**. `git log -p -- package.json | grep '"vite"'` → `"vite": "^8.0.12"` 가 **2026-05-20 스캐폴드부터** 그대로 — 즉 업그레이드로 깨진 게 아니라 **한 번도 동작한 적이 없다**. 2026-06-28 분할도 2026-07-30 −18% 실측도 전부 이 상태에서 측정됐다.

### 4-2. `/live` 내부에 lazy 경계가 0개 (D-2, WEAKENED) — M / 낮음

**증거.** `grep -rn 'lazy(' frontend/src/live/ frontend/src/chart/ frontend/src/workspace/` → **0건**. 반면 `frontend/src/App.tsx:29-45` 주석이 규율을 확립해 뒀다("드로어·설정 모달은 **조건부 마운트**라 lazy 로 내린다 … 실측 2026-07-30: heatmap 213KB + study-views 72KB")이고 `src/routeSplitting.test.ts` 가 소스 수준에서 못박고 있다. 그런데 `frontend/src/live/LivePage.tsx:18-21` 은 `WorkspaceIndicatorDrawer` 를 **정적 import** 하고 `:207` 에서 `{indicatorTargetId != null && <WorkspaceIndicatorDrawer …/>}` 로 조건부 렌더한다 — App.tsx 가 금지한 바로 그 조합이다.

**⚠ 예산 정정.** lazy 가능한 것은 **`IndicatorPanel.tsx` 9,266 B + `*Config.tsx` 16개 = 33,232 B 하나뿐**이다. 원 레인이 합산한 `chart/drawing/` 30,565 B 와 `DrawingPropertyPanel.tsx` 6,481 B 는 **조건부 마운트가 아니다** — `LiveChartRoot.tsx:2285` 의 `<DrawingOverlay>` 와 `:2325` 는 아무 조건 없이 렌더된다(선택 없으면 내부에서 null 반환). 따라서 "eager src 682 KB 중 5%" 가 아니라 **33.2 KB raw / ~9 KB gzip (초기 로드의 2.6%)**.

**착수 걸림돌(원 레인이 안 적은 것).** `LivePage.tsx:18-21` 이 같은 모듈에서 `targetChartWindow` 를 **함께 import** 하므로, 드로어만 `lazy()` 로 감싸도 그 named export 때문에 모듈이 eager 그래프에 남는다 → **export 를 별도 파일로 옮기는 선행 리팩터가 필요**하다.

**하지 말 것.** `live/indicators/` 전체를 lazy 로 옮기면 안 된다 — `flagLegendValueRegistry`·`indicatorPaneProfiles`·`MovingAverageOverlay`·`maSeriesRegistry` 는 차트 렌더 경로가 직접 쓴다(`LiveChartRoot.tsx:19,28,71-72`, `workspace/ChartWindow.tsx:64-66`). 경계는 `IndicatorPanel` 과 그 `*Config` 자손뿐.

**검증.** 합계만 보면 청크 경계 오버헤드에 묻힌다(4-1 프로브가 그 함정을 보여줬다). **더 강한 판별식**: 새 eager 청크들의 `.js.map` `sources` 에 `src/live/indicators/IndicatorPanel.tsx` 가 **없음**을 단언. 드로어를 실제로 열어 한 프레임 빈 화면이 안 보이는지 `/browse` 로 확인(App.tsx 가 `fallback={null}` 을 정당화한 조건과 동일).

**부수 효과.** `live-workspace` 가 `chunkSizeWarningLimit: 700` 에 3 KB 남았다. **임계를 올리는 것은 이 저장소가 명시적으로 거부한 선택**이므로("이 경고를 끄는 게 아니라 … 여기서 더 커지면 다시 알려 주도록 남긴다") 이 수정으로 내린다.

### 4-3. 회귀를 잡는 장치 6종

현재 성능 회귀를 잡는 자동 장치는 `vite.config.ts` 의 `chunkSizeWarningLimit` **하나뿐**이고, 그건 개별 청크만 본다. 초기 로드가 조용히 늘고 청크 이름이 거짓이 되고 slow-log 가 오염돼도 아무도 모른다.

| # | 장치 | 잡는 회귀 | 규모 |
|---|---|---|---|
| a | **초기 로드 합계 테스트** — `dist/index.html` 의 entry+modulepreload+**stylesheet** raw/gzip 합계를 상한과 대조. **지표 정의를 JS+CSS 로 명시**하고 vite.config 주석의 기준선을 재현 가능한 형태(측정 스크립트 동봉)로 교체 | §0.2 의 지표 혼용 재발, 조용한 번들 증가 | S |
| b | **소스맵 소속 단언** — `dist/assets/*.js.map` 의 `sources` 에서 `react-dom` 이 `react-*.js` 안에 있는지 | 청크 배정이 조용히 무력화되는 것(4-1) | S |
| c | **축출 호출 수 red 테스트** — `useDayPeaks.perf.test.tsx` + `tradeVolumePoc.test.ts` 에 **선두 절단** 케이스. 지금 반드시 빨개야 한다 | 1-3 의 재발. 기존 테스트가 이 축을 원리적으로 못 본다 | S |
| d | **렌더 카운트 테스트** — 코어의 `windowItem` 주입 슬롯에 카운터 더미를 넣어 "드래그에 참여하지 않은 창의 렌더 증가 = 0" | 2-1 의 재발. 이 성질은 주석에만 있고 한 번도 검증된 적이 없다 | S |
| e | **`loop_lag` 프로브** — `startup_runtime.py` 의 supervised task 로 0.5초 sleep 의 초과 지연을 `hoga_perf loop_lag` 로 warn. `grep 'hoga_perf loop_lag' \| sort` 로 상위 지연을 뽑고 같은 타임스탬프의 `http_request` 줄과 대조 | 이벤트 루프 기아를 **사후 co-timing 추론이 아니라 신호로**. 현재 `grep 'loop_lag' hoga/` → 0건 | S |
| f | **`RequestTimingMiddleware` 로그에 PID·포트 추가** | C-1 검증자가 발견한 **다중 프로세스 오염** — 여러 백엔드가 같은 파일에 append 해서 p50 3.85 s 같은 수치가 "다중 백엔드 경합의 산물" 인지 구별이 안 된다. 이것 자체가 계측 인프라 결함 | S |

특히 **(f)** 가 없으면 앞으로도 slow-log 기반 판단이 전부 오염된다 — 병행 세션이 6개까지 늘어나는 이 저장소의 작업 방식에서는 구조적 문제다.

---

## 2. WEAKENED — 진짜지만 영향이 작다

착수 근거로 삼기 전에 이 절의 축소 사유를 먼저 볼 것.

| 항목 | 레인 | 확인된 것 | 축소 사유 |
|---|---|---|---|
| **`IncrementalTradeVolumePoc` 축출** | A-3 · B-2 | 결함 확정(축출 시 `fullRebuilds` 25/25) | **0.07~0.80 ms/flush** — 피크벽의 100~400배 작다. 트랙 1-3 의 rider 로만. 다만 **토글과 무관하게 돈다**(`useLiveChartData.ts:202` 무조건 + `rangeCount` 기본 10) → 그 축은 항목 1 이 덮는다 |
| **창별 `LiveSnapshotBuffer`·타이머** | A-5 · E-3 | 구조 확정 — `api/liveSeries.ts:149` 훅마다 새 버퍼, 호출부 6곳(`useLiveChartData.ts:101`, `DataWindow.tsx:173·423·492·532·677`), `:60-64` 주석은 단일 차트 시절 것 | ① 원 레인의 "타이머가 서로 다른 시각에 만료돼 배칭 실패" 가 **틀렸다** — `api/ws.ts:64` 가 한 디스패치에서 전 핸들러를 부르므로 동시 무장·동시 만료다. ② 각 `setTick` 은 그 창 서브트리만 그리므로 총 렌더 작업이 곱해지지 않는다. ③ 진짜 곱셈 비용은 창별 `Object.freeze([...arr])` + venue 필터뿐이고 **미측정**. ④ 나머지는 트랙 1-3 에서 이미 센 항 → **독립 수정이 아니라 트랙 1 의 배수 계수**로 읽을 것. **더 싼 지렛대가 이미 설계돼 있다**: ADR-0119 `:357` 의 **E2a(비포커스 창 flushMs 차등)** 가 명시적 보류 상태 |
| **`useGroupCursor` 오프-그룹 리렌더** | B-4 | `DataWindow.tsx:145-153` 이 커서 스토어를 원시 구독하고 **렌더 이후에** 그룹 판정 → `Object.is` bail-out 불가 | ① 장중엔 `useLiveSeries` 6.67 Hz 기저에 대부분 흡수. ② **단일 그룹 워크스페이스는 비용 0**. ③ 발행 측이 이미 세 겹으로 조인다(`alignSidebarCursorMs` 버킷 정렬 + 동일값 억제 + 120 ms leading/trailing) — 8.3/s 는 **능동 스윕 중 상한**. 유효 범위는 "장 마감 후·저유동·멀티그룹 + 스윕 중". **수정은 셀렉터 한 줄**이라 비용 대비 위험은 거의 없다 |
| **`range-merged` identity 고아** | E-2 | `main.tsx:79` gcTime 2h, `api/range.ts:750` 옵저버 없는 `setQueryData`, `useLiveRangeCacheEviction.ts:88-95` 술어가 **종목 축만** — 전부 확인. 크기 재현(sidecar 1m 7일 = **2,423,322 B** 바이트 일치; 2개월 = 23,649,416 B) | 원 레인의 대표 시나리오(봉 전환)가 **가장 약한 사례**다 — `state/workspace.ts:680-703` 이 봉 전환 시 `historicalFromDate: null` 로 **팬 위치를 리셋**한다. **진짜 사례는 지표 토글**(`resetChartHistoricalRange` 호출부는 `windowView.ts:386` 하나뿐이라 토글은 팬 폭을 그대로 유지 → 2개월 상태에서 토글 몇 번이면 23 MB 급 고아 여러 벌). gcTime 2h 는 **의도된 설계**(`main.tsx:71-78` 의 "점심 후 복귀" 근거) → 처방은 gcTime 축소가 아니라 **identity 축 LRU 캡** |
| **`/api/live/status` 페이로드** | D-5 | 11,461 B raw / 2,622 gzip / 3.5 ms, 프론트 타입에 없는 필드 **3,896 B**, `live_set` 과 `kiwoom.subscribed_codes` 는 297건 완전 동일 | ① **탭 게이팅이 이미 있다** — `main.tsx` 의 `refetchOnWindowFocus:false` + RQ 기본 `refetchIntervalInBackground:false` → "모든 탭 24시간" 은 거짓, 포커스된 창 1개뿐(**~31 KB/분**). ② 5초는 문서화된 설계(`:114-118`). ③ **중복 목록 dedup 은 자명하지 않다** — 두 집합은 개념이 다르고(폴러 순회 vs WS 구독) `live/collectionStatus.ts` 가 후자의 멤버십으로 실시간 도트를 판정한다. 남는 유일한 축은 진단 필드 3.9 KB 를 `?verbose=1` 뒤로 — 이건 성능이 아니라 **wire 계약 위생** |
| **초기 로드 회귀 분해** | D-3 | 구성 요소 전부 바이트 단위 재현 | §0.2 대로 분모가 틀렸다. 되돌릴 것 없음 → 산출물은 **지표 정의 통일**(트랙 4-3a) |
| **`manualChunks` 무력화** | D-1 | §4-1 | 바이트 **+22 KB**. 값어치는 계측 정직성뿐 |
| **`/live` lazy 경계 0** | D-2 | §4-2 | 예산이 30~60 KB 가 아니라 **33.2 KB** |

---

## 3. 검토했으나 문제 아님 — 다시 의심하지 말 것

각 줄에 **판별식**을 남긴다.

| 의심 | 왜 문제가 아닌가 | 판별식 |
|---|---|---|
| **응답 직렬화가 느리다 (orjson 필요)** | 실서버 4.4 MB `/api/range` 로 실측: `serialize_response` **16.1 ms** + `json.dumps` **21.5 ms** = **38 ms**. pydantic v2 Rust serializer + C `json` 은 MB 급에서도 싸다 | MB 급 응답의 두 단계를 직접 재라. `git log -S 'ORJSONResponse'` → 0건 = 한 번도 손댄 적 없는 영역이고 **손댈 필요도 없다** |
| **lwc 호출이 틱마다 `setData(전체)`** | `RangeSeriesPane` 이 `syncSeriesData`(tail-diff)로 `update(tail)` 하고, `pastCachedProjector` 가 WeakMap 캐시, `chartBundle`/`bundle` 분리로 캔들 pane 은 틱마다 안 돈다. MA·WallSurge 오버레이도 전부 `chartBundle` 시딩 | 렌더 경로가 아니라 **훅 층의 파생 계산**을 보라 |
| **히트맵 235행 팬아웃** | in-repo 실측으로 이미 승인됨 — 387 프레임/s, long task 0, 60 fps | — |
| **`React.memo` 가 5개뿐** | 실제 25개+ 이고 핫패스(WorkspaceCanvas 창 항목·WindowFrame·오버레이 13종·PaneLegendOverlay)는 근거 주석과 함께 이미 펜스돼 있다 | 단, `rect` prop 한 개가 그걸 뚫는다 → **트랙 2-1** |
| **`SortableQuoteRow` memo 계약** | 스칼라 props 만 받는다 — 정상 | — |
| **`resolveIndicatorSettings` / `DepthHeatmapOverlay` halfTick** | 각각 WeakMap 캐시·증분 정상 | — |
| **`windowViewContext` value** | useMemo 정상 | — |
| **persist / 크로스헤어 / `mergeDepthDeltaSession`** | 250 ms 디바운스 + `lastWritten` 중복 차단 / rAF 병합 + leading·trailing 스로틀 + 소유자 가드 + 리프 격리 구독 / 분당 point 1개 — 전부 깨끗 | #918 이 리스너·rAF·타이머 짝을 **전수 대조**해 "누수가 아니라 축출 정책 부재" 로 결론냈다. **일반적 누수 사냥은 이 리포에선 끝난 이야기다** |
| **휠·팬 백필·관심종목 낙관적 업데이트·드로어 fallback** | deltaMode 정규화·앵커 불변식 / 150 ms 트레일링 디바운스 + fill 재확인 / 전부 주석·ADR·실측으로 방어 | — |
| **폰트 서브셋이 FOIT 를 만든다** | `@font-face` 92블록 **전부** `unicode-range` 보유, **전부** `font-display: swap`(다른 값 0건). woff2 2.96 MB 이지만 unicode-range 로 필요한 것만 받는다 | CSS 의 `@font-face` 블록 수 대비 `unicode-range`/`font-display` 보유율 |
| **Tailwind purge 가 안 된다** | `tailwind.config.ts:32 content: ['./index.html','./src/**/*.{ts,tsx}']`. 폰트 뺀 앱 CSS 48,580 B raw / 10,483 B gzip, 규칙 ~835개 — 대형 SPA 기준 정상 | "96 KB CSS" 의 **절반은 폰트 선언**이다 |
| **GZip 이 안 걸린다** | `app.py:388 GZipMiddleware(minimum_size=1024)` 정상 — `/api/symbols/all` 926,391 → **57,578 B**. `/api/live/indices` 388 B 는 임계 미만이라 비압축(의도대로) | `curl -H 'Accept-Encoding: gzip'` 유무 차 |
| **정적 캐시가 약하다** | `hoga/api/frontend_static.py` 가 `assets/` 접두에 `public, max-age=31536000, immutable`, 그 외 `no-cache`(옛 index.html → 404 흰 화면 방지) — 이미 최적 | — |
| **API 응답에 ETag/Cache-Control 을 붙이자** | **검토 후 기각.** prod 는 tailnet 5명(ADR-0134: "정적 서버 추가는 기각 — 5명 규모에서 성능 근거 없음"). 최대 후보 `/api/symbols/all` 은 TTFB 9.7 ms + 브라우저 `JSON.parse` **1.8 ms**(879,207자) — 절감할 게 없고, 불변 캐시는 알려진 실패 유형(재캡처 후 지표 캐시 stale)과 정면 충돌 | — |
| **react-router 가 prod 에 development 빌드로 들어온다** | 사실이다(`exports` 에 production 조건이 없어 번들러가 dev 빌드밖에 못 고른다). 그러나 **비용이 1.30 KB raw / 0.47 KB gzip** — `resolve.alias` 로 prod 를 고정해 재빌드하니 `live-workspace` 696.98 → 695.68 kB. 취약한 우회를 도입할 근거가 못 된다 | **⚠ 판별식 정정.** 원 레인이 남긴 "`exports` 에 production 조건이 없으면 단일 빌드다" 는 **틀린 일반화**다 — 실제로는 두 빌드가 `ENABLE_DEV_WARNINGS` 한 줄로 다르고, dev 경고 문자열이 prod 번들에 실제로 실려 있다(`Matched leaf route at location`). **올바른 판별식은 번들 산출물에서 dev 전용 문자열을 grep 하는 것** |
| **`@dnd-kit` 186 KB 를 lazy 로 내리자** | 실제 **46,903 B**(파일명이 거짓이었다). 게다가 `App.tsx:44-45` 가 `WatchlistDrawer` 정적 유지를 **명시 결정**해 뒀고(기본 활성 패널 — lazy 면 첫 페인트에 왕복 추가), `rightrail/QuoteRow.tsx` 는 레일 핵심 행이라 대상 아님 → **사실상 손댈 수 없다** | 파일 크기를 패키지 크기로 읽지 말 것. 소스맵 `sources` 로 귀속시켜라 |
| **REST/WS 폴링이 중복된다 (`restBypassMode`)** | 중복 없음. `state/restBypassMode.ts` 는 REST **실패 토스트**와 "저장 데이터 우회" 스위치를 다루는 파일이고 폴링과 무관하다. 문서화된 설계대로 WS 가 시세, REST 가 상태·과거를 담당 | — |
| **라우트에서 무거운 동기 호출을 직접 부른다** | AST 호출그래프로 전 async 라우트를 훑은 결과 `to_thread` 규율(88곳)이 잘 지켜져 있다 | **진짜 병목은 `to_thread` 안쪽의 순수 파이썬 행 물질화** → 트랙 3 |
| **`RANGE_*_CONCURRENCY` 를 1로 내리자** | `routes.py:749` 주석의 실측표가 이미 기각 — 큐 대기가 늘어 중앙값이 나빠진다 | — |
| **`--workers` 를 붙이자** | ADR/#998 로 금지 — 프로세스 내 싱글턴(키움 WS·스케줄러·DuckDB) 구조라 워커마다 WS 킥 전쟁·스케줄러 N중 실행 | — |
| **30초 버스트 창을 늘리자** | `heatmap_group_flow.py` 모듈 주석이 명시적으로 기각("신선도를 판다" — 마지막 버킷이 carry-forward 로 실시간에 가깝다) | 트랙 3-1 은 창을 늘리는 게 아니라 **compute 를 싸게** 만들므로 이 기각과 충돌하지 않는다 |

---

## 4. 방법론 각주 — 이 문서의 수치를 어떻게 읽을 것인가

1. **워크트리 코드는 :5173 에 서빙되지 않는다.** 브라우저로 관찰한 것은 전부 **메인 체크아웃의 동작**이다. 따라서 여기 적힌 프론트 수정의 효과는 어느 것도 브라우저로 확인되지 않았고, 프론트 판별식을 전부 **결정론적 유닛(호출 수·렌더 수·소스맵 소속)** 으로 설계한 이유가 이것이다.
2. **오늘(2026-08-16)은 토요일이고 dev·워크트리 백엔드는 무자격이다.** `GET /api/live/status` 의 `live_buffer.published_total` 이 0 이었다. 따라서 **장중 유량(ob/s)은 이 감사에서 한 번도 측정되지 않았다** — 트랙 1-3 의 12~310 ms 범위가 어디에 떨어지는지는 미확정이고, 착수 전 1회 계측이 선행 조건이다. 리포 자신의 메모리도 "키움 WS 틱 주기 미실측" 을 남겨 두었다.
3. **slow-log 집계는 다중 프로세스 오염이 있다.** `~/.local/share/hoga-ops/logs/hoga.log` 는 PID·포트를 줄에 안 남기고 여러 백엔드가 같은 파일에 append 한다. 원 레인이 인용한 p50/max 는 **병행 워크트리 세션들이 경합한 값**일 수 있다 — 단일 서버 실측(C-1: 630 ms)과 6배 차이가 난다. 그래서 트랙 4-3(f)를 제안한다.
4. **~~C-3·C-4 는 적대적 검증을 거치지 않았다~~ — 이 서술은 틀렸고 정정됐다.** 레인 C 의 발견 4건은 **전부 검증됐다**(C-1 CONFIRMED · C-2 WEAKENED · C-3 WEAKENED · C-4 CONFIRMED). 최초 문서가 3건을 "미검증" 으로 적은 것은 검증자가 제목을 다르게 표현해 **자동 병합(제목 정확 일치)이 판정을 못 붙인 것**이지, 검증이 없었던 게 아니다. §3-2·§3-3 의 인용 블록에 각 판정과 정정된 영향을 반영했다. **이 사고 자체가 트랙 4-3 의 논지를 뒷받침한다** — 계측·병합 장치가 조용히 실패하면 산출물이 자신의 근거를 잘못 보고한다.
5. **벤치는 원본 소스를 verbatim 복사해 node 로 구동했다**(스텁은 술어 2개만). 축출 벤치는 두 레인이 독립적으로 만들어 같은 자릿수를 얻었다 — A: 8/14.8/39/87-100/210-268 ms, 검증자: 12.5/18.9/54.4/124.8/309.8 ms.
6. **이 문서에서 "검증됨" 은 적대적 검증자가 코드를 다시 열고 수치를 다시 잰 것을 뜻한다.** 검증에서 원 레인과 갈린 곳은 전부 **검증자의 정정값**을 채택했다.