// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('生成流程（本機 mock SVG 模式）', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // 重置 localStorage 確保不被舊配額擋
    await page.evaluate(() => {
      const today = 'pm-quota-' + new Date().toISOString().slice(0, 10);
      localStorage.removeItem(today);
    });
    await page.reload();
  });

  test('填欄位 → 點生成 → 2 張 mock 圖出現', async ({ page }) => {
    await page.fill('#f-character', 'E2E 測試角色');
    await page.click('#btn-generate');

    // 等 loading → ready 狀態
    await page.waitForSelector('#output-ready .img-card', { state: 'visible', timeout: 8000 });

    const cards = await page.locator('#output-ready .img-card').count();
    expect(cards).toBe(2);

    // 列印工具列應該出現
    await expect(page.locator('#print-toolbar')).toBeVisible();
    // 重新生成鈕應該出現
    await expect(page.locator('#btn-regenerate')).toBeVisible();
  });

  test('沒填角色描述按生成 → 跳錯誤', async ({ page }) => {
    await page.click('#btn-generate');
    await expect(page.locator('#errorbar')).toBeVisible();
    await expect(page.locator('#errorbar')).toContainText('角色描述');
  });

  test('配額用滿 → 按鈕變灰', async ({ page }) => {
    // 用 DevTools 直接塞滿 quota
    await page.evaluate(() => {
      const today = 'pm-quota-' + new Date().toISOString().slice(0, 10);
      localStorage.setItem(today, '5');
    });
    await page.reload();

    await expect(page.locator('#btn-generate')).toBeDisabled();
    await expect(page.locator('#btn-generate-label')).toContainText('額度已用完');
  });

  test('Ctrl+Enter 快捷鍵能在欄位內觸發生成', async ({ page }) => {
    await page.fill('#f-character', '快捷鍵測試');
    await page.locator('#f-character').press('Control+Enter');
    await page.waitForSelector('#output-ready .img-card', { state: 'visible', timeout: 8000 });
    const cards = await page.locator('#output-ready .img-card').count();
    expect(cards).toBe(2);
  });
});
