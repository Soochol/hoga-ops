import type { SVGProps } from 'react';

/** Shared action geometry. Data graphics and user drawing strokes stay independent. */
const glyphs = {
  search: <><circle cx="11" cy="11" r="7" /><path d="m16 16 5 5" /></>,
  layout: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
  arrowUpRight: <path d="m5 19 14-14M5 5h14v14" />,
  close: <path d="m18 6-12 12M6 6l12 12" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  refresh: <><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3.5V9h-5.5" /></>,
  more: <><circle cx="5" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="19" cy="12" r="1" fill="currentColor" /></>,
  settings: <><path d="M9.5 3h5l.5 2 2 1 2-.5 2.5 4-1.5 1.5v2l1.5 1.5-2.5 4-2-.5-2 1-.5 2h-5l-.5-2-2-1-2 .5-2.5-4L4 13v-2L2.5 9.5l2.5-4 2 .5 2-1 .5-2Z" /><circle cx="12" cy="12" r="3" /></>,
  top: <path d="M5 3h14M12 21V7m-6 6 6-6 6 6" />,
  maximize: <rect x="3" y="3" width="18" height="18" rx="2" />,
  restore: <><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
  copy: <><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
  board: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 9v12M12 15h6M15 12v6" /></>,
  imageDownload: <><path d="M8 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7M3 16l5-5 4 4 3-3 3 3M17 15v7m-3-3 3 3 3-3" /><circle cx="16" cy="8" r="1" /></>,
  collect: <path d="M12 3v12m-5-4 5 5 5-5M5 21h14" />,
  saveView: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M7 7h10M7 12h10M7 17h6" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 6v6l4 2" /></>,
  arrowRight: <path d="M4 12h16m-6-6 6 6-6 6" />,
  arrowLeft: <path d="M20 12H4m6-6-6 6 6 6" />,
  arrowDownRight: <path d="M5 5l14 14M9 19h10V9" />,
  arrowToRight: <path d="M3 12h14m-5-5 5 5-5 5M21 4v16" />,
  cursorLink: <path d="M3 12h18M7 8l-4 4 4 4m10-8 4 4-4 4" />,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>,
  eyeOff: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /><path d="M4 4l16 16" /></>,
  pencil: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>,
  select: <path d="m4 3 6 18 3-8 8-3Z" />,
  horizontal: <path d="M3 12h18" />,
  vertical: <path d="M12 3v18" />,
  trendline: <><path d="M4 20 20 4" /><circle cx="4" cy="20" r="1.5" /><circle cx="20" cy="4" r="1.5" /></>,
  rectangle: <rect x="3" y="5" width="18" height="14" rx="1.5" />,
  measure: <><path d="M4 4v16h16M4 20 20 4M14 4h6v6" /><path d="m8 13 3 3m1-7 3 3" /></>,
  text: <path d="M4 4h16M12 4v16M8 20h8M4 4v3m16-3v3" />,
  eraser: <><path d="m3 14 9-10a2 2 0 0 1 3 0l6 6a2 2 0 0 1 0 3l-7 7H8l-5-5a1 1 0 0 1 0-1ZM8 9l9 9M13 20h8" /></>,
  dayHigh: <path d="M3 16h18M8 10l4-4 4 4" />,
  dayLow: <path d="M3 8h18m-13 6 4 4 4-4" />,
  dayOpen: <path strokeDasharray="3 3" d="M3 12h18" />,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>,
  unlock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 7-2.6M12 14v3" /></>,
  trash: <><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6m4-6v6" /></>,
};

export type AppIconName = keyof typeof glyphs | 'pin' | 'database';

export function AppIcon({ name, size = 14, filled = false, className = '', ...props }: {
  name: AppIconName;
  size?: number;
  filled?: boolean;
} & Omit<SVGProps<SVGSVGElement>, 'name' | 'width' | 'height'>) {
  return <svg data-ui-icon="" aria-hidden="true" focusable="false" width={`${size / 16}rem`} height={`${size / 16}rem`}
    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
    strokeLinecap="round" strokeLinejoin="round" className={`ui-line-icon ${className}`.trim()} {...props}>
    {name === 'pin' ? <><path d="M10 3.5v6L7 14h10l-3-4.5v-6Z" fill={filled ? 'currentColor' : 'none'} /><path d="M8.5 3.5h7M12 14v6.5" /></>
      : name === 'database' ? <><ellipse cx="12" cy="5" rx="8" ry="3" fill={filled ? 'currentColor' : 'none'} /><path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" /></>
      : glyphs[name]}
  </svg>;
}
