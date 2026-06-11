# /live 탭 기능 — 설계 스펙

**작성일:** 2026-06-11
**상태:** 승인됨 (브레인스토밍 합의)
**범위:** 프론트엔드 `/live` 페이지에 멀티 종목 탭 추가
**관련:** DESIGN.md §Tabs, ADR-0052(URL seed), ADR-0067(rest_poller), ADR-0038/0040/0043(capture 경로), `frontend/src/live/collectionStatus.ts`

---

## 1. 목표 & 동기

사용자가 `/live`에서 **여러 종목을 탭으로 열어두고 전환하며** 볼 수 있게 한다. 현재 `/live`는
단일 종목 뷰(`useLivePageStore.activeCode` 하나)다. 탭마다 독립된 라이브 뷰가 존재하고,
탭 추가/삭제/전환이 가능해야 한다. 탭 라벨은 종목명.

### 핵심 통찰 (구현 리스크를 크게 낮추는 두 발견)

1. **탭 UI는 이미 설계·승인돼 있다.** 2026-05-20 승인 목업
   `docs/superpowers/designs/2026-05-20-replay-viewer.html`에 `삼성전자/SK하이닉스/NAVER`
   3개 탭이 완전 구현돼 있고(`openTabs` 배열 + `.tab` CSS + 상태 점 + `N/8 open` + `＋`),
   `DESIGN.md §Tabs`(L190-197)에 토큰이 박제돼 있다. /live가 단일 종목 뷰로 출시되며
   탭 행만 빠진 것 → **UI를 새로 발명하지 않고 승인 명세를 그대로 구현**한다.

2. **탭은 캡처/구독 한도와 무관하다.** 종목별 데이터(캔들·호가·실시간·드로잉)는 이미
   종목코드로 격리돼 있고(`useLiveBundle`/`useLiveSeries`/`useDrawingsStore`), 백그라운드
   warm·디스크 캡처는 기존 **Live Set(관심종목 표시순 상위 N)** 이 자동으로 책임진다.
   따라서 탭 레이어는 "어느 code를 활성화할지"만 관리하면 된다.

---

## 2. 데이터/스트리밍 모델 (전제 — 이 설계가 의존하는 기존 동작)

탭 설계는 아래 기존 동작 위에 얹힌다. 새로 만들지 않는다.

### 2.1 수집 3등급 (`collectionStatus.ts:10`, 기존)

| 등급 | 대상 | 경로 | 내용 | 저장 |
|---|---|---|---|---|
| **실시간** | 관심종목 표시순 상위 N (Live Set) | KIS WebSocket 3 TR (호가/체결/거래원) | 호가 10단+체결+거래원 | parquet 저장 |
| **준실시간** | 보는 종목, Live Set 밖 | REST 2초 폴링 (`rest_poller.py`, ADR-0067) | 표시용 | **저장 안 함** |
| **저녁대기** | 관심종목, Live Set 밖, 안 보는 중 | REST 10초 폴링 (`/api/live/quotes`) | 현재가·등락률만 | — |

- **Live Set 크기 = `_PER_ACCOUNT_MAX × n_configured`** (`live_session.py:80-94`).
  현재값: `KIS_WS_MAX_REGISTRATIONS(30) ÷ TRS_PER_CODE(3) = 10`/계좌 × 3계좌 = **상위 30종목**.
  (주의: `live_session.py:45,83`의 "13 * n_configured" 주석은 stale — 실제 계산은 10/계좌.
  이 스펙 범위 밖이지만 향후 정리 대상.)
- 관심종목 add/remove/reorder 시 `refresh_live_stream()`이 Live Set 자동 재계산.

### 2.2 디스크 저장 = WS 경로 전용

- `_StreamConn`(`live_session.py:111`)의 `LiveStream` 객체만 writer를 소유한다.
  `rest_poller`는 writer 미보유 → `buffer.publish`(표시)만, 저장 함수 절대 불호출
  (`rest_poller.py:4,182`).
- 따라서 **forward capture(지금부터 저장될 데이터)** 만 Live Set 멤버십에 게이팅된다.

### 2.3 과거 데이터 = 멤버십 무관, 디스크 존재 여부만

- `/api/live/past-candles`·`past-daily-candles`·`past-investor-net`: KIS REST, per-code 캐시,
  **관심종목 게이팅 없음** → 모든 종목에서 캔들·이동평균·거래량·투자자 순매수 표시됨.
- `/api/range`(호가 띠·체결 세그먼트): `build_range_bundle`이 watchlist/live_set을 **한 번도
  참조하지 않음** — `parquet_dir(date, code, source)` 경로의 `path.exists()`만 본다
  (`bundle.py:107`, `routes.py:223-242`). 즉 과거 어느 날 캡처된 적 있으면 현재 비관심
  종목이어도 그 날짜 호가 지표는 표시된다. "비어있음"은 **캡처 없는 날짜에 한정**.
- capture source는 `hogaplay`(기본)/`kis_live` 두 종류(`bundle.py:101,123`).

**탭 관점 결론:** 탭은 디스크+라이브 위 **순수 뷰어**다. 종목코드만 갈아끼우면 화면이
디스크/라이브 상태를 그대로 반영한다. 탭은 캡처를 신경 쓸 필요가 없다.

---

## 3. 선택한 접근

| 결정 | 선택 | 기각 |
|---|---|---|
| 탭 본질 | **cold-swap 뷰어** — 활성 탭만 프론트 구독 | warm 멀티구독(구독 한도 충돌·lifecycle 복잡) |
| 백그라운드 warm/캡처 | **기존 Live Set이 자동 책임** (탭과 분리) | 탭이 직접 구독/캡처 관리 |

cold-swap에서 배경 탭이 Live Set 종목이면 백엔드가 계속 수집하므로 복귀 시 즉시 warm —
"관심종목 상위 N은 백그라운드에서도 살아있음"이 **추가 비용 0으로** 충족된다.

---

## 4. 상태 아키텍처 (최소 리팩터)

현재 `useLivePageStore` 하나에 종목별 + 전역이 섞여 있다. 종목별인 것만 새 store로 분리하고,
이미 공유 상태인 prefs는 그대로 둔다(과분리 금지).

```
useLiveTabsStore  (신규)                useLivePageStore  (기존 — prefs만 잔류)
├─ tabs: Tab[]                           ├─ candleTimeframe      ← 전역 공유
├─ activeTabId: string                   ├─ movingAverages[]     ← 전역 공유
└─ actions:                              ├─ movingAverageEnabled ← 전역 공유
   openOrFocusTab(code, label?)          ├─ volumeEnabled        ← 전역 공유
   closeTab(id)                          └─ foreignNetEnabled    ← 전역 공유
   focusTab(id)
   reorderTabs(from, to)
   setHistoricalFromDate(id, date)

Tab = {
  id: string            // 안정적 고유 id (code 아님 — 재정렬/중복관리용)
  code: string          // 종목코드
  label: string         // 종목명 (symbol-master)
  historicalFromDate: string | null   // 탭별 좌측 팬 위치
  pinned?: boolean      // (later) 수동 핀 = Live Set 편입
}
```

- **`activeCode`는 파생값**: `tabs.find(t => t.id === activeTabId)?.code`. 별도 저장 안 함.
  기존 `useLivePageStore.activeCode` 소비처는 이 파생 셀렉터로 전환.
- **`historicalFromDate`는 탭별로 이동**(현재는 `livePage.ts:85` 전역). 종목별 팬 위치 유지.
- **타임프레임·지표 토글은 전역 공유 유지** — 탭 전환해도 동일 차트 설정 적용.

---

## 5. 종목별 vs 공유 (탭 전환 시 동작)

| 요소 | 처리 | 탭 전환 시 |
|---|---|---|
| `code` | 탭별 | 활성 탭 code로 `useLiveBundle`/`useLiveSeries` 재키 |
| `historicalFromDate` | 탭별 | 그 탭 보던 위치 복원 |
| `LiveChartRoot` (`viewKey=code\|tf`) | 자동 리마운트 (기존) | 자동 |
| `useLiveSeries(code)` | code별 SSE 버퍼 (기존) | 이전 구독 해제 + 새 구독 (cold-swap) |
| `useDrawingsStore[code]` | code-keyed (기존) | 자동 |
| 타임프레임·지표 토글 | **전역** | 유지 |

차트/시리즈/드로잉은 이미 code 격리돼 있어 추가 작업이 최소. 탭은 그 위 얇은 "code 선택기".

---

## 6. 탭 CRUD & 진입점 재배선 (작업의 핵심)

현재 종목 선택 4곳이 전부 `setActiveCode(code)` 호출. 이를 **`openOrFocusTab(code, label?)`** 로 교체:

```
openOrFocusTab(code, label?):
  기존 탭에 code 존재 → 그 탭 focus (중복 종목 = 새 탭 안 만듦)
  없음 → 소프트캡(8) 미만이면 새 탭 생성(label=종목명) + focus
          소프트캡 도달 시 → 토스트 "최대 8개" 후 무시 (데이터 손실 없음)
```

| 진입점 | 현재 | 변경 후 |
|---|---|---|
| `LiveSymbolSearch` 검색 클릭 (`LiveSymbolSearch.tsx:21`) | `setActiveCode` | `openOrFocusTab` |
| 관심종목 ♥ (`LiveStatusBar`) | `setActiveCode` | `openOrFocusTab` |
| 히트맵 종목 클릭 (`Heatmap`) | `setActiveCode` | `openOrFocusTab` |
| URL `?code=` seed (`LivePage` 초기화) | activeCode adopt | 초기 탭 1개로 seed |

- **추가**: `＋` 버튼 → 검색 팝오버 → 종목 선택. 또는 위 진입점들.
- **삭제**: 탭 hover 시 `×`. 활성 탭 닫으면 인접 탭으로 focus 이동.
- **마지막 탭 닫기**: **빈 상태(＋만 표시)** 로. (직전 종목 유지 안 함 — 명확성 우선)
- **라벨**: `label`은 symbol-master(code→name). 검색/관심종목이 이미 name 보유.

---

## 7. 비 Live-Set 탭 처리

| 상황 | 동작 |
|---|---|
| **활성 탭** (모든 종목) | 등급대로: Live Set이면 WS, 아니면 2초 REST 폴링(준실시간). 캔들·지표는 항상 풀(KIS REST) |
| **배경 탭, Live Set** | 백엔드가 계속 수집(warm) → 복귀 즉시. 비용 0 |
| **배경 탭, 비 Live-Set** | **파킹** — 정지(마지막 화면 유지), 복귀 시 폴링 재개. 추가 작업 0 (cold-swap 기본 동작) |
| **(later) 수동 핀** | 탭에서 "실시간 고정" → 그 종목 Live Set 편입(오늘부터 캡처). 상위 N 한 칸 점유. MVP 제외 |

과거 호가는 §2.3대로 디스크에 있으면 멤버십 무관 자동 표시 — 탭은 신경 쓰지 않는다.

---

## 8. UI / 레이아웃 (DESIGN.md §Tabs 그대로)

탭 행을 `/live` 최상단에 삽입. 그리드 행: `tabs(40px) + statusbar + toolbar + workarea`
(DESIGN.md L148 원래 Replay Viewer 그리드의 tabs 행 복원).

```
┌───────────────────────────────────────────────────────────────────────────┐
│ ▔▔▔▔▔▔▔▔▔▔▔▔▔  ← 활성 탭 2px teal 상단 액센트                                │
│ │● 005930 삼성전자 실시간│ ○ 000660 SK하이닉스│ ◌ 035420 NAVER 파킹 ×│ ＋ │  3/8 open │
│ └ bg-card(활성) ─────┘ └─ bg-input(비활성) ──┘                              │
├───────────────────────────────────────────────────────────────────────────┤
│              차트 + 호가 사이드바  (활성 탭 = 삼성전자)                       │
```

탭 한 칸 구성 (목업 마크업 그대로): `[상태점] [종목코드] [종목명] [상태/메타] [× 닫기]`.

**상태 점** (DESIGN.md 명세 → 수집등급 매핑):
- `●` success solid = **실시간** (Live Set, WS 수신 중)
- `◌` accent pulsing = **로딩/준실시간** (초기 fetch·폴링)
- `○` fg-dimmer outline = **파킹/빈** (배경 비-Live-Set)

**토큰** (전부 기존):
- 활성: `--bg-card` + 2px teal 상단 액센트(`::before`), 하단 보더 없음
- 비활성: `--bg-input` + dim 텍스트 + 풀 보더
- hover: `--bg-input-hover`
- `×`: 18×18px, opacity 0 기본 → 1 on hover
- 높이: 32px(1.0×)/40px(렌더)
- 소프트캡: **8** (`N/8 open` 카운터)

---

## 9. 저장 (Persistence)

- **`localStorage['live.tabs.v1']`**: `{ tabs: [{id, code, label, historicalFromDate, pinned}], activeTabId }`.
  새로고침 시 탭 복원.
- 기존 `live.page.v1`의 `activeCode`/`historicalFromDate` 항목 → tabs store로 마이그레이션
  (기존 activeCode를 탭 1개로 seed).
- 백엔드 저장 불필요(단일 사용자·로컬 도구 — localStorage 충분).
- URL `?code=`는 **초기 시드**로 유지(딥링크 호환). 탭 전체 상태를 URL에 넣지 않음.

---

## 10. 추가 기능 (요청 사항)

| 기능 | 설명 | 범위 |
|---|---|---|
| 드래그 재정렬 | 탭 순서 변경 (관심종목 드래그 패턴 재사용) | **MVP** |
| 키보드 전환 | `Ctrl+Tab`/`Ctrl+1~9` 이동, `Ctrl+W` 닫기, `Ctrl+T` 새 탭 | **MVP** |
| 중복 방지 | 열린 종목 = focus (§6 openOrFocus 내장) | **MVP** |
| 미들클릭 닫기 | 탭 휠클릭 닫기 (브라우저 관습) | 선택(저비용) |
| 수동 핀 | 탭 → Live Set 편입(캡처 시작) | **later** |
| 탭별 타임프레임 | 탭마다 다른 분봉 | **later** (per-tab 승격 쉬움) |
| 배경 폴링(가격 칩 갱신) | — | **제외** (YAGNI) |

---

## 11. 엣지 케이스 & 에러 처리

- **소프트캡 8 초과**: 9번째 시도 → 토스트 "최대 8개" 후 무시 (자동 닫기 안 함 — 데이터 손실 방지).
- **중복 종목**: openOrFocus가 focus로 흡수.
- **잘못된/상장폐지 code**: 탭은 열되 차트 빈 상태 + 기존 에러 배너 재사용.
- **마지막 탭 닫기**: 빈 상태로.
- **복원 시 stale code**: localStorage 복원 후 symbol-master에 없는 code 드롭 + 경고
  (기존 `codes_unknown` 패턴).

---

## 12. 테스트 전략

- **store 단위**: openOrFocus(중복 흡수), close(focus 이동), 소프트캡, reorder, persist 라운드트립.
- **진입점 재배선**: 검색/♥/히트맵/URL → `openOrFocusTab` 호출 검증 (기존 `setActiveCode` 테스트 갱신).
- **마이그레이션**: 기존 `live.page.v1` → `live.tabs.v1` 시드 1탭.
- **타입체크**: `tsc -p tsconfig.app.json` (권위 — root tsconfig는 인자 없이 아무것도 안 봄).
- **브라우저 검증**: `/browse`로 탭 추가/전환/닫기 + 활성 탭만 실시간 확인.

---

## 13. 범위 요약

**MVP:** 상태 store 분리 · 탭 CRUD · 4진입점 재배선 · 탭바 UI(승인 명세) · 종목명 라벨 ·
localStorage 복원 · 파킹 처리 · 소프트캡 8 · 드래그 재정렬 · 키보드 전환 · 중복 방지

**later:** 수동 핀(Live Set 편입) · 탭별 타임프레임 · 백엔드 탭 저장

**제외:** 배경 탭 폴링 · 탭 전체 상태 URL 직렬화
