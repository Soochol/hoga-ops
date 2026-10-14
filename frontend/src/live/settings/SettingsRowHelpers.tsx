import type { ReactNode } from 'react';


/** 검색어와 겹치는 라벨 구간을 표시한다 — 지표 패널 검색과 같은 문법(tint 배경 +
 *  굵기, 액센트 잉크 금지). **표시용으로만** 쓸 것: `aria-label` 은 문자열이어야
 *  하므로 원본 라벨을 따로 넘겨야 한다(`ToggleRow` 가 그 분리를 진다). */
export function highlightLabel(label: string, query?: string): ReactNode {
  if (query === undefined || query === '') return label;
  const at = label.indexOf(query);
  if (at < 0) return label;
  return (
    <>
      {label.slice(0, at)}
      <mark className="rounded-sm bg-tint-selection font-semibold text-fg">
        {label.slice(at, at + query.length)}
      </mark>
      {label.slice(at + query.length)}
    </>
  );
}
