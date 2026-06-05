/** Single source of the watchlist query key — was inlined in WatchlistDrawer
 *  and constant'd in useWatchlist; unify so new mutations don't re-sprinkle it. */
export const WATCHLIST_KEY = ['watchlist'] as const;
