// Suggests a default saved-screener name of the form 새조건N, where N is the
// smallest positive integer not already used by an existing 새조건N name. This
// keeps the suggestion deterministic even if the user manually names a save
// "새조건5".
export function suggestSaveName(existingNames: string[]): string {
  const used = new Set<number>();
  for (const name of existingNames) {
    const m = /^새조건(\d+)$/.exec(name);
    if (m) used.add(Number(m[1]));
  }
  let n = 1;
  while (used.has(n)) n += 1;
  return `새조건${n}`;
}
