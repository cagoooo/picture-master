// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('歷史紀錄面板', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // 清乾淨歷史 + 配額
    await page.evaluate(() => {
      localStorage.removeItem('pm-history');
      const today = 'pm-quota-' + new Date().toISOString().slice(0, 10);
      localStorage.removeItem(today);
    });
    await page.reload();
  });

  test('生成一次 → 歷史 strip 出現 1 張卡片', async ({ page }) => {
    await expect(page.locator('#history-strip')).toBeHidden();

    await page.fill('#f-character', '歷史測試 ' + Date.now());
    await page.click('#btn-generate');
    await page.waitForSelector('#output-ready .img-card', { state: 'visible', timeout: 8000 });

    // 等 history 寫入 + 縮圖 canvas 壓縮（async）
    await page.waitForSelector('#history-strip .history-card', { state: 'visible', timeout: 4000 });
    const cards = await page.locator('#history-strip .history-card').count();
    expect(cards).toBe(1);
  });

  test('重整後歷史仍在 localStorage', async ({ page }) => {
    const testName = '持久測試 ' + Date.now();
    await page.fill('#f-character', testName);
    await page.click('#btn-generate');
    await page.waitForSelector('#history-strip .history-card', { timeout: 8000 });

    // 重整
    await page.reload();
    await page.waitForSelector('#history-strip .history-card', { timeout: 3000 });
    const text = await page.locator('#history-strip .history-card .title').first().textContent();
    expect(text).toContain('持久測試');
  });

  test('點 × 刪單筆 → confirm 後消失', async ({ page }) => {
    await page.fill('#f-character', '單刪測試');
    await page.click('#btn-generate');
    await page.waitForSelector('#history-strip .history-card', { timeout: 8000 });

    // 自動 accept confirm dialog
    page.once('dialog', (d) => d.accept());

    await page.locator('#history-strip .history-card .history-del').first().click();
    await expect(page.locator('#history-strip')).toBeHidden();
  });
});
