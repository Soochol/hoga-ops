import { test, type Page } from '@playwright/test';

export const nativeScrollbarTest = test.extend<{ nativeScrollbarPage: Page }>({
  nativeScrollbarPage: async ({ playwright, browserName, baseURL }, use, testInfo) => {
    const browser = await playwright[browserName].launch({
      ...testInfo.project.use.launchOptions,
      channel: testInfo.project.use.channel,
      ignoreDefaultArgs: ['--hide-scrollbars'],
    });
    try {
      await use(await browser.newPage({ baseURL }));
    } finally {
      await browser.close();
    }
  },
});

