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
   *  등락률 셀을 예상값으로 대체하고 **종목명 앞에 '*' 마커**를 띄운다(관심종목
   *  QuoteRow 와 동일 표기). 창 밖·체결 후엔 키 자체가 사라져(백엔드 게이트 SSOT)
   *  자동으로 확정치 표시로 돌아온다. */
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
  // 예상 표시 모드 — 가격·등락률 셀이 예상값을 싣고 **종목명 앞에 '*' 마커**가 붙는다.
  // 2026-08-19 에 캔들 옆 '예상' 텍스트에서 이관했다: 같은 개념을 관심종목(QuoteRow)은
  // '*', 이 행은 '예상' 으로 쓰던 비대칭을 없앤 것이다(사용자 요청).
  // 마커가 캔들과 **다른 셀**로 옮겨져 이제 둘은 서로의 폭을 다투지 않는다. 캔들의
  // 역할은 그대로다: 마감 동시호가(15:20~15:30)엔 당일 OHLC 가 살아 있어(phase=open)
  // 예상가가 가격 셀을 덮어도 확정 종가·흐름이 글리프로 남고, 개장 동시호가엔 OHLC 가
  // null(hidden_pre_open)이라 CandleGlyph 가 스스로 미렌더 → 마커만 남는다. 두 시간창을
  // 시계로 가르지 않고 **OHLC 유무**로 가른다(데이터 주도).
  // **글리프 트랙은 이 그리드에서 유일하게 고정 px 다**(2026-08-19 회수 `1.9rem`→`14px`).
  // 마커 이관으로 이 셀의 필요폭이 28px → **캔들 10px 뿐**이 됐는데 배정은 1.9rem
  // (`/browse` 실측 @1.0× = 30.39px) 그대로라 20.39px 이 놀고 있었다.
  // 회수하면서 **단위도 rem→px 로 바꿨다**. 이 트랙이 보호하는 것이 rem 이 아니라 고정
  // px 콘텐츠(`CandleGlyph` 의 `W = 10`, SVG viewBox)이기 때문이다 — DESIGN.md 가 반응형
  // floor 를 rem 으로 두는 근거("보호 대상이 전부 rem 기반이라 floor 도 다이얼을 따라야
  // 한다")의 대우다. 종전 주석이 이 열을 **비선형**이라 부른 것이 바로 이 단위 불일치이고,
  // px 트랙은 그 구조 자체를 없앤다. 실측(1440×900, 셀 폭 px):
  //   트랙            root 16px   14px    12px
  //   `14px` (현행)     14.00     14.00   14.00  ← 다이얼과 무관, 여유 항상 4px
  //   `0.875rem`       14.00     12.25   10.50  ← 내릴수록 캔들 10px 에 수렴(=잠식)
  // 14px = 캔들 10 + 여유 4. **10px(딱 맞춤)은 두 번 탈락한다** — ① 다이얼을 한 칸만
  // 내려도 캔들이 잘리고, ② 잘림을 없애 주지도 못한다(아래 그리드 주석의 반올림 항).
  // 셀은 여전히 `overflow-hidden` 이라 넘쳐도 **에러 없이 잘리기만 한다**(무성 회귀) —
  // 이 트랙을 다시 건드리면 산수로 끝내지 말고 브라우저에서 px 로 실측할 것.
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
         아래 px 수치는 전부 **당시 밀도 1.125× 실측**이다 — 같은 날 다이얼이 1.0× 로
         내려갔으므로 배정·필요가 **함께** ×0.889 됐다고 읽을 것(비율 보존이라 잘림·
         넘침 결론은 그대로다). 유일한 예외가 글리프 열이며 그 이유는 위 주석에 있다.
         종전 `2.5rem_3.2rem_4.25rem` 은 내용과 무관하게 정해져 있었다:
           글리프 45px 배정 / 30px 필요(캔들 10 + gap 2 + '예상' 18)  → 15px 유휴
           가격   58px 배정 / 62px 필요(7자리 "1,551,000" 6종목)      → **4px 넘침**
           등락률 77px 배정 / 43px 필요("+12.03")                     → 34px 유휴
         그 결과 이름은 81px 만 받아 4종목이 잘렸다. 재배분 뒤 이름 110px,
         **잘림 4→1 · 가격 넘침 6→0**, 칼럼 수(7)와 스크롤(1.02화면)은 그대로다.
         — 폭 부족이 아니라 배분 오류였으므로 columnWidth 를 키우지 않았다(키우면
         2200px 보드에서 7열→6열, 스크롤 1.02→1.31화면).
         남는 1개는 LIG디펜스앤에어로스페이스(14자) 하나였다.

         **2026-08-19 · 글리프 트랙 회수 `1.9rem`→`14px`** (`/browse` 실측 @1.0×, 보드
         310행). 마커가 종목명 셀로 옮겨져 필요폭이 28px→10px 이 된 만큼 **16.39px 을
         이름 열(1fr)로** 흘려보낸다. 실측은 반드시 **잘리는 뷰포트에서** 한다 — 잘림은
         뷰포트에 대해 **비단조**다. multicol 이 칼럼 수를 올림한 뒤 칼럼을 보드 폭까지
         늘리므로 **칼럼이 하나 늘어난 직후**가 이름 열이 가장 좁고, 넓은 화면은 회수
         전에도 잘림이 0 이라 아무 차이가 안 보인다(2560×1440 은 before/after 둘 다 0).
           뷰포트     열   이름 열 before→after   잘림 before→after
           1440×900   5     95.22 → 111.61        1 → 1  ← 5열 전환 직후(최악 밴드)
           1480×900   5    103.22 → 119.61        1 → 0
           1520×900   5    111.22 → 127.61        1 → 0
           1740×900   6     99.88 → 116.27        1 → 0  ← 6열 전환 직후
           1780×900   6    106.55 → 122.94        1 → 0
         즉 이득은 행 수가 아니라 **밴드**로 잰다: 잘리던 네 밴드가 사라지고 최악 밴드
         하나만 남는다(잘리는 종목은 어느 밴드에서나 LIG 하나, 필요폭 ≈115.2px). 그
         한 밴드의 부족분도 20.0→3.6px 로 줄었다.
         **그 3.6px 을 마저 없애자고 트랙을 캔들과 같은 10px 로 깎지 말 것** — ① 다이얼
         한 칸에 캔들이 잘리고, ② `scrollWidth − clientWidth` 는 **정수 반올림**이라
         부족분 "20.0" 의 실제 값은 19.5~20.5 어디쯤이고, 그때 남는 여유 0.39px 은 그
         오차 안이다(구제가 보장되지 않는다). columnWidth 를 키우는 길도 여전히 닫혀
         있다(위 7→6열 비용). 회귀 감시선: 2560×1440 에서 **7열 · 1.000화면**,
         2200×1200 에서 **7열 · 1.138화면** — 회수 전후 동일. */
      className={`grid grid-cols-[minmax(4rem,1fr)_14px_3.5rem_2.9rem] gap-1.5 px-2 py-px items-center text-sm outline-none focus-visible:outline-none hover:shadow-[inset_0_0_0_1px_var(--border-strong)] focus-visible:shadow-[inset_0_0_0_1px_var(--accent)] ${draggable ? 'cursor-grab select-none touch-none active:cursor-grabbing' : 'cursor-pointer'}`}
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
      >
        {/* 동시호가 예상 마커 — 관심종목 QuoteRow 와 같은 표기·같은 자리(이름 앞).
            truncate 는 부모인 이 span(그리드 아이템)에 걸려 있어 inline 마커는 자기
            폭을 갖지 않는다: 긴 종목명은 뒤쪽이 잘리고 마커는 항상 남는다.
            색을 **명시**하는 이유는 QuoteRow 에 없는 축 때문이다 — captureLagging 이면
            부모가 text-error 라, 상속시키면 마커까지 빨개진다. 크기는 이름에서 상속
            (text-xs); 별표 글리프는 이미 작아 text-2xs 로 더 줄이면 밀도 다이얼
            하단에서 사라진다(QuoteRow 2026-08-14 판단과 동일). */}
        {showExpected && (
          <span className="text-fg-dim" data-testid={`${testId}-expected-marker`}>*</span>
        )}
        {name}
      </span>
      {/* 당일 캔들 셀 — CandleGlyph 가 null 이어도 이 span 이 칼럼을 점유해 정렬 유지.
          예상 마커는 종목명 셀로 옮겼으므로(위 주석) 이 셀은 캔들 **전용**이다. */}
      <span className="flex items-center justify-center overflow-hidden">
        <CandleGlyph open={open} high={high} low={low} close={price} />
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
