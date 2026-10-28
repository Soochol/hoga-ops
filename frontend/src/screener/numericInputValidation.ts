import { createContext, useCallback, useContext, useId, useLayoutEffect, useState } from 'react';

type ReportInvalid = (id: string, invalid: boolean) => void;

// Draft text stays in its field; the page only needs to know whether it can submit.
export const NumericInputValidationContext = createContext<ReportInvalid | null>(null);

export function useNumericFieldValidation(invalid: boolean) {
  const id = useId();
  const report = useContext(NumericInputValidationContext);
  useLayoutEffect(() => {
    report?.(id, invalid);
    return () => report?.(id, false);
  }, [id, invalid, report]);
  return `${id}-error`;
}

export function useNumericInputValidation() {
  const [invalidFields, setInvalidFields] = useState<ReadonlySet<string>>(() => new Set());
  const report = useCallback<ReportInvalid>((id, invalid) => {
    setInvalidFields(previous => {
      if (previous.has(id) === invalid) return previous;
      const next = new Set(previous);
      if (invalid) next.add(id); else next.delete(id);
      return next;
    });
  }, []);
  return { report, invalid: invalidFields.size > 0 };
}
