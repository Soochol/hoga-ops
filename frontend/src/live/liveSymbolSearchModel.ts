import type { LiveIndexEntry } from '../api/liveIndices';
import type { SymbolHit } from '../api/types';

export type SearchItem =
  | { kind: 'stock'; hit: SymbolHit }
  | { kind: 'index'; index: LiveIndexEntry };

const CHOSEONG = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';

function initials(value: string): string {
  return [...value].map((char) => {
    const syllable = char.charCodeAt(0) - 0xac00;
    return syllable >= 0 && syllable < 11172 ? CHOSEONG[Math.floor(syllable / 588)] : char;
  }).join('');
}

export function searchItemIdentity(item: SearchItem) {
  return item.kind === 'stock'
    ? { name: item.hit.name, code: item.hit.code, market: item.hit.market }
    : { name: item.index.label, code: item.index.id, market: '지수' };
}

/** Build once per catalog update, rather than normalizing thousands of names per keystroke.
 * Kept local to live search: capture/heatmap retain their existing ordering contract. */
export function buildLiveSearchCatalog(symbols: SymbolHit[], indices: LiveIndexEntry[]) {
  const items: SearchItem[] = [
    ...symbols.map((hit): SearchItem => ({ kind: 'stock', hit })),
    ...indices.map((index): SearchItem => ({ kind: 'index', index })),
  ];
  return items.map((item) => {
    const { name, code } = searchItemIdentity(item);
    const normalizedName = name.toLowerCase();
    return { item, name: normalizedName, code: code.toLowerCase(), initials: initials(normalizedName) };
  });
}

export function searchLiveCatalog(catalog: ReturnType<typeof buildLiveSearchCatalog>, query: string, limit = 20): SearchItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const numeric = /^\d+$/.test(q);
  const ranked = catalog.flatMap((entry, position) => {
    let rank: number;
    if (entry.code === q || (!numeric && entry.name === q)) rank = 0;
    else if (entry.code.startsWith(q) || (!numeric && entry.name.startsWith(q))) rank = 1;
    else if (!numeric && (entry.name.includes(q) || entry.code.includes(q))) rank = 2;
    else if (!numeric && entry.initials.includes(q)) rank = 3;
    else return [];
    return [{ ...entry, rank, position }];
  });
  ranked.sort((a, b) => a.rank - b.rank || a.name.length - b.name.length || a.position - b.position);
  return ranked.slice(0, limit).map(({ item }) => item);
}
