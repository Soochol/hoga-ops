import type { UsStockEntry } from '../api/usDailyCandles';
import type { LiveIndexEntry } from '../api/liveIndices';
import type { SymbolHit } from '../api/types';

export type SearchItem =
  | { kind: 'stock'; hit: SymbolHit }
  | { kind: 'us_stock'; stock: UsStockEntry }
  | { kind: 'index'; index: LiveIndexEntry };

const CHOSEONG = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';

function initials(value: string): string {
  return [...value].map((char) => {
    const syllable = char.charCodeAt(0) - 0xac00;
    return syllable >= 0 && syllable < 11172 ? CHOSEONG[Math.floor(syllable / 588)] : char;
  }).join('');
}

export function searchItemIdentity(item: SearchItem) {
  if (item.kind === 'us_stock') return { name: item.stock.label, code: item.stock.symbol, market: item.stock.exchange };
  return item.kind === 'stock'
    ? { name: item.hit.name, code: item.hit.code, market: item.hit.market }
    : { name: item.index.label, code: item.index.id, market: '지수' };
}

/** Build once per catalog update, rather than normalizing thousands of names per keystroke.
 * Kept local to live search: capture/heatmap retain their existing ordering contract. */
export function buildLiveSearchCatalog(symbols: SymbolHit[], indices: LiveIndexEntry[], usStocks: UsStockEntry[] = []) {
  const items: SearchItem[] = [
    ...usStocks.map((stock): SearchItem => ({ kind: 'us_stock', stock })),
    ...symbols.map((hit): SearchItem => ({ kind: 'stock', hit })),
    ...indices.map((index): SearchItem => ({ kind: 'index', index })),
  ];
  return items.map((item) => {
    const { name, code } = searchItemIdentity(item);
    const normalizedName = name.toLowerCase();
    const english = item.kind === 'us_stock' ? item.stock.english_name.toLowerCase() : '';
    return { item, english, compactName: normalizedName.replace(/\s+/g, ''), name: normalizedName, code: code.toLowerCase(), initials: initials(normalizedName) };
  });
}

export function searchLiveCatalog(catalog: ReturnType<typeof buildLiveSearchCatalog>, query: string, limit = 20): SearchItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const numeric = /^\d+$/.test(q);
  const compact = q.replace(/\s+/g, '');
  const ranked = catalog.flatMap((entry, position) => {
    let rank: number;
    if (entry.code === q || (!numeric && (entry.name === q || entry.compactName === compact))) rank = 0;
    else if (entry.code.startsWith(q) || (!numeric && entry.name.startsWith(q))) rank = 1;
    else if (!numeric && (entry.name.includes(q) || entry.code.includes(q) || entry.english.includes(q))) rank = 2;
    else if (!numeric && entry.initials.includes(q)) rank = 3;
    else return [];
    return [{ ...entry, rank, position }];
  });
  ranked.sort((a, b) => a.rank - b.rank || a.name.length - b.name.length || a.position - b.position);
  return ranked.slice(0, limit).map(({ item }) => item);
}
