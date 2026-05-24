// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * Playwright config for 試卷生圖 Studio
 *
 * 開測前：
 *   npm install
 *   npm run test:install   # 安裝 Chromium browser
 *
 * 跑測試：
 *   npm test               # headless
 *   npm run test:headed    # 看瀏覽器跑
 *   npm run test:ui        # 互動 UI mode
 *
 * webServer 會自動起 python http.server :8000，跑完自動關。
 * IS_LOCAL 偵測 localhost → 後端走 mock SVG，不會真的打 OpenAI。
 */
module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'github' : 'list',

  use: {
    baseURL: 'http://localhost:8000',
    trace: 'on-first-retry',
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'python -m http.server 8000',
    url: 'http://localhost:8000',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
