import { expect, type Page } from '@playwright/test';

export const conditionDialog = (page: Page) => page.getByRole('dialog', { name: '조건 설정', exact: true });
export async function closeConditionSettings(page: Page) {
  const dialog = conditionDialog(page);
  if (await dialog.isVisible()) await dialog.getByRole('button', { name: '닫기', exact: true }).click();
}
export async function addCondition(page: Page, name: string) {
  await closeConditionSettings(page);
  await page.getByRole('button', { name: '조건 추가', exact: true }).click();
  const dialog = conditionDialog(page);
  await dialog.getByRole('textbox', { name: '조건 검색', exact: true }).fill(name);
  await dialog.getByRole('button', { name: `${name} 선택`, exact: true }).click();
  await dialog.getByRole('button', { name: '추가', exact: true }).click();
  await closeConditionSettings(page);
}
export async function openConditionSettings(page: Page, name: string) {
  const dialog = conditionDialog(page);
  const matcher = new RegExp(`^[A-Z]+ ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} 설정$`);
  if (await dialog.isVisible()) {
    await dialog.getByRole('button', { name: /^내 조건 / }).click();
    await dialog.getByRole('textbox', { name: '조건 검색', exact: true }).fill('');
    await dialog.getByRole('button', { name: matcher }).click();
  } else {
    await page.getByTestId('screener-builder-pane').getByRole('button', { name: matcher }).click();
  }
  const group = dialog.getByRole('group', { name: `${name} 조건`, exact: true });
  await expect(group).toBeVisible();
  return group;
}
