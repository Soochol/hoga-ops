/**
 * 「시장 종합」 공용 카드 조각 — 카드 크롬·헤더 밑줄·모드 토글을 **한 곳에서** 정한다.
 *
 * `/market` 카드는 `PanelCard borderless flat` 이라 분리 수단이 전부 꺼져 있고
 * (`flat` 이 배경을 `--bg` 로 맞추고 `shadow-panel` 을 지운다), 실질적인 경계는
 * `CARD_HEADER_RULE` 하나뿐이다. 카드가 여러 파일로 흩어지면 그 선이 제일 먼저
 * 어긋나므로 여기서만 정의한다.
 */
import { useState } from 'react';
import { PanelCard, SegmentedControl } from '../ui/PageShell';
import { persistJson, readJsonObject } from '../state/persist';

/**
 * 카드 토글 선택의 저장 — **쓸 때 다시 읽어 병합한다**.
 *
 * 한 저장 키를 여러 필드가 나눠 쓴다(업종 카드의 시장·주체, 주체별 카드의 방향).
 * state 는 지금 화면에 있는 필드만 아는데 통째로 쓰면 다른 카드·이전 버전이 남긴
 * 선택을 지운다. 지수 카드 `useCardModes` 가 같은 이유로 같은 규율을 쓴다.
 *
 * 토글이 여러 파일로 흩어져 있어 여기서만 정의한다 — 규율이 갈리면 조용히 어긋나고,
 * 증상은 "다른 카드를 만졌더니 내 선택이 풀렸다" 라 원인까지 멀다.
 */
export function useCardPref<T extends string>(
  storageKey: string,
  field: string,
  fallback: T,
): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(
    () => (readJsonObject(storageKey)[field] as T) ?? fallback,
  );
  const update = (next: T) => {
    setValue(next);
    persistJson(storageKey, { ...readJsonObject(storageKey), [field]: next });
  };
  return [value, update];
}

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
            className={`whitespace-nowrap px-2 py-[2px] font-data text-xs tabular-nums ${on ? 'bg-tint-selection text-accent' : 'text-fg-dim hover:bg-bg-input-hover'}`}
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
    <PanelCard borderless flat className={className}>
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
export const CARD_HEADER_RULE = 'border-b border-border pb-2xs';

export function CardHeader({ title, hint, right }: { title: string; hint?: string; right?: React.ReactNode }) {
  return (
    <div className={`flex flex-wrap items-center justify-between gap-x-sm gap-y-2xs ${CARD_HEADER_RULE}`}>
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

