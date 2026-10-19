import { PanelCard, SegmentedControl } from '../ui/PageShell';


/** 카드 헤더의 밀도 우선 토글 — 좁은 카드에서 줄바꿈되도록 헤더가 flex-wrap 이다. */
export function ModeSwitch<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<readonly [T, string]>;
  label: string;
}) {
  return (
    <SegmentedControl aria-label={label}>
      {options.map(([key, text]) => {
        const on = value === key;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(key)}
            className={`min-h-[1.5rem] whitespace-nowrap px-2 py-2xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent font-data text-xs tabular-nums ${on ? 'bg-tint-selection text-accent' : 'text-fg-dim hover:bg-bg-input-hover'}`}
          >
            {text}
          </button>
        );
      })}
    </SegmentedControl>
  );
}


/**
 * 이 페이지의 카드 크롬 — 한 곳에서만 정한다.
 *
 * `borderless flat` 은 카드 분리 수단을 **전부** 끈다: `flat` 이 배경을 `--bg` 로 맞추고
 * `shadow-panel` 을 지우며, `borderless` 가 테두리를 지우고, 다크는 `--bg === --bg-card`
 * 라 톤 스텝도 0이다. 남는 건 gap 뿐인데 4.5px 였다 — 그래서 8장이 한 덩어리로 읽혔다.
 */
export function MarketCard({ className = '', children }: { className?: string; children: React.ReactNode }) {
  return (
    <PanelCard borderless flat className={`market-card min-w-0 flex flex-col gap-sm p-md ${className}`}>
      {children}
    </PanelCard>
  );
}


/**
 * 카드 헤더의 밑줄 — **이 페이지에서 카드 경계를 담당하는 유일한 선이다**(위 참조).
 * 헤더를 안 쓰는 카드는 경계가 없어지므로, 카드를 추가하면 헤더도 같이 붙인다.
 *
 * 구분 시안 5종 중 A 채택(2026-08-05 사용자 확정 —
 * `prototype/market-divider-variants-2026-08-05` 브랜치 보존). B(좌측 스파인)는 열은
 * 갈리나 같은 열에 쌓인 카드의 위아래 경계가 없고, C(톤 스텝 복원)는 가독성이 가장
 * 좋지만 다크 `bg == bg-card` 통일(2026-07-15)을 되돌리는 결정이라 이 페이지 하나를
 * 위해 치를 값이 아니었다.
 *
 * DESIGN.md 상 일탈이 아니다 — `--border` 는 "카드 프레임이 아니라 카드 **내부**
 * 구분선" 용도로 명시돼 있다.
 */
export const CARD_HEADER_RULE = 'market-card-header gap-x-sm gap-y-xs border-b border-border pb-xs';


export function CardHeader({ title, hint, right }: { title: string; hint?: string; right?: React.ReactNode }) {
  return (
    <div className={`flex flex-wrap items-center justify-between ${CARD_HEADER_RULE}`}>
      {/* 제목은 semibold — 카드 안 서브라벨(`text-xs font-semibold`)보다 제목이 가벼운
          위계 역전의 교정. 힌트는 `font-normal` 명시가 필수다(없으면 h2 의 600 을 상속).
          `font-data` 는 표본 카운터(투자자 수급 힌트) 같은 갱신 숫자의 폭 고정용. */}
      <h2 className="text-sm font-semibold text-fg">
        {title} {hint && <span className="font-data text-2xs font-normal text-fg-dim">{hint}</span>}
      </h2>
      {right}
    </div>
  );
}


/** 빈 상태 — **왜 비었는지**를 말한다. 같은 회색 박스로 뭉뚱그리지 않는다. */
export function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="py-sm text-center text-xs text-fg-dim">{children}</p>;
}



/** Keep relevant data states and refresh failures without routine date stamps. */
export function DataStatus({ hasData = false, status, error = false }: {
  hasData?: boolean; status?: string; error?: boolean;
}) {
  if (!status && !error) return null;
  return <div className="flex flex-wrap gap-x-sm gap-y-2xs font-data text-2xs text-fg-dim tabular-nums">
    {status && <span>{status}</span>}
    {error && <span role="status">서버 연결 확인 필요{hasData ? ' · 마지막 데이터 유지' : ''}</span>}
  </div>;
}
