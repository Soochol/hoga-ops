const paths = {
  calendar: 'M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2z M7 2v4 M17 2v4 M3 10h18 M7 14h2 M15 14h2 M7 18h2',
  board: 'M3 3h18v18H3z M3 9h18 M9 9v12',
  plus: 'M12 5v14 M5 12h14',
  image: 'M3 3h18v18H3z M3 16l5-5 5 5 3-3 5 5 M14 7h.01',
  download: 'M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5',
  copy: 'M9 9h12v12H9z M15 9V3H3v12h6',
  trash: 'M3 6h18 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7',
  restore: 'M3 4v6h6 M3 10a9 9 0 1 1 1 8 M12 8v5l3 2',
  note: 'M4 3h16v12l-6 6H4z M14 21v-6h6 M8 8h8 M8 12h5',
  folder: 'M3 6h7l2 2h9v12H3z',
  menu: 'M3 6h18 M3 12h18 M3 18h18',
  close: 'M5 5l14 14 M19 5L5 19',
  upload: 'M12 16V3 M7 8l5-5 5 5 M4 16v5h16v-5',
  chevron: 'M9 5l7 7-7 7',
  check: 'M4 12l5 5L20 6',
} as const;
export function BoardIcon({ name, size = 16 }: { name: keyof typeof paths; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}
