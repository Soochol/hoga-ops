import { InlineState } from './DataSurface';

export function Banner({ kind, children }: { kind: 'success' | 'error'; children: React.ReactNode }) {
  return <InlineState tone={kind} role={kind === 'error' ? 'alert' : 'status'}>{children}</InlineState>;
}
