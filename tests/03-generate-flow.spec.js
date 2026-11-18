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

  test('填欄位 → 點生成 → 1 張 mock 圖出現', async ({ page }) => {
    await page.fill('#f-character', 'E2E 測試角色');
    await page.click('#btn-generate');

    // 等 loading → ready 狀態
    await page.waitForSelector('#output-ready .img-card', { state: 'visible', timeout: 8000 });

    const cards = await page.locator('#output-ready .img-card').count();
    expect(cards).toBe(1);

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

  test('未登入 → 顯示 Google 登入列（次數改由後端以帳號計算）', async ({ page }) => {
    await expect(page.locator('#login-gate-out')).toBeVisible();
    await expect(page.locator('#login-gate-out')).toContainText('請先用 Google 帳號登入才能使用（每人每天 5 次）');
    await expect(page.locator('#btn-login-gate')).toHaveText('使用 Google 帳號登入');
  });

  test('Ctrl+Enter 快捷鍵能在欄位內觸發生成', async ({ page }) => {
    await page.fill('#f-character', '快捷鍵測試');
    await page.locator('#f-character').press('Control+Enter');
    await page.waitForSelector('#output-ready .img-card', { state: 'visible', timeout: 8000 });
    const cards = await page.locator('#output-ready .img-card').count();
    expect(cards).toBe(1);
  });
});
