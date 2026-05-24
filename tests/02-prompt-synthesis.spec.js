// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Prompt 自動合成', () => {
  test('輸入角色描述會反映到 prompt 預覽', async ({ page }) => {
    await page.goto('/');
    await page.fill('#f-character', '一個小朋友在跑步');
    const text = await page.locator('#prompt-preview').textContent();
    expect(text).toContain('一個小朋友在跑步');
    expect(text).toContain('Subject:');
  });

  test('範例 chip 點擊會填入四欄位', async ({ page }) => {
    await page.goto('/');
    // 點第一個範例 chip
    await page.locator('#examples-chips .chip').first().click();
    const title = await page.inputValue('#f-title');
    const character = await page.inputValue('#f-character');
    expect(title.length).toBeGreaterThan(0);
    expect(character.length).toBeGreaterThan(0);
  });

  test('切風格 → prompt lead 段會跟著變', async ({ page }) => {
    await page.goto('/');
    await page.fill('#f-character', 'test character');

    // 預設線稿
    const lineArtPrompt = await page.locator('#prompt-preview').textContent();
    expect(lineArtPrompt).toContain('coloring book');

    // 切水彩
    await page.locator('#style-picker .style-btn', { hasText: '水彩' }).click();
    const watercolorPrompt = await page.locator('#prompt-preview').textContent();
    expect(watercolorPrompt).toContain('watercolor');
    expect(watercolorPrompt).not.toContain('coloring book');
  });
});
