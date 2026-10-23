import { buildQueries, queryHelpers } from '@testing-library/react';

const queryAllByTooltipText = (container: HTMLElement, text: Parameters<typeof queryHelpers.queryAllByAttribute>[2]) =>
  queryHelpers.queryAllByAttribute('data-tooltip', container, text);

/** Query the hint's unchanged content, independently of browser-native title UI. */
const [queryByTooltipText, getAllByTooltipText, getByTooltipText, , findByTooltipText] = buildQueries(
  queryAllByTooltipText,
  (_container, text) => `Found multiple tooltip triggers with text: ${String(text)}`,
  (_container, text) => `Unable to find a tooltip trigger with text: ${String(text)}`,
);

export function tooltipQueries(container = document.body) {
  return {
    queryByText: queryByTooltipText.bind(null, container),
    getByText: getByTooltipText.bind(null, container),
    getAllByText: getAllByTooltipText.bind(null, container),
    findByText: findByTooltipText.bind(null, container),
  };
}
