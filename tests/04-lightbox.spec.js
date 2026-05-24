// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Lightbox 放大鏡 + 左右切換', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      const today = 'pm-quota-' + new Date().toISOString().slice(0, 10);
      localStorage.removeItem(today);
    });
    await page.reload();
    await page.fill('#f-character', 'Lightbox 測試');
    await page.click('#btn-generate');
    await page.waitForSelector('#output-ready .img-card', { state: 'visible', timeout: 8000 });
  });

  test('點圖開 lightbox → caption 顯示第 1 張', async ({ page }) => {
    await page.locator('#output-ready .img-card').first().click();
    await expect(page.locator('#lightbox.open')).toBeVisible();
    await expect(page.locator('#lightbox-caption')).toContainText('01');
  });

  test('按 → 切到下一張，← 回上一張', async ({ page }) => {
    await page.locator('#output-ready .img-card').first().click();
    await expect(page.locator('#lightbox-caption')).toContainText('01');

    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#lightbox-caption')).toContainText('02');

    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('#lightbox-caption')).toContainText('01');
  });

  test('Esc 關閉 lightbox', async ({ page }) => {
    await page.locator('#output-ready .img-card').first().click();
    await expect(page.locator('#lightbox.open')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('#lightbox.open')).not.toBeVisible();
  });

  test('第一張時 ‹ 鈕 disabled、第二張時 › 鈕 disabled', async ({ page }) => {
    await page.locator('#output-ready .img-card').first().click();

    // 第一張
    await expect(page.locator('#lb-prev')).toBeDisabled();
    await expect(page.locator('#lb-next')).toBeEnabled();

    // 切到第二張
    await page.click('#lb-next');
    await expect(page.locator('#lb-prev')).toBeEnabled();
    await expect(page.locator('#lb-next')).toBeDisabled();
  });
});
