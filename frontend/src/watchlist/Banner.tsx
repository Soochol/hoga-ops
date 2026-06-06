const BANNER_CLASS = {
  success: 'bg-tint-success border-tint-success-border text-success',
  error: 'bg-tint-error border-tint-error-border text-error',
} as const;

export function Banner({ kind, children }: { kind: 'success' | 'error'; children: React.ReactNode }) {
  return (
    <div className={`px-3 py-2 rounded border text-sm ${BANNER_CLASS[kind]}`}>
      {children}
    </div>
  );
}
