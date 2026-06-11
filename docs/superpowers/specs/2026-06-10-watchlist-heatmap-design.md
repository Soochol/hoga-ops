# 관심종목 히트맵 페이지 (관심맵) — 설계

> **⚠️ 부분 SUPERSEDED (2026-06-11, ADR-0068):** 이 스펙의 **데이터 소스 결정**("백엔드 무변경", `useWatchlist` 재사용, 히트맵 = 한 Watchlist 의 뷰)은 **`2026-06-11-heatmap-watchlist-separation.md` + ADR-0068 로 반전**되었다 — 히트맵은 이제 watchlist 와 독립된 자체 스토어(`heatmap.json`/`/api/heatmap`/`['heatmap']`)다. 아래 **렌더링 설계**(레이아웃 §2, 히트 색 §6, 정렬 토글 §7, 헤더 §8, 테스트 전략 §11)는 **그대로 유효**하다.

- **Date**: 2026-06-10
- **Status**: Designed — 시각 목업 + 결정 확정 + **plan-eng-review 7개 질문 반영(§14)**. 사장님 최종 검토 대기.
- **Topic slug**: `watchlist-heatmap`
- **Branch**: `watchlist-heatmap-design` (worktree)
- **Scope (코드)**: 신규 `frontend/src/pages/Heatmap.tsx` + `frontend/src/heatmap/*` + `frontend/src/state/heatmapPrefs.ts`. 변경: `frontend/src/main.tsx`(라우트 1줄), `frontend/src/nav/LeftNav.tsx`(NavItem 1줄). **백엔드 무변경.**
- **Scope (데이터, 별도 후속)**: 섹터·주도주 대폭 확장 큐레이션 — §12. 이 스펙의 코드 산출물과 **분리**(페이지는 현재 관심종목 120종목으로 즉시 동작).
- **재사용**: `useWatchlist`/`groupByFolder`(watchlist), `useQuoteByCode`(api/liveQuotes), `useJumpToLive`(live), `priceDirClass`(ui/priceDir), `GroupNameModal`·`SymbolSearch`·`useAddToWatchlist`·`moveEntries`(watchlist/capture/api).
- **관련 ADR**: 0052(activeCode SSOT·jump-to-live), 0056(KIS live quote 오버레이), 0004(미분류는 render-only 그룹), 0065(watchlist json v2).
- **승인된 목업**: `.superpowers/brainstorm/*/content/full-board.html` (이 worktree)

---

## 1. 개요 & 핵심 차별점

관심종목 **드로어**(`WatchlistDrawer`, 우측 레일·ADR-0052)는 한 번에 **한 폴더**만 본다. 이 페이지의 존재 이유는 **25개 섹터 폴더 120종목을 한 화면에 동시에** 펼쳐 시장 온도를 한눈에 스캔하는 것 — "또 하나의 드로어"가 아니라 독립 모니터링 보드다. 참고 HTS(영웅문) 관심종목 화면을 한 페이지로 옮긴 형태.

핵심 분리 원칙:
- **페이지 = 코드.** `Heatmap.tsx`는 `useWatchlist()`가 주는 걸 그릴 뿐, 종목 구축 완료에 의존하지 않는다 → 지금 바로 출시 가능.
- **종목 구축 = 데이터.** 큐레이션은 API 경유 별도 작업(§12).

## 2. 레이아웃 결정 (목업 B + 하이브리드 히트)

| 결정 | 값 | 근거 |
|---|---|---|
| 레이아웃 | 멀티그룹 그리드 (섹터 폴더 = 블록, 신문형 칼럼 패킹) | 참고 이미지가 최강 신호. 데이터 모델(폴더=섹터, 단일 레벨)과 1:1 |
| 히트 색칠 | 하이브리드 — 은은한 배경 틴트 + 색 숫자 | 색 면적으로 온도 + 숫자 색으로 정확도(색약 이중표현) |
| 정렬 | 토글: 수동(`entry.order`, **기본**) ↔ 등락률↓(옵트인) | eng-review D2: 안정 보드·큐레이션 순서가 기본, 무버 헌팅은 옵트인(그 모드만 라이브 재정렬 churn 허용) |
| 행 내용 | 종목명 · 현재가 · 대비(등락액) · 등락률 | 참고 이미지 그대로, 정보 완전성 |
| 헤더 | 최소 — 제목 · phase 배지 · 갱신 시각 · 종목 수 · 정렬 토글 · 색 범례 | 화면을 종목에 최대 양보 |
| 클릭 | 행 클릭 → `useJumpToLive(code)` → /live | 관심종목·스크리너 패널과 동일 동작 |

**데이터 모델 불변**: "그룹 추가" = `createFolder`. 폴더=섹터 단일 레벨 유지, 관심그룹-of-폴더 계층 신설 **없음**.

## 3. 라우팅 & 진입점

- `main.tsx` `<Routes>`에 `<Route path="heatmap" element={<Heatmap />} />` 추가.
- `LeftNav` Workspace 섹션에 `<NavItem to="/heatmap" label="Heatmap" />` 추가(Live 다음).

## 4. 데이터 흐름 (전부 기존 훅)

```
useWatchlist()  →  { folders, entries }  →  groupByFolder()  →  FolderGroup[]
       │
       └─ allCodes = entries.map(e => e.code)   // ~120
                         │
              useQuoteByCode(allCodes)  →  Map<code, LiveQuote{price, change_pct, change_won}>  + phase
```

- `useQuoteByCode`는 10초 폴링. 백엔드 `/api/live/quotes`가 30개씩 청크 동시호출(15/s 버킷 캡)이라 **한 폴로 120종목 전체 커버**. `closed`면 600초 하트비트 + 마지막 시세 서빙(ADR-0056).
- `/heatmap`과 `/live`는 별도 라우트 → 동시 마운트 없음 → 이중 폴링 없음.
- 빈 폴더·미분류(`folder===null`)는 보드에서 **제외**(렌더 노이즈 방지).

## 5. 컴포넌트 구조 (작고 단일 책임)

| 파일 | 책임 | 의존 |
|---|---|---|
| `pages/Heatmap.tsx` | 셸: 헤더(§8) + 배너(§8 Q4) + `HeatmapBoard`. `useWatchlist`+`useQuotes`+`useLiveStatus` 조회, 로딩/에러/빈 상태 | useWatchlist, useQuotes, useLiveStatus, deriveBannerState/LiveStateBanner, heatmapPrefs |
| `heatmap/HeatmapBoard.tsx` | 신문형 패킹. **바깥 div = 세로 스크롤(높이 한정), 안쪽 div = CSS multi-column(`column-width`, height auto)** — 분리 필수(eng-review Q6: 같은 요소 overflow+column-width는 가로 오버플로/단일칼럼으로 깨짐). `break-inside:avoid`, **레이아웃 JS 없음** | HeatmapFolder |
| `heatmap/HeatmapFolder.tsx` | 폴더 블록: 헤더(폴더명 + 평균 등락률 + `＋종목`) + 정렬된 행들 | HeatmapRow, useAddToFolder |

> **평균 등락률** = 그 폴더에서 시세가 도착한(`change_pct !== null`) 종목들의 **단순 평균**(비가중). 시세가 하나도 없으면 숨김. 섹터 온도 요약일 뿐 지수 가중치 아님.
| `heatmap/HeatmapRow.tsx` | 칼럼형 행(종목명│현재가│대비│등락률), 배경=`heatBg`, 클릭→`useJumpToLive` | heat, priceDir, useJumpToLive |
| `heatmap/heat.ts` | 순수: `heatBg(pct)` + 정렬 비교자(`byChangeDesc`, `byManualOrder`) | — |
| `heatmap/useAddToFolder.ts` | 인라인 추가 훅: `addToWatchlist(code)` → `moveEntries([code], folderId)` 체이닝(§9) | useWatchlist, api/watchlist |
| `state/heatmapPrefs.ts` | 정렬 토글 상태 + localStorage 영속(`sourcePreference.ts` 패턴) | zustand/persist |

## 6. 히트 색상 로직 (`heat.ts`)

```ts
// 순수 함수. ±SAT%에서 포화(상·하한가 = 최대 농도). null/0 → 투명(카드 배경 노출).
const SAT = 8;          // 포화 임계(%)
const MAX_A = 0.42;     // 하이브리드 최대 알파(텍스트 가독 한계)
export function heatBg(pct: number | null): string {
  if (pct === null || pct === 0) return 'transparent';
  const a = Math.min(Math.abs(pct) / SAT, 1) * MAX_A;
  const rgb = pct > 0 ? '220,38,38' : '37,99,235';   // --price-up / --price-down
  return `rgba(${rgb},${a.toFixed(3)})`;
}
```

- 숫자 색은 `priceDirClass()` 재사용 → 색(배경) + 색(숫자) + 부호 **삼중** 표현(색약 보조).
- `SAT`/`MAX_A`는 상수로 노출 → 추후 농도 튜닝 한 곳.

## 7. 정렬 토글 (`heatmapPrefs.ts`)

- 두 모드: `'manual'`(`entry.order` 오름차순, **기본**) / `'change'`(등락률 내림차순, 옵트인).
- **기본 manual** (eng-review D2): 로드 시 안정 보드 + 사용자 큐레이션(주도주 우선) 순서 유지. 120행 보드에서 10초 폴링마다 행이 재배치되는 churn(클릭 목표 흔들림)을 기본에서 회피. `change`로 토글하면 무버가 위로 올라오는 라이브 랭킹(매 폴링 재정렬)을 옵트인 — 사용자가 움직임을 감수하고 선택. 색·숫자는 두 모드 모두 10초 라이브.
- `change` 모드에서 등락률 `null`(장전·결측)은 **항상 맨 아래**(NaN 정렬 오염 방지).
- 헤더 세그먼트 버튼 `[등락률 ↓ | 수동]`, 선택은 localStorage 영속.
- 비교자는 `heat.ts` 순수 함수 → 단위테스트 용이.

## 8. 헤더 · phase · 결측 처리

헤더(최소): `관심맵` 제목 · phase 배지 · `HH:MM:SS 갱신` · `N종목` · 정렬 토글 · 색 범례 바(−8%↔+8%).

| phase | 배지 | 동작 |
|---|---|---|
| `pre_open` | 장전 | 등락률·대비 `null` → 히트 없음, 현재가만, 등락 `—` |
| `open` | ● 장중 | 정상 히트(10초 갱신) |
| `closed` | 장마감 | 마지막 시세 + 정상 히트, 600초 하트비트 |

- 시세 **결측** 종목(KIS 미스): 행 유지, 가격·등락 `—`, 중립 배경. (시세 폴링은 절대 500 금지 — 빈 결과 graceful, 기존 계약)
- **자격증명 없음/오프라인 배너 (eng-review Q4 — DRY 재사용)**: `useLiveStatus()` + 순수 `deriveBannerState({status, watchlistSize})` + `LiveStateBanner`(전부 `live/*` 기존 자산)를 헤더 아래에 그대로 사용. 관심종목이 있는데 poller가 안 떴으면(자격증명 미설정) "KIS 자격증명이 설정되지 않았습니다" + `/settings` 링크(/live와 동일 신호·코피). `watchlist_empty`는 §아래 빈-상태가 처리하므로 배너로는 `kis_credentials_missing`만 노출. 새 배너 컴포넌트 만들지 않음.

## 9. 인라인 편집 (경량 추가만)

사용자 요청: 페이지에서 **그룹 추가 + 종목 추가**. 무거운 편집(삭제·이동·드래그 재정렬)은 **앱 전역 `WatchlistDrawer`**(우측 레일, /heatmap에서도 열림)를 그대로 사용 — 멀티칼럼 드래그 재구현 회피 + 드로어 로직 무중복.

- **＋새 그룹**: 보드 상단 버튼 → `GroupNameModal`(재사용) → `createFolder`.
- **＋종목** (폴더 헤더): `SymbolSearch`(재사용) 팝오버 → `useAddToFolder(folderId)`.
- `POST /api/watchlist`는 `code`만 받아 **미분류**에 추가하므로(검증: 종목 마스터, 404 `unknown_code`/409 `already_in_watchlist`), 폴더 지정 추가 = **2-콜 체이닝**: `addToWatchlist(code)` → `moveEntries([code], folderId)`. `useAddToFolder` 훅이 캡슐화(부분 실패 시 미분류에 남아 드로어로 복구 가능 — 데이터 유실 없음).
- 모든 변경은 `useWatchlist` 쿼리 무효화 → 보드 + 드로어 **동시 반영**(단일 출처).

## 10. DESIGN.md 영향

- 가격 방향 색(`--price-up`/`--price-down`)을 **가변 알파 히트 램프**(0→0.42)로 확장. 기존엔 0.10 단일 칩만 정의됨. **색상 카테고리(가격 방향)는 준수**, 알파 범위만 확장 — 시각 승인 완료.
- DESIGN.md "Color" 절에 짧은 노트 추가 제안: "Price-direction heat ramp — `heatBg()`가 `--price-up`/`--price-down`을 |등락률| 비례 알파(±8% 포화, max 0.42)로 사용. 히트맵 보드 전용."
- 폰트: 모든 숫자 Geist Mono `tabular-nums`(기존 토큰). 색약: 배경+숫자+부호 삼중.

## 11. 테스트 전략 (vitest + testing-library)

- `heat.test.ts`: `heatBg` 램프(0/±작은값/±SAT/±상한가/null), 클램프, 부호→색.
- 정렬 비교자: 등락률 내림차순 + null 맨 아래, 수동 order.
- `useAddToFolder.test.tsx`: add→move 순서, 부분 실패 시 미분류 잔류.
- `HeatmapRow.test.tsx`: 결측 `—`, 클릭→jump(`useJumpToLive` 모킹), 색 클래스.
- `HeatmapFolder.test.tsx`: 정렬 적용, 평균 등락률, `＋종목` 팝오버.
- `Heatmap.test.tsx`: phase 분기(장전 `—`), 빈 폴더 제외, 빈 watchlist 상태.

## 12. 초기 종목 구축 (별도 후속 작업 — 이 스펙 비범위)

**페이지는 현재 120종목으로 즉시 동작하므로 구축은 페이지를 막지 않는다.** 사용자 결정: 참고 이미지 수준으로 **대폭 확장 큐레이션**.

- **방법**: 섹터→주도주 매핑은 자동화 불가(종목 마스터에 업종 분류 없음 — `code/name/market/security_type`만). 도메인 지식 + 리서치로 큐레이션.
- **절차**: ① 섹터별 주도주 목록 제안(레버리지/인버스, AI데이터센터 하위테마, 바이오 세분화, 우주항공, 양자, 풍력, 광통신 등 참고 이미지 테마 포함) → ② 사장님 검토 → ③ API 일괄 적용(`createFolder`+`addToWatchlist`+`moveEntries`). 코드는 종목 마스터 이름 조회로 검증, 변경은 전부 API 경유(메모리 선호 준수).
- **산출물**: 이 코드 스펙과 별도 브레인스토밍/작업으로 진행. 멀티에이전트 워크플로(테마별 주도주 리서치 → 검증)로 후보를 모으되, **자동 커밋 금지** — 제안→검토→적용.

## 13. 비범위 / YAGNI

거래대금/등락액 히트 모드, 폴더 필터, 행 가상화(120행 불필요), 트리맵 비중 시각화, 우측 레일 미니정보, 멀티칼럼 인라인 드래그, 관심그룹-of-폴더 2단 계층 — 전부 v1 제외.

## 14. 엔지니어링 리뷰(plan-eng-review) 반영

그릴링 7개 열린 질문을 eng 리뷰로 해소(코드 근거 포함):
- **Q1 인라인 ＋종목 vs 패널 추가-일원화** → 인라인 팝오버 유지(D1). 2026-06-05 "추가는 편집모달로만"은 **패널 한정** 결정, 관심맵(넓은 보드)은 별도 표면이라 자체 인라인 추가. SymbolSearch 재사용으로 DRY. CONTEXT.md _Avoid_에 스코프 명시.
- **Q2 정렬 churn** → 기본 **manual**(D2, §2·§7). change는 옵트인 라이브 재정렬. 안정 보드·큐레이션 순서가 기본.
- **Q3 폴링 cadence** → **10s 유지**. 120종목=30개×4청크=0.4 req/s vs 15/s 공유 토큰버킷(`kis_client.py:56`), /heatmap선 /live 언마운트라 경합 무시 가능.
- **Q4 오프라인 배너** → `deriveBannerState`+`LiveStateBanner` 재사용(§8).
- **Q5 히트 채도** → **고정 ±8%**. 적응형은 색이 크기를 거짓말함; 고정은 절대 의미 보존(`HEAT_SAT` 튜너블).
- **Q6 멀티칼럼** → 스크롤 컨테이너↔multicol 블록 **분리**(§5, 실 레이아웃 버그 예방).
- **Q7 phase 배지 + 용어** → 배지 중립 회색(가격색 오용 아님) + "관심맵" CONTEXT.md 등재.
