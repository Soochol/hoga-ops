# 0047 — 체결 사이드바 카드 제거 (Cursor Sidebar 2-card 구성)

**Status:** accepted (2026-05-28)

**Related:**
- `docs/adr/0023-broker-card-day-anchored.md` — "three cards" 전제 사용 (이 ADR 시점 기준 stale)
- `docs/adr/0044-live-hover-spot-from-parquet.md` — "10호가·거래원·체결" 카드 패턴 인용 (이 ADR 시점 기준 stale)
- `docs/superpowers/specs/2026-05-28-remove-fills-sidebar-card-design.md` — 본 결정의 spec
- `CONTEXT.md` — "Cursor Sidebar" 항목 (2-card 정의로 갱신됨)

## Decision

**Cursor Sidebar는 두 개의 카드만 갖는다 — 10호가, 거래원.**

세 번째 카드였던 **체결 (FillTape)** 와 그 전용 데이터 경로를 모두 제거한다:

- Frontend 컴포넌트: `frontend/src/sidebar/FillTape.tsx`
- Frontend 훅: `useTradesAroundCursor` (replay), `useLiveTradesAroundCursor` (live)
- Frontend 어댑터: `flattenTrades`, `LIVE_FILLTAPE_MAX` (in `liveSidebarAdapters.ts`)
- Backend REST 엔드포인트: `GET /api/trades?code=&date=&t=&limit=`
- Backend 모델: `TradesResponse`
- 위 모든 항목의 테스트

**유지되는 것**: 차트 가격 패널 아래의 **체결강도(FillStrength) 인디케이터 pane** 과 그 데이터 경로 — `useLiveSeries.trade` SSE 스트림, `bucketHogaSeries.fillStrengthPoints`, `chart/projectors/fillStrength.ts`. 이는 사이드바 체결 카드와 별개의 시각화이며 사이드바 삭제와 무관하게 동작을 유지한다. `ApiTrade` / `Trade` 타입도 SSE emitter 및 capture pipeline 에서 계속 사용하므로 유지된다.

CursorSidebar의 grid는 `grid-rows-[minmax(624px,2fr)_1.4fr_1fr]` (3행) → `grid-rows-[minmax(624px,2fr)_1fr]` (2행) 로 reflow된다. 10호가는 dominant pane으로 최소 624px 높이를 유지하고, 거래원이 체결이 점유하던 공간을 흡수한다.

## Why

**A. 사용자 UX 결정** ← 채택

근거:
- 사용자가 체결 카드를 명시적으로 불필요하다고 판단 — "10호가, 거래원, 체결에서 체결 ui는 삭제하고 싶어."
- 체결 카드의 주된 정보(가장 최근 N건의 체결 가격·수량·side)는 차트의 체결강도 pane 이 동일하거나 더 압축된 형태로 제공한다 — pane은 buy/sell 막대로 시각화하고 Cumulative Net Fill 라인으로 누적 추세를 보여주므로, 정보 손실이 거의 없다.
- /live의 hover-spot 모드에서도 체결 카드는 단순한 시간 역순 리스트일 뿐 차트 외 추가 통찰을 제공하지 않았다.

**B. 사이드바 슬롯에 다른 카드 배치** — 미채택

근거:
- 현재 후보 카드 없음. 추측성 future-proofing은 본 결정의 범위 밖.
- 새 카드 필요 시 별도 spec/ADR로 그때 추가.

**C. feature flag 로 hide** — 미채택

근거:
- dead code 누적 비용 vs. 복원 가능성 trade-off — 복원이 필요한 시나리오가 보이지 않는다.
- git revert 로 복원 가능하므로 flag-gate 의 가치가 낮음.

## Why removing the backend `/api/trades` too

사용자 선택: "이번 PR에서 함께 제거". 근거:
- frontend 소비처가 사라지면 backend 엔드포인트는 dead route.
- 외부 클라이언트 가정 없음 (내부 frontend 전용 API).
- 부분 삭제는 시간이 지나면 "왜 이 endpoint가 있지?" 질문을 만든다. 함께 정리해서 single source of truth 유지.

## Effect on prior ADRs

- **ADR-0023** ("Broker card is day-anchored"): 본문이 "The Cursor Sidebar's three cards (10호가, 거래원, 체결)" 를 사이드바 표준 형태의 근거로 인용한다. 본 ADR 시점부터 그 인용은 historical context로 해석되며, 현재 사이드바는 **두 카드** (10호가, 거래원) 이다. ADR-0023의 핵심 결정(거래원의 day-anchoring) 자체는 그대로 유효하다.
- **ADR-0044** ("Live hover-spot from parquet"): "10호가·거래원·체결" 카드들이 spot 데이터로 바뀐다는 서술이 있다. 본 ADR 시점부터 spot 전환은 **10호가** 한 카드에만 적용된다 (거래원은 day-anchored 이므로 spot 전환 대상이 아님). hover-spot 메커니즘 자체는 유효.

두 ADR은 frozen historical record로 두며, 현재 시스템의 canonical 형태는 CONTEXT.md "Cursor Sidebar" 항목과 본 ADR이 함께 정의한다.

## Consequences

**Positive:**
- 사이드바 UI 단순화 — 사용자 시선이 10호가/거래원 두 카드에 집중.
- dead code 제거 — 4개 frontend 모듈 + 1개 REST 엔드포인트 + 1개 backend 모델 + 관련 테스트 정리.
- /live 페이지 데이터 흐름 명확화 — `useLiveSeries.trade` 의 유일한 소비처가 차트 체결강도 pane으로 좁혀짐.

**Negative:**
- "가장 최근 N건의 체결" 직접 리스트가 사라짐. 체결강도 pane은 집계 시각화이므로 개별 체결의 정확한 가격/시각을 보고 싶은 사용자에게는 정보 손실. (사용자가 수용 가능하다고 판단.)
- ADR-0023, ADR-0044 의 "세 카드" 인용이 stale이 됨 — 본 ADR이 그 사실을 명시함으로써 미래 독자의 혼란 방지.

**Neutral:**
- 복원이 필요해지면 git revert 한 번이면 가능. 단계적 머지/롤백 불필요.
