# 📝 試卷生圖 Studio

> 黑板 × 工作室 · 老師備課用的線稿生成工具 · 一鍵 A4 列印學習單

🌐 **線上工具**：https://cagoooo.github.io/picture-master/

![試卷生圖 Studio](og-image.png)

Made with ♡ by [阿凱老師](https://www.smes.tyc.edu.tw/modules/tadnews/page.php?ncsn=11&nsn=16#a5) @ 桃園市龍潭區石門國民小學

## 🎯 能做什麼

四欄輸入 → OpenAI gpt-image-2 →「黑白線稿 × 2 張」→ 一鍵列印 A4 學習單。
專為國小老師備課設計：**列印不吃墨水 · 中文精準渲染 · 著色頁直接用**。

```
[左：木框黑板 — 輸入區]              [右：紙張 — 預覽 + 列印]
┌────────────────────────┐         ┌─────────────────────┐
│ 標題（選填）           │         │ ╔═══ 學習單預覽 ═══╗ │
│ 對話內容（選填）       │  ───►   │ ║                  ║ │
│ 角色描述 *必填*        │         │ ║   生成中的 SVG   ║ │
│ 背景場景（選填）       │         │ ║                  ║ │
│ 範例 6 類 16 個        │         │ ╚══════════════════╝ │
│ [✦ 生成兩張線稿 ✦]    │         │ 🖨 列印 A4 學習單   │
└────────────────────────┘         └─────────────────────┘
```

## ✨ v0.5 核心功能

### 生成
- 4 欄表單（標題 / 對話 / 角色 / 背景）→ 自動合成 prompt
- OpenAI `gpt-image-2` (1024×1024, medium quality, 2 張)
- **中文精準渲染**（不再像 Google Imagen 變日文片假名）
- 🔄 **重新生成**：同設定一鍵再產一輪
- ✏️ **編輯 prompt 重生**：直接改合成的 prompt 後重生（進階）

### 範例庫（16 個 · 6 類）
- 🎒 校園（Science Class / 數學課 / 運動會 / 圖書館）
- 🐾 動物（Farm Life / 動物園 / 我的寵物）
- 🎊 節慶（中秋節 / 聖誕節 / 端午節）
- 🍱 食物（早餐店 / 夜市美食）
- 🚉 交通（搭公車 / 過馬路）
- 🌿 自然（海邊 / 爬山遠足）

### A4 學習單列印 🖨
- 直接 `window.print()` + `@media print` CSS（不用 jsPDF / html2pdf）
- 4 種排版可選：
  - 2 圖並排（一般學習單，預設）
  - 2 圖直疊（中等大小）
  - 大圖 1 / 大圖 2（適合著色頁）
- 自動產：標題列 + 班級 / 座號 / 姓名 + 圖片格 + 5 行作答空格 + 阿凱老師署名頁尾
- 列印對話框 → 目的地選「另存為 PDF」即下載

### 歷史紀錄
- localStorage 自動存最近 10 筆（含 4 欄位 + 2 張 256×256 jpeg 縮圖）
- 點卡片 → 載入當時欄位，可重生
- 每張卡片右上角 × 可單筆刪除
- 7 天前的紀錄自動清掉

### Lightbox
- 點圖放大 + 左右切換（按鈕 / ← → 鍵 / 手機滑動）
- 下載 PNG · 開新分頁（base64 → Blob URL 避開瀏覽器限制）
- 大圖無捲軸 bug 已修

### 鍵盤快捷鍵 ⌨
| 鍵 | 功能 |
|---|---|
| `Ctrl/Cmd+Enter` | 任何欄位內生成 |
| `1`-`6` | 切換分類 tab |
| `L` | 滾到歷史區 |
| `E` | 清欄位 |
| `← →` | Lightbox 切上下張 |
| `Esc` | 關 Lightbox |
| `?` | 顯示快捷鍵清單 toast |

## 🏗 架構

- **前端**：單檔 `index.html`（內嵌 CSS + vanilla JS, 2000+ 行）→ GitHub Pages
- **後端**：Firebase Cloud Functions v2 (Node 22) → `picture-master` GCP 專案
- **圖像 API**：OpenAI `gpt-image-2`（medium quality, 1024×1024）
- **三層護欄**：
  1. ✅ Cloudflare Turnstile 人機驗證
  2. ✅ Firestore per-IP 每日 5 次配額
  3. ✅ Cloud Functions `maxInstances=5`
- **管理員通知**：LINE Flex Message 卡片（started / success / failed / warning）
- **版本偵測**：Service Worker `BUILD_VERSION` 注入 + 雙線 banner 通知（lifecycle + version.json polling）

### 前後端配額同步
前端 localStorage 算 per-browser，後端 Firestore 算 per-IP。
**收到 backend 429 → 前端自動拉滿 localStorage + 按鈕變灰**，避免使用者陷死循環。

### 圖像模型演進史
| 版本 | 模型 | 結果 |
|---|---|---|
| v0.1-0.2 | Google `imagen-4.0-generate-001` | 中文字變日文片假名亂碼 ❌ |
| v0.2-0.3 | Google `gemini-2.5-flash-image`（Nano Banana） | 中文字仍亂碼 ❌ |
| v0.4+ | OpenAI `gpt-image-2` | 中文精準渲染 ✅ |

### 版本歷程
- **v0.5.0** — 黑板 × 紙張 Studio UI 全面重做 + A4 列印 + 歷史 + 16 範例
- **v0.4.1** — 修放大鏡空白 bug → Lightbox modal
- **v0.4.0** — 換 OpenAI gpt-image-2 修中文亂碼
- **v0.3** — Nano Banana 過渡（仍亂碼）
- **v0.2** — Cloudflare Turnstile + Firebase Cloud Functions 上線
- **v0.1** — Google Imagen 4 初版

## 🚀 本機開發

```bash
# 任一靜態伺服器即可
python -m http.server 8000
# 或 npx serve .
```

開 http://localhost:8000，本機模式：
- 後端返回 SVG 佔位圖（流程驗證用）
- Turnstile 跳過（site key 未注入）
- 配額仍受 localStorage 限制

### 後端開發

```bash
cd functions
npm install
firebase emulators:start --only functions --project=picture-master
```

### 重新產 favicon / og-image

```bash
python scripts/make-icons.py
```

會產：`favicon.svg / favicon-16/32.png / favicon.ico / apple-touch-icon.png / og-image.png`

## 🔐 三層護欄設定

### 1. Cloudflare Turnstile（人機驗證）

到 https://dash.cloudflare.com → Turnstile → Add site：
- Site Name: `picture-master`
- Domain: `cagoooo.github.io`
- Widget Mode: Managed

拿到 Site Key 跟 Secret Key 後：

```bash
# Secret key → Firebase Secret Manager（pipe 進去，不入 git/history）
printf '%s' '你的_SECRET_KEY' | firebase functions:secrets:set TURNSTILE_SECRET \
  --project=picture-master --account=ipad@mail2.smes.tyc.edu.tw --data-file=-

# 重 deploy functions 拿新 secret
firebase deploy --only functions \
  --project=picture-master --account=ipad@mail2.smes.tyc.edu.tw

# Site key → GitHub Actions secret（公開無妨）
gh secret set TURNSTILE_SITE_KEY -R cagoooo/picture-master -b "你的_SITE_KEY"
gh workflow run "Deploy to GitHub Pages" -R cagoooo/picture-master
```

`deploy.yml` 會自動把 `PLACEHOLDER_NOT_CONFIGURED` 替換成真實 site key。

### 2. Firestore per-IP 配額（每日 5 次）

`functions/index.js` 寫死 `DAILY_QUOTA = 5`。每次成功生成在
`quota/{YYYY-MM-DD}_{ipHash}` doc 加 1。`>= 5` 直接 429。

### 3. Cloud Functions maxInstances=5

`functions/index.js` 用 `onRequest({ maxInstances: 5 })` 限制平行實例上限，
極端攻擊下也不會 quota 失控。

## 💰 計費 + 熔斷

OpenAI `gpt-image-2`（medium quality, 1024×1024）：**約 $0.04-0.08 / 張**
- 每次生 2 張 ≈ $0.08-0.16
- 每 IP 每日 5 次上限 ≈ 最壞 $0.4-0.8 USD/IP/天
- 加 `maxInstances=5` 阻止 quota 失控

**強烈建議**：到 https://platform.openai.com → Billing → Usage limits
設「Hard limit」$5（測試期）或 $10（穩定期）當最後熔斷。

## 📂 專案結構

```
picture/
├── index.html                  # 前端單檔（黑板 × 紙張 UI + 全部邏輯）
├── sw.js                       # Service Worker（純更新偵測，不 cache）
├── version.json                # 版本對照（CI 寫入）
├── favicon.svg / .ico / *.png  # 站點圖示（多尺寸）
├── apple-touch-icon.png        # iOS 加到主畫面
├── og-image.png                # FB/LINE/Twitter 分享卡 1200×630
├── scripts/
│   └── make-icons.py           # 一鍵重產 favicon + og-image
├── functions/
│   ├── index.js                # generateImage Cloud Function
│   └── package.json            # @openai/openai + firebase deps
├── .github/workflows/
│   └── deploy.yml              # GitHub Pages 部署 + 注入 Turnstile + BUILD_VERSION
├── firebase.json               # functions + firestore 設定
├── firestore.rules             # 鎖死 client 存取
├── .firebaserc                 # picture-master GCP 專案
└── README.md
```

## 🔮 未來規劃（v0.6+）

- 多 prompt 樣板（線稿 / 卡通 / 漫畫 / 水彩 / 寫實）
- Tweaks 面板（8 種粉筆字 / 5 種強調色 / 黑板深淺）
- 批次模式（CSV 一次生 N 組）
- Firebase Auth Google 登入 + 跨裝置歷史
- 班級分享連結 + QR code
- LINE Bot 介面
- `/admin` 後台看板
- PWA `manifest.json` + Add to Home Screen
- Playwright E2E

## 📜 授權

Made with ❤️ by [阿凱老師](https://www.smes.tyc.edu.tw/modules/tadnews/page.php?ncsn=11&nsn=16#a5)
@ 桃園市龍潭區石門國民小學

圖像由 OpenAI gpt-image-2 生成 · 程式碼 MIT License
