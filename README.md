# 📝 試卷出題配圖生成大師

> 老師備課好幫手 · 黑白線稿一鍵生 · 學習單 / 試卷配圖 / 著色頁

阿凱老師 @ 桃園市龍潭區石門國民小學

## 🎯 它能做什麼？

輸入「標題」「角色」「對話」「背景」四個欄位，自動套用「極簡黑白框線構圖師」prompt 模板，
透過 Google Imagen 4 生成適合著色與圖解的純黑白線稿插圖。

## 🏗️ 架構

- **前端**：單檔 `index.html` + Tailwind CDN + vanilla JS
- **後端**：Firebase Cloud Functions v2 (Node.js) 包 Imagen API
- **部署**：GitHub Pages (前端) + Firebase (後端)
- **防護**：Cloudflare Turnstile + IP 速率限制（每日 30 張）+ maxInstances=5

## 🚀 本機預覽

```bash
# 任一靜態伺服器即可，例如：
python -m http.server 8000
# 或 npx serve .
```

開 http://localhost:8000，本機模式會用 SVG 佔位圖呈現流程。

## 📦 階段進度

- [x] **Stage 1**：前端 scaffold + prompt 合成 + UI
- [ ] **Stage 2**：Cloud Functions + Imagen 整合
- [ ] **Stage 3**：GitHub Pages + Firebase 部署
- [ ] **Stage 4**：端到端測試 + 收尾

## 📜 授權

Made with ❤️ by [阿凱老師](https://www.smes.tyc.edu.tw/modules/tadnews/page.php?ncsn=11&nsn=16#a5) @ 桃園市龍潭區石門國民小學
