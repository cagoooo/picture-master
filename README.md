# 📝 試卷出題配圖生成大師

> 老師備課好幫手 · 黑白線稿一鍵生 · 學習單 / 試卷配圖 / 著色頁

🌐 **線上工具**：https://cagoooo.github.io/picture-master/

Made by 阿凱老師 @ 桃園市龍潭區石門國民小學

## 🎯 它能做什麼？

輸入「標題」「角色」「對話」「背景」四個欄位，自動套用「極簡黑白框線構圖師」prompt 模板，
透過 Google Imagen 4 生成適合著色與圖解的純黑白線稿插圖。每次生 2 張讓你挑。

## 🏗️ 架構

- **前端**：單檔 `index.html` + Tailwind CDN + vanilla JS → GitHub Pages
- **後端**：Firebase Cloud Functions v2 (Node 22) → `picture-master` GCP 專案
- **圖像 API**：Google `imagen-4.0-generate-001`（透過 `@google/genai` SDK）
- **三層護欄**：
  1. Cloudflare Turnstile 人機驗證（待設）
  2. Firestore per-IP 每日 5 次配額（已上線）
  3. Cloud Functions `maxInstances=5`（已上線）

## 🚀 本機開發

```bash
# 任一靜態伺服器即可
python -m http.server 8000
# 或 npx serve .
```

開 http://localhost:8000，本機模式會用 SVG 佔位圖呈現流程。

### 後端開發

```bash
cd functions
npm install
firebase emulators:start --only functions --project=picture-master
```

## 🔐 啟用 Turnstile（後續強化步驟）

目前 Turnstile 是 PLACEHOLDER 狀態，前後端都會跳過人機驗證。要啟用：

### 1. 到 Cloudflare 申請 keys（免費）
1. 開 https://dash.cloudflare.com → Turnstile → Add site
2. Site Name: `picture-master`
3. Domain: `cagoooo.github.io`
4. Widget Mode: Managed (推薦)
5. 拿到 **Site Key**（公開）和 **Secret Key**（保密）

### 2. 設定 Secret Key 給後端
```bash
printf '%s' '你的_SECRET_KEY' | firebase functions:secrets:set TURNSTILE_SECRET \
  --project=picture-master --account=ipad@mail2.smes.tyc.edu.tw --data-file=-
firebase deploy --only functions \
  --project=picture-master --account=ipad@mail2.smes.tyc.edu.tw
```

### 3. 設定 Site Key 給前端
```bash
gh secret set TURNSTILE_SITE_KEY -R cagoooo/picture-master -b "你的_SITE_KEY"
gh workflow run "Deploy to GitHub Pages" -R cagoooo/picture-master
```

`deploy.yml` 會自動把 PLACEHOLDER 替換成真實 site key。

## 💰 計費

Imagen 4 計費：**每張約 $0.04 USD**
- 每次生成 2 張 = $0.08
- 每 IP 每日 5 次上限 = 最壞 $0.4 USD/IP/天
- 加 `maxInstances=5` 阻止 quota 失控

## 📂 專案結構

```
picture/
├── index.html              # 前端單檔
├── functions/
│   ├── index.js            # generateImage Cloud Function
│   └── package.json        # @google/genai + firebase deps
├── .github/workflows/
│   └── deploy.yml          # GitHub Pages 部署 + 注入 Turnstile site key
├── firebase.json           # functions + firestore 設定
├── firestore.rules         # 鎖死 client 存取
├── .firebaserc             # picture-master GCP 專案
└── README.md
```

## 📜 授權

Made with ❤️ by [阿凱老師](https://www.smes.tyc.edu.tw/modules/tadnews/page.php?ncsn=11&nsn=16#a5) @ 桃園市龍潭區石門國民小學

圖像由 Google Imagen 生成 · 程式碼 MIT License
