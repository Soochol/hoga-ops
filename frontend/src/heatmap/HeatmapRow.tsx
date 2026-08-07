import type { DraggableSyntheticListeners } from '@dnd-kit/core';
import { priceDirClass } from '../ui/priceDir';
import { CandleGlyph } from './CandleGlyph';

export interface HeatmapRowProps {
  name: string;
  price: number | null;
  pct: number | null;
  /** 당일 OHLC(없으면 빈 캔들 셀). close 는 기존 price. 부모가 quote 에서 주입. */
  open?: number | null;
  high?: number | null;
  low?: number | null;
  /** 동시호가 예상체결가/등락률(WS 0D 유래, LiveQuote.expected_*). 값이 있으면 가격·
   *  등락률 셀을 예상값으로 대체하고 캔들 셀에 '예' 마커를 띄운다. 창 밖·체결 후엔
   *  키 자체가 사라져(백엔드 게이트 SSOT) 자동으로 확정치 표시로 돌아온다. */
  expectedPrice?: number | null;
  expectedPct?: number | null;
  // QuoteRow 와 동일 계약: 이벤트를 통과시켜 호출부가 ctrl/⌘ 로 새 탭 분기를 할 수
  // 있게 한다. 선택적이라 인자 없이 부르던 기존 호출부는 그대로 유효하다.
  onClick: (e?: React.MouseEvent<HTMLDivElement> | React.KeyboardEvent<HTMLDivElement>) => void;
  ariaLabel: string;
  testId: string;
  /** 드래그 재정렬(수동 정렬 모드)용 — manual 모드에서만 SortableHeatmapRow가 채운다.
   *  미전달이면 행은 정적(클릭 전용)이라 change 모드/유닛 테스트와 동일하게 동작한다. */
  sortableRef?: (el: HTMLElement | null) => void;
  sortableStyle?: React.CSSProperties;
  dragListeners?: DraggableSyntheticListeners;
  dragging?: boolean;
  /** 우클릭 컨텍스트 메뉴(삭제·폴더이동, ADR-0068 G3). 미전달이면 기본 컨텍스트 메뉴. */
  onContextMenu?: (e: React.MouseEvent) => void;
  /** 검색 매칭 행 하이라이트 — 그룹 전체를 보여주되 이 행만 강조(배경 틴트).
   *  QuoteRow active 선례와 동일(좌측 accent 바 없이 배경만). */
  matched?: boolean;
  /** 마지막 캡처 성공일 툴팁 문구(ADR-0142). 행에 **칼럼을 만들지 않는다** — 이 행은
   *  밀도가 1차 정책이라 271행 × 날짜 셀을 감당할 폭이 없다. */
  captureTitle?: string;
  /** 캡처가 최신 수집일보다 뒤처진 행 — 종목명을 --error 로 낮춘다(점 하나를 더
   *  그리면 4칼럼 그리드에 5번째 트랙이 필요하다). */
  captureLagging?: boolean;
}

/** 칼럼형 행: 종목명 │ 캔들 │ 현재가 │ 등락률. 등락은 배경 워시 없이 priceDirClass
 *  텍스트 색(+적/−청/0 중립) + 부호로 표현 — ▲▼ 없음(색+부호 2중, 색약 보조).
 *  결측(null)은 '—'·중립.
 *  종목명 칼럼은 minmax(4rem,1fr) — 좁아져도 4rem 바닥을 깔아 이름이 짜부되지 않게
 *  하고(truncate 의 암묵적 min-width:0 무력화), 남는 폭은 모두 이름에 흘려보낸다.
 *  sortable* props 가 오면 행 루트가 dnd-kit 드래그 표면이 된다(클릭=차트, 드래그=재정렬;
 *  PointerSensor distance:5 가 둘을 가른다 — drawer SortableQuoteRow 와 동일 계약).
 *  행 높이는 캔들 글리프(16px)+py-px 콘텐츠 기반 최대 밀도 — 히트맵 보드는 밀도가
 *  1차라 공용 min-h-list-row(28px; 관심·순위·스크리너)를 의도적으로 쓰지 않는다. */
export function HeatmapRow({
  name, price, pct, open, high, low, expectedPrice, expectedPct, onClick, ariaLabel, testId,
  sortableRef, sortableStyle, dragListeners, dragging, onContextMenu, matched,
  captureTitle, captureLagging,
}: HeatmapRowProps) {
  const sign = (n: number) => (n > 0 ? '+' : '');
  const draggable = !!dragListeners;
  // 예상 표시 모드 — 가격·등락률 셀이 예상값을 싣고 캔들 셀에 '예상' 마커가 붙는다.
  // 마커는 캔들을 **대체하지 않고 나란히** 선다: 마감 동시호가(15:20~15:30)엔 당일
  // OHLC 가 살아 있어(phase=open) 캔들이 정규장 종가·흐름을 계속 보여줘야 한다 —
  // 예상가가 가격 셀을 덮어도 확정 종가가 글리프로 남는다. 개장 동시호가엔 OHLC 가
  // null(hidden_pre_open)이라 CandleGlyph 가 스스로 미렌더 → 마커만 남는다.
  // 두 시간창을 시계로 가르지 않고 **OHLC 유무**로 가른다(데이터 주도).
  // 폭: 셀 1.9rem(34px @기본밀도) ⊃ 캔들 10px + gap 2px + '예상' 18px = 30px 필요.
  // **종전 2.5rem(45px)은 15px 이 놀고 있었다** — 아래 그리드 주석 참조.
  const showExpected = expectedPrice != null;
  const shownPrice = showExpected ? expectedPrice : price;
  const shownPct = showExpected ? (expectedPct ?? null) : pct;
  // 매칭 하이라이트 배경 — 드래그 중 opacity/transform 을 덮지 않도록 base style 위에
  // 병합. QuoteRow 와 동일한 --tint-selection(accent 10%) 배경 틴트.
  const baseStyle = dragging ? { ...sortableStyle, opacity: 0.5 } : sortableStyle;
  return (
    <div
      ref={sortableRef}
      role="button"
      tabIndex={0}
      data-testid={testId}
      data-matched={matched ? '' : undefined}
      aria-label={ariaLabel}
      // dragListeners 를 핸들러보다 먼저 펼쳐, 행의 클릭/Enter=차트 열기 핸들러가 항상
      // 우선되게 한다(현 PointerSensor 는 onPointerDown 만 — 충돌 없음; 향후 KeyboardSensor
      // 도입 시에도 Enter/Space 가 드래그가 아닌 차트 열기로 유지되도록 하는 방어).
      {...dragListeners}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); } }}
      style={matched ? { ...baseStyle, background: 'var(--tint-selection)' } : baseStyle}
      /* 열 폭은 **실측 필요폭 + 여유**로 다시 잡았다(2026-08-07, 보드 276행 전수).
         종전 `2.5rem_3.2rem_4.25rem` 은 내용과 무관하게 정해져 있었다:
           글리프 45px 배정 / 30px 필요(캔들 10 + gap 2 + '예상' 18)  → 15px 유휴
           가격   58px 배정 / 62px 필요(7자리 "1,551,000" 6종목)      → **4px 넘침**
           등락률 77px 배정 / 43px 필요("+12.03")                     → 34px 유휴
         그 결과 이름은 81px 만 받아 4종목이 잘렸다. 재배분 뒤 이름 110px,
         **잘림 4→1 · 가격 넘침 6→0**, 칼럼 수(7)와 스크롤(1.02화면)은 그대로다.
         — 폭 부족이 아니라 배분 오류였으므로 columnWidth 를 키우지 않았다(키우면
         2200px 보드에서 7열→6열, 스크롤 1.02→1.31화면).
         남는 1개는 LIG디펜스앤에어로스페이스(14자) 하나뿐이다. 이걸 마저 없애려면
         columnWidth 를 키워야 하는데 그게 위의 7→6열 비용이라, 여기서 멈춘다. */
      className={`grid grid-cols-[minmax(4rem,1fr)_1.9rem_3.5rem_2.9rem] gap-1.5 px-2 py-px items-center text-sm outline-none focus-visible:outline-none hover:shadow-[inset_0_0_0_1px_var(--border-strong)] focus-visible:shadow-[inset_0_0_0_1px_var(--accent)] ${draggable ? 'cursor-grab select-none touch-none active:cursor-grabbing' : 'cursor-pointer'}`}
    >
      {/* 종목명은 text-fg-dim(중간 회색) + text-xs(행 text-sm 보다 한 단계 작게) — 현재가·
          등락률 칩보다 낮춰, 이름은 작고 차분하게·숫자는 크게(라벨=이름 < 값=가격 < 신호=칩). */}
      <span
        className={`truncate text-xs ${captureLagging ? 'text-error' : 'text-fg-dim'}`}
        // title 은 캡처 지연 안내 전용으로 둔다. 잘린 이름을 읽게 하려고 `?? name`
        // 폴백을 넣어 봤다가 되돌렸다 — ① `HeatmapFolder.test` 의 "마커를 안 넘기면
        // 캡처 표시가 통째로 빠진다" 계약을 깨고, ② 무엇보다 **276행 전부에 호버
        // 툴팁이 생긴다**. 아래 폭 재배분으로 잘림이 1행까지 줄었는데, 그 1행을
        // 위해 275행에 툴팁을 켜는 건 남는 거래가 아니다.
        title={captureTitle}
        data-capture-lagging={captureLagging ? '' : undefined}
      >{name}</span>
      {/* 당일 캔들 셀 — CandleGlyph 가 null 이어도 이 span 이 칼럼을 점유해 정렬 유지.
          예상 표시 중엔 '예상' 마커(text-fg-dimmer, DepthBadge 급 크기)가 캔들 옆에 붙는다. */}
      <span className="flex items-center justify-center gap-0.5 overflow-hidden">
        <CandleGlyph open={open} high={high} low={low} close={price} />
        {showExpected && (
          <span className="text-2xs text-fg-dim" data-testid={`${testId}-expected-marker`}>예상</span>
        )}
      </span>
      <span className="text-right font-data tabular-nums text-fg">
        {shownPrice === null ? '—' : shownPrice.toLocaleString('ko-KR')}
      </span>
      {/* 등락: 방향=priceDirClass 텍스트 색(+적/−청/0 중립) + 부호. 배경 워시·▲▼ 없음
          — 우측 패널 QuoteChange 와 동일 컨벤션(색+부호 2중, 색약 보조). 결측은 '—'. */}
      {shownPct === null ? (
        <span className="text-right font-data tabular-nums text-fg-dim">—</span>
      ) : (
        <span className={`text-right font-data tabular-nums ${priceDirClass(shownPct)}`}>
          {sign(shownPct)}{shownPct.toFixed(2)}
        </span>
      )}
    </div>
  );
}
