// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('頁面基本載入', () => {
  test('關鍵 UI 元素都渲染出來', async ({ page }) => {
    await page.goto('/');

    // statusbar
    await expect(page.locator('.statusbar .brand')).toContainText('試卷生圖');
    await expect(page.locator('.statusbar .pill')).toContainText('LIVE');

    // chalkboard
    await expect(page.locator('.board')).toBeVisible();
    await expect(page.locator('#f-title')).toBeVisible();
    await expect(page.locator('#f-character')).toBeVisible();
    await expect(page.locator('#btn-generate')).toBeVisible();

    // paper (idle 狀態應顯示 gallery)
    await expect(page.locator('.paper')).toBeVisible();
    await expect(page.locator('#output-empty')).toBeVisible();

    // PWA manifest 應該被引入
    const manifest = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(manifest).toBe('./manifest.json');
  });

  test('本機模式 banner 應出現', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#mode-indicator')).toBeVisible();
    await expect(page.locator('#mode-indicator')).toContainText('本機預覽');
  });

  test('範例分類 6 個 tab 都渲染', async ({ page }) => {
    await page.goto('/');
    const tabs = await page.locator('#examples-tabs .tab-btn').count();
    expect(tabs).toBe(6);
  });

  test('5 種風格切換鈕都存在', async ({ page }) => {
    await page.goto('/');
    const styles = await page.locator('#style-picker .style-btn').count();
    expect(styles).toBe(5);
  });
});
