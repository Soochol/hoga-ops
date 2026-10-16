import { useState } from 'react';
import { validOrderInput } from '../../state/orderWindowSettings';

/** Window-local memory: only the preference belongs in persisted settings. */
export function useOrderQuantity(code: string, account: number, remember: boolean, initialQuantity: number) {
  const [input, setInput] = useState(() => ({
    code, account, remember, quantity: initialQuantity as number | null,
    quantities: new Map<string, number | null>(),
  }));
  let current = input;
  if (input.code !== code || input.account !== account || input.remember !== remember) {
    const quantities = remember && input.remember ? new Map(input.quantities) : new Map<string, number | null>();
    if (remember && input.remember && input.account > 0) {
      quantities.set(`${input.account}:${input.code}`,
        input.quantity !== null && validOrderInput(input.quantity, 'quantity') ? input.quantity : null);
    }
    const sameCode = input.code === code;
    // Resolving the initial default account must not erase the initial input.
    const resolvingAccount = input.account === 0 && sameCode;
    const changedContext = !sameCode || input.account !== account;
    const quantity = changedContext && remember && !resolvingAccount
      ? quantities.get(`${account}:${code}`) ?? null
      : sameCode ? input.quantity : null;
    current = { code, account, remember, quantity, quantities };
    // Resolve before the new context's order buttons can commit with the old quantity.
    setInput(current);
  }
  return [current.quantity, (quantity: number | null) => setInput(previous => ({ ...previous, quantity }))] as const;
}
