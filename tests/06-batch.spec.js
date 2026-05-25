// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('批次模式 CSV', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.removeItem('pm-history');
      const today = 'pm-quota-' + new Date().toISOString().slice(0, 10);
      localStorage.removeItem(today);
    });
    await page.reload();
  });

  test('點批次按鈕 → modal 開啟', async ({ page }) => {
    await expect(page.locator('#batch-modal.open')).toBeHidden();
    await page.click('#btn-batch-mode');
    await expect(page.locator('#batch-modal.open')).toBeVisible();
    await expect(page.locator('.batch-card h3')).toContainText('批次模式');
  });

  test('範例 CSV 連結指向 data URI', async ({ page }) => {
    await page.click('#btn-batch-mode');
    const href = await page.locator('#batch-sample-link').getAttribute('href');
    expect(href).toContain('data:text/csv');
    expect(href).toContain('charset=utf-8');
  });

  test('上傳 CSV → preview + run 鈕變可按', async ({ page }) => {
    await page.click('#btn-batch-mode');
    const csv = 'title,character,dialogue,background\n' +
                '測試 1,小朋友 A,Hi!,操場\n' +
                '測試 2,小狗,汪汪,客廳\n';
    await page.setInputFiles('#batch-csv', {
      name: 'test.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv, 'utf-8'),
    });
    // preview 應顯示 2 行
    await expect(page.locator('#batch-preview')).toBeVisible();
    const rows = await page.locator('#batch-preview .batch-preview-row:not(.head)').count();
    expect(rows).toBe(2);
    // run 鈕可按
    await expect(page.locator('#batch-run')).toBeEnabled();
  });

  test('CSV 沒 character 欄 → 跳錯', async ({ page }) => {
    await page.click('#btn-batch-mode');
    const csv = 'foo,bar\nx,y\n';
    await page.setInputFiles('#batch-csv', {
      name: 'bad.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv, 'utf-8'),
    });
    await expect(page.locator('#errorbar')).toBeVisible();
    await expect(page.locator('#errorbar')).toContainText('character');
  });

  test('run 批次 → 結果顯示 OK 標記 + 進度 100%', async ({ page }) => {
    await page.click('#btn-batch-mode');
    const csv = 'title,character,dialogue,background\n' +
                '測試,小朋友 X,Hello,操場\n' +
                '測試,小狗 Y,汪,客廳\n';
    await page.setInputFiles('#batch-csv', {
      name: 'run.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv, 'utf-8'),
    });
    await page.click('#batch-run');
    // 等批次完成（每行 mock 1.5s → 2 行 ~3.5s）
    await page.waitForSelector('#batch-results .batch-result-row', { state: 'visible', timeout: 10000 });
    // 等 progress 滿
    await expect(page.locator('#batch-status-text')).toContainText('完成', { timeout: 10000 });
    const okRows = await page.locator('#batch-results .status-ok').count();
    expect(okRows).toBeGreaterThanOrEqual(1);
  });
});
