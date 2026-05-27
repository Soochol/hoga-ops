// Phase → DESIGN.md CSS-variable token. All tokens are verified to exist in
// frontend/src/styles/tokens.css. Do not introduce new tokens here.

export type PhaseKey =
  | 'http_fetch'
  | 'parse'
  | 'disk_write'
  | 'rate_limit'
  | 'backoff'
  | 'cookie_pause'
  | 'other';

export const PHASE_TOKEN: Record<PhaseKey, string> = {
  // Normal phases — categorical palette
  http_fetch:   'var(--accent)',         // teal — primary signal
  rate_limit:   'var(--accent-shade)',   // darker teal, same family
  parse:        'var(--ma-4)',           // green — processing
  disk_write:   'var(--ma-2)',           // blue — processing, smaller share
  // Anomalies — status palette (NEVER 0 in healthy state)
  backoff:      'var(--warn)',           // amber
  cookie_pause: 'var(--error)',          // rose — distinct from 429
  // Residual / instrumentation gap
  other:        'var(--fg-dimmer)',
};

// Phase labels are DOMAIN IDENTIFIERS (they match backend JSON keys an
// operator will grep). Keep English/snake_case per ADR-0039 / DESIGN.md
// "Copy tone" — domain identifiers are never localized.
export const PHASE_LABEL: Record<PhaseKey, string> = {
  http_fetch: 'http_fetch',
  parse: 'parse',
  disk_write: 'disk_write',
  rate_limit: 'rate_limit',
  backoff: 'backoff',
  cookie_pause: 'cookie_pause',
  other: 'other',
};
