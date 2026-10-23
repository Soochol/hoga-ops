export type BookSummaryWidthBudget = { key: string; font: string; width: number };

/** Measure full nowrap text rather than the space currently allocated to it.
 * Keep the widest observation until the Code/account, font or spacing changes. */
export function measureBookSummaryWidth(element: HTMLDivElement | null, key: string,
  previous: BookSummaryWidthBudget): BookSummaryWidthBudget {
  if (!element || element.getClientRects().length === 0) return previous.key === key ? previous : { key, font: '', width: 0 };
  const rows = Array.from(element.querySelectorAll<HTMLElement>('.book-summary-row'));
  if (rows.length > 0) {
    const style = getComputedStyle(rows[0]);
    const textFont = (element: Element) => {
      const text = getComputedStyle(element);
      // The font shorthand can be empty when tabular figures are enabled.
      return [text.fontFamily, text.fontSize, text.fontWeight, text.fontStyle,
        text.fontVariantNumeric, text.letterSpacing].join(':');
    };
    const font = [textFont(rows[0].children[0]), textFont(rows[0].children[1]), document.fonts?.status,
      style.paddingLeft, style.paddingRight, style.columnGap].join('|');
    const spacing = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)
      + (parseFloat(style.columnGap) || 0);
    // Text ranges measure the full nowrap content, including expected prices
    // whose value span flexes or scrolls inside the currently allocated column.
    const width = Math.ceil(spacing + Math.max(...rows.map(row => Array.from(row.children)
      .filter(child => child.tagName === 'SPAN').reduce((sum, child) => {
        const range = document.createRange();
        range.selectNodeContents(child);
        return sum + range.getBoundingClientRect().width;
      }, 0))));
    return { key, font,
      width: previous.key === key && previous.font === font ? Math.max(previous.width, width) : width };
  }
  return previous.key === key ? previous : { key, font: '', width: 0 };
}
