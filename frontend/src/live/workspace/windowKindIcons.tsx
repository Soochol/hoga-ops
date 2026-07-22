/**
 * 창 종류의 아이콘 SSOT.
 *
 * 창 추가 메뉴(WindowAddMenu)와 창 목록 메뉴(WindowListMenu)가 같은 kind 를 같은
 * 그림으로 그려야 "추가한 것 = 목록의 그것" 이 시각적으로도 맞는다. 라벨(WINDOW_KIND_LABEL)
 * 과 짝을 이루는 그림 SSOT — 분리돼 있으면 한쪽만 바뀌어 드리프트가 생긴다.
 *
 * live 8종(WindowKind) + /study 전용 `memo` 를 한 맵에 담는다. 두 페이지가 kind
 * 를 넘겨 그림만 가져가므로 여기 union 이 양쪽의 합집합이다.
 */
import type { ReactNode } from 'react';
import type { WindowKind } from '../../state/workspace';

/** WindowListMenu(목록)·WindowAddMenu(추가) 양쪽이 그리는 kind 의 합집합. */
export type IconWindowKind = WindowKind | 'memo';

const svg = (children: ReactNode) => (
  <svg
    aria-hidden="true"
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
);

export const WINDOW_KIND_ICON: Record<IconWindowKind, ReactNode> = {
  chart: svg(
    <>
      <path d="M8 3v4M8 17v4M16 3v6M16 15v6" />
      <rect x="5" y="7" width="6" height="10" rx="1" />
      <rect x="13" y="9" width="6" height="6" rx="1" />
    </>,
  ),
  book: svg(
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 12h18M12 4v16" />
    </>,
  ),
  trade: svg(
    <>
      <path d="M7.5 4v16M7.5 20l-3-3M7.5 20l3-3" />
      <path d="M16.5 20V4M16.5 4l-3 3M16.5 4l3 3" />
    </>,
  ),
  broker: svg(
    <>
      <path d="M3.5 9.5 12 4.5l8.5 5" />
      <path d="M4 20h16M6.5 20v-8M10.5 20v-8M14.5 20v-8M18.5 20v-8" />
    </>,
  ),
  program: svg(
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 10 2.5 2.5L7 15M13 15h4" />
    </>,
  ),
  investor: svg(
    <>
      <circle cx="9.5" cy="8" r="3" />
      <path d="M15.5 19v-1.5a3.5 3.5 0 0 0-3.5-3.5H7a3.5 3.5 0 0 0-3.5 3.5V19" />
      <path d="M15 5.3a3 3 0 0 1 0 5.4" />
      <path d="M20.5 19v-1.5a3.5 3.5 0 0 0-2.5-3.35" />
    </>,
  ),
  vdist: svg(<path d="M4 5h9M4 9.7h15M4 14.3h6M4 19h11" />),
  'sector-ranking': svg(
    <>
      <rect x="3" y="10" width="5" height="10" rx="1" />
      <rect x="9.5" y="4.5" width="5" height="15.5" rx="1" />
      <rect x="16" y="13.5" width="5" height="6.5" rx="1" />
    </>,
  ),
  memo: svg(
    <>
      <path d="M4 4h11l5 5v11a0 0 0 0 1 0 0H4a0 0 0 0 1 0 0V4z" />
      <path d="M14 4v5h5M8 13h8M8 17h5" />
    </>,
  ),
};
