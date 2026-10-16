const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests/e2e', workers: 1, timeout: 45000,
  use: { trace: 'retain-on-failure' }, reporter: 'list',
});
