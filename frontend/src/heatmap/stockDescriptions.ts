import descriptions from './stockDescriptions.json';

export interface StockDescription {
  name: string;
  lines: readonly string[];
}

/** Code is the identity: group membership and display-name aliases never change the prose. */
export function getStockDescription(code: string | undefined): StockDescription | undefined {
  return code && Object.hasOwn(descriptions, code)
    ? (descriptions as Record<string, StockDescription>)[code]
    : undefined;
}
