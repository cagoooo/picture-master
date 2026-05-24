(() => {
  'use strict';

  const VERSION = 'v0.5.0';
  const DAILY_QUOTA = 5;

  // 模組級狀態 — 放最上面避免 TDZ（refreshPrompt / refreshQuotaUI 等在 init
  // 階段就會跑，引用任何 let X 都會炸 ReferenceError）
  let _currentStatus = 'idle';
  let _lastImages = [];     // 最近一次成功生成的圖片 URLs，供列印 / 歷史使用
  let _promptEditMode = false; // prompt 編輯模式（true 時 refreshPrompt 不覆蓋）
  let _selectedStyle = (function () {
    try { return localStorage.getItem('pm-style') || 'line-art'; }
    catch { return 'line-art'; }
  })();

  // ==========================================================
  // ⚡ EARLY BOOT — DOM helper / IS_LOCAL / SW 註冊放最頂端
  // 防呆：後段 init 若 throw（TDZ / null deref 等）會中斷 IIFE，
  // 但 SW 機制已先註冊好 → hotfix push 後使用者仍會收到 banner
  // 而不會卡在壞版死循環裡。
  // ==========================================================
  const $ = (id) => document.getElementById(id);
  const IS_LOCAL = ['localhost', '127.0.0.1', ''].includes(location.hostname);
  // 由 index.html bootstrap 注入（deploy.yml sed 對 index.html 才會生效）
  // → 抽檔後 app.js 不必再 sed，single-source-of-truth 在 index.html
  const BUILD_VERSION_BAKED = (window.__PM_CONFIG && window.__PM_CONFIG.BUILD_VERSION) || '__BUILD_VERSION__';

  // 版本顯示 — 用 try/catch 包，避免某個 element 缺失把 SW 註冊拖下水
  try {
    const versionDisplay = BUILD_VERSION_BAKED.startsWith('__')
      ? VERSION : `${VERSION} · ${BUILD_VERSION_BAKED}`;
    const vt  = $('version-tag');
    const vtf = $('version-tag-footer');
    if (vt)  vt.textContent  = versionDisplay;
    if (vtf) vtf.textContent = versionDisplay;
  } catch (e) { console.warn('version display failed', e); }

  // Service Worker + 雙線更新偵測（依 pwa-cache-bust skill）
  if (!IS_LOCAL && 'serviceWorker' in navigator) {
    let bannerShown = false;

    function showUpdateBanner(newVer) {
      if (bannerShown) return;
      bannerShown = true;
      const banner = document.createElement('div');
      banner.id = 'sw-update-banner';
      banner.style.cssText = `
        position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
        background: #1f2a26; color: #f0ebd8; padding: 14px 22px; border-radius: 4px;
        font-size: 13px; font-weight: 600; box-shadow: 0 8px 24px rgba(0,0,0,0.4);
        z-index: 9999; display: flex; gap: 14px; align-items: center;
        border: 1px solid rgba(246,197,96,.4);
        font-family: var(--font-mono); letter-spacing: .04em;
        animation: slideUp .35s ease-out;
      `;
      banner.innerHTML = `
        <span>🎉 有新版本可用${newVer ? ` (${String(newVer).slice(0, 20)})` : ''}</span>
        <button id="sw-reload-btn" style="background:#f6c560;color:#1a1410;border:none;
          padding:7px 14px;border-radius:3px;font-weight:900;cursor:pointer;font-size:12px;
          letter-spacing:.04em;font-family:var(--font-mono);">
          立即更新
        </button>
        <button id="sw-dismiss-btn" style="background:transparent;color:#cfcab0;border:none;
          cursor:pointer;font-size:18px;line-height:1;padding:0 4px;">×</button>
      `;
      document.body.appendChild(banner);
      document.getElementById('sw-reload-btn').onclick = async () => {
        try {
          const keys = await caches.keys();
          await Promise.all(keys.map((k) => caches.delete(k)));
        } catch {}
        location.reload();
      };
      document.getElementById('sw-dismiss-btn').onclick = () => {
        banner.remove();
        bannerShown = false;
      };
      const styleTag = document.createElement('style');
      styleTag.textContent = '@keyframes slideUp { from { opacity:0; transform: translate(-50%, 20px); } to { opacity:1; transform: translate(-50%, 0); } }';
      document.head.appendChild(styleTag);
    }

    // 線 A: SW lifecycle events
    navigator.serviceWorker
      .register('./sw.js', { updateViaCache: 'none' })
      .then((reg) => {
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdateBanner();
            }
          });
        });
        reg.update().catch(() => {});
      })
      .catch((e) => console.warn('SW register failed', e));

    // 線 A.2: 收 SW activate 的 postMessage
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'SW_ACTIVATED') {
        if (BUILD_VERSION_BAKED.startsWith('__') || e.data.version === BUILD_VERSION_BAKED) return;
        showUpdateBanner(e.data.version);
      }
    });

    // 線 B: polling version.json (CDN cache 兜底)
    async function checkVersion() {
      try {
        const r = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' });
        if (!r.ok) return;
        const data = await r.json();
        if (BUILD_VERSION_BAKED.startsWith('__')) return;
        if (data.version && data.version !== BUILD_VERSION_BAKED) {
          showUpdateBanner(data.version);
        }
      } catch {}
    }
    window.addEventListener('focus', checkVersion);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checkVersion();
    });
    window.addEventListener('pageshow', (e) => { if (e.persisted) checkVersion(); });
    window.addEventListener('online', checkVersion);
    setTimeout(checkVersion, 5_000);
    setInterval(checkVersion, 3 * 60 * 1000);
  }
  // ========================== EARLY BOOT END ==========================

  // 16 個範例 / 6 分類 — 給國小老師備課最常用的情境
  const CATEGORIES = [
    { id: 'school',    em: '🎒', label: '校園' },
    { id: 'animal',    em: '🐾', label: '動物' },
    { id: 'festival',  em: '🎊', label: '節慶' },
    { id: 'food',      em: '🍱', label: '食物' },
    { id: 'transport', em: '🚉', label: '交通' },
    { id: 'nature',    em: '🌿', label: '自然' },
  ];
  const EXAMPLES = [
    // 校園
    { cat:'school', emoji:'🔬', label:'Science Class',
      title:'Science Class', dialogue:'Look at this!',
      character:'一位戴眼鏡的女老師指著黑板，手上拿著一本書',
      background:'教室，黑板上有英文字',
      desc:'戴眼鏡的女老師指著黑板，教室裡有英文字。' },
    { cat:'school', emoji:'➗', label:'數學課',
      title:'數學時間', dialogue:'',
      character:'一位戴眼鏡的小學男生坐在桌前算數學',
      background:'書桌上有作業簿、鉛筆與計算機',
      desc:'戴眼鏡的小男生坐在桌前算數學。' },
    { cat:'school', emoji:'🏃', label:'運動會',
      title:'運動會', dialogue:'加油！',
      character:'兩位小學生在跑道上賽跑，後方有同學加油',
      background:'操場，遠方有觀眾席',
      desc:'兩位小學生在跑道上賽跑，同學在旁加油。' },
    { cat:'school', emoji:'📚', label:'圖書館',
      title:'Library Time', dialogue:'Shhh!',
      character:'一位小女生在圖書館借書台前借書，雙手捧著書',
      background:'圖書館，書架上滿是書，牆上有「請保持安靜」的牌子',
      desc:'小女生在圖書館借書，書架後方滿是書。' },

    // 動物
    { cat:'animal', emoji:'🐷', label:'Farm Life',
      title:'Farm Life', dialogue:'Hello!',
      character:'一隻可愛的小豬跟一隻米格魯小狗並排站著',
      background:'農場，遠處有風車',
      desc:'小豬跟米格魯小狗並排站在農場裡。' },
    { cat:'animal', emoji:'🦁', label:'動物園',
      title:'動物園一日', dialogue:'哇！',
      character:'一群小學生圍著欄杆看獅子，獅子在打哈欠',
      background:'動物園的獅子區，遠處有山和雲',
      desc:'小朋友圍著欄杆看打哈欠的獅子。' },
    { cat:'animal', emoji:'🐱', label:'我的寵物',
      title:'My Pet Cat', dialogue:'Meow~',
      character:'一隻橘色的胖貓躺在沙發扶手上理毛',
      background:'客廳，旁邊有一盆植物和窗外灑進的陽光',
      desc:'橘色胖貓躺在沙發上理毛。' },

    // 節慶
    { cat:'festival', emoji:'🥮', label:'中秋節',
      title:'中秋月圓', dialogue:'好圓喔！',
      character:'一家三口坐在草地上一起吃月餅，抬頭看月亮',
      background:'夜晚，天空有大大的圓月，遠處有屋頂剪影',
      desc:'一家三口坐在草地上看月亮、吃月餅。' },
    { cat:'festival', emoji:'🎁', label:'聖誕節',
      title:'Merry Christmas', dialogue:'Ho ho ho!',
      character:'聖誕老人扛著大袋子站在聖誕樹旁邊微笑',
      background:'客廳，聖誕樹上掛滿裝飾與燈泡',
      desc:'聖誕老人扛大袋子站在聖誕樹旁。' },
    { cat:'festival', emoji:'🐉', label:'端午節',
      title:'端午賽龍舟', dialogue:'加油！',
      character:'一條龍舟上有六個人賣力划槳，鼓手站在船頭打鼓',
      background:'河面，岸邊有觀眾揮旗加油',
      desc:'六人龍舟划槳，鼓手在船頭打鼓。' },

    // 食物
    { cat:'food', emoji:'🍔', label:'早餐店',
      title:'我的早餐', dialogue:'謝謝老闆！',
      character:'一位小男生在早餐店櫃台前接過漢堡跟紅茶',
      background:'早餐店，櫃台上有菜單和飲料杯',
      desc:'小男生在早餐店接漢堡跟紅茶。' },
    { cat:'food', emoji:'🍜', label:'夜市美食',
      title:'夜市好好吃', dialogue:'好吃！',
      character:'一個小女生雙手捧著一碗滷肉飯，露出開心的表情',
      background:'夜市，後方有攤販招牌與一串串燈泡',
      desc:'小女生捧著滷肉飯笑得開心。' },

    // 交通
    { cat:'transport', emoji:'🚌', label:'搭公車',
      title:'Bus to School', dialogue:'請刷卡',
      character:'小學生背著書包，用悠遊卡刷公車的感應器',
      background:'公車內部，駕駛座在前方',
      desc:'小學生背書包用悠遊卡刷公車。' },
    { cat:'transport', emoji:'🚦', label:'過馬路',
      title:'安全過馬路', dialogue:'左看右看',
      character:'一個小學生站在斑馬線旁舉手示意，準備過馬路',
      background:'十字路口，紅綠燈正顯示綠燈',
      desc:'小學生在斑馬線旁舉手準備過馬路。' },

    // 自然
    { cat:'nature', emoji:'🌊', label:'海邊',
      title:'Beach Day', dialogue:'Wow!',
      character:'兩個小朋友在沙灘上一起堆沙堡，旁邊有水桶和鏟子',
      background:'海邊，遠方有海浪和雲',
      desc:'兩個小朋友在沙灘上堆沙堡。' },
    { cat:'nature', emoji:'⛰', label:'爬山遠足',
      title:'登上山頂', dialogue:'我做到了！',
      character:'一群小學生戴帽子背水壺站在山頂，舉手歡呼',
      background:'山頂，可以看到遠方的雲海',
      desc:'小學生爬上山頂舉手歡呼。' },
  ];

  let _selectedCategory = 'school';

  // 節慶主題包 — 隨當下月份自動顯示對應 8 例
  // 格式：[emoji, label, title, dialogue, character, background]
  const THEME_PACKS = [
    { id:'spring-festival', name:'春節 · 元宵', icon:'🧧', months:[1, 2], examples:[
      ['🐲','舞龍舞獅','舞龍舞獅','加油！','兩個小孩穿傳統服裝在舞龍頭，後方有人打鼓','街道，紅色燈籠掛滿天'],
      ['🧧','收紅包','新年快樂','謝謝！','一個小女生收到爺爺奶奶遞過來的紅包，雙手捧住','客廳，桌上有橘子和糖果'],
      ['🥟','包餃子','一起包餃子','我會包了！','一家人在桌前一起包餃子，小孩學著大人捏餃子皮','廚房，桌上有麵粉和餃子皮'],
      ['🏮','元宵提燈籠','元宵節','亮亮的！','幾個小朋友提著各種造型的紙燈籠走在巷子裡','夜晚的傳統街道，月亮高掛'],
    ]},
    { id:'spring', name:'春天', icon:'🌸', months:[3], examples:[
      ['🌸','賞櫻花','春天來了','好美！','一群小朋友抬頭看櫻花樹，花瓣飄落','公園，櫻花滿開的步道'],
      ['🌱','校園種菜','種下希望','加油！','小朋友蹲在花圃旁邊用小鏟子種菜苗','校園菜園，旁邊有澆水壺'],
      ['🐝','蜜蜂採花','嗡嗡嗡','','一隻可愛的蜜蜂停在花朵上採蜜','花叢間，遠處有藍天白雲'],
      ['☂️','春天下雨','下雨了','沙沙沙','一個小朋友撐著黃色雨傘走在水窪間','街道，雨絲斜斜飄落'],
    ]},
    { id:'children-day', name:'兒童節 · 清明', icon:'🎈', months:[4], examples:[
      ['🎈','兒童節遊樂園','兒童節快樂','好好玩！','兩個小朋友坐上旋轉木馬，手舉起來歡呼','遊樂園，遠處有摩天輪'],
      ["🎁","收禮物","Happy Children Day","謝謝！","一個小男生打開大禮物盒，露出驚喜的笑容","客廳，桌上還有蛋糕"],
      ['🌳','清明掃墓','慎終追遠','','一家人帶著鮮花到墓前祭拜','山上墓園，遠處有山林'],
      ['🪁','放風箏','飛高高','加油！','兩個小朋友在草地上一起放風箏','空曠草地，風箏飛在天空'],
    ]},
    { id:'mother-day', name:'母親節', icon:'🌷', months:[5], examples:[
      ['🌷','送花給媽媽','媽媽我愛你','謝謝你','小男生把一束康乃馨遞給媽媽','家裡客廳，餐桌上有禮物'],
      ["🎂","幫媽媽慶生","Happy Mother Day","吹蠟燭！","一家人圍著生日蛋糕，媽媽閉眼許願","家裡，蛋糕上插著蠟燭"],
      ['💌','寫卡片','我的媽媽','','小女生坐在桌前認真寫母親節卡片','書房，桌上有水彩和紙'],
      ['🤱','擁抱媽媽','謝謝媽媽','','小朋友張開雙手抱住媽媽的腰','家裡，背景溫暖'],
    ]},
    { id:'dragon-boat', name:'端午 · 畢業', icon:'🐉', months:[6], examples:[
      ['🐉','賽龍舟','加油！','一二一二！','一條龍舟上有六個人賣力划槳，鼓手站在船頭打鼓','河面，岸邊有觀眾揮旗'],
      ['🍡','吃粽子','香噴噴','好吃！','一個小男生雙手捧著剛打開的粽子，露出滿足表情','餐桌，旁邊有粽葉'],
      ['🎓','畢業典禮','畢業快樂','We did it!','一群小學生穿學士服把帽子拋向空中','禮堂，舞台上有畢業背板'],
      ['📜','頒獎','恭喜畢業','','校長頒發畢業證書給戴方帽的小學生，雙手握手','禮堂講台'],
    ]},
    { id:'summer', name:'暑假 · 父親節', icon:'☀️', months:[7, 8], examples:[
      ['🏖️','海邊玩沙','Summer fun!','Wow!','兩個小朋友在沙灘上一起堆沙堡，旁邊有水桶和鏟子','海邊，遠方有海浪和雲'],
      ['🍉','吃西瓜','好涼','好甜！','一個小女生坐在椅子上大口吃西瓜，臉上沾到汁','院子，背景有大樹遮蔭'],
      ['👨','父親節擁抱','爸爸我愛你','謝謝兒子','小男生踮起腳尖抱住爸爸的脖子','家裡客廳，溫暖光線'],
      ['🏊','游泳池','Splash!','看我！','兩個小朋友在泳池裡玩水，一個從泳圈上跳水','泳池邊，遠處有躺椅'],
    ]},
    { id:'mid-autumn-teacher', name:'中秋 · 教師節', icon:'🥮', months:[9], examples:[
      ['🥮','中秋月圓','中秋節快樂','好圓喔！','一家三口坐在草地上一起吃月餅，抬頭看月亮','夜晚，天空有大大的圓月'],
      ['🍖','中秋烤肉','BBQ Time','好香！','幾個小朋友圍在烤肉架旁，大人在翻肉','院子，天空有月亮'],
      ['🍎','教師節送禮','老師謝謝您','謝謝你！','小學生雙手把蘋果遞給女老師','教室，黑板上有「教師節快樂」'],
      ['💐','謝師卡','Thank you teacher','','一個小女生親手做卡片要送給老師','書桌，旁邊有彩色筆和紙'],
    ]},
    { id:'halloween-national', name:'國慶 · 萬聖', icon:'🎃', months:[10], examples:[
      ['🎌','國慶煙火','中華民國生日快樂','哇！','一家人抬頭看天空中綻放的煙火','夜晚廣場，遠處有國旗'],
      ['🎃','萬聖節變裝','Trick or treat!','給糖！','一群小朋友穿成幽靈、女巫、南瓜，按門鈴要糖','社區門口，夜晚有南瓜燈'],
      ['🦇','南瓜燈籠','Happy Halloween','','一個小女生把刻好的南瓜燈點亮','桌上，背景昏暗有蜘蛛網'],
      ['👻','幽靈派對','Boooo','哈哈！','穿白色床單扮鬼的小孩跳起來嚇朋友','客廳，桌上有萬聖節點心'],
    ]},
    { id:'thanksgiving', name:'感恩節', icon:'🦃', months:[11], examples:[
      ['🦃','感恩節大餐','Happy Thanksgiving','','一家人圍著餐桌，桌上有大火雞和南瓜派','飯廳，溫暖的燭光'],
      ['🌽','感謝豐收','謝謝農夫','','小朋友手裡捧著玉米、南瓜，露出開心表情','農場，後方有麥田'],
      ['🎨','火雞手作','I am thankful','','小朋友在課堂上做火雞造型的手掌畫','教室，桌上有色紙和膠水'],
    ]},
    { id:'christmas-yearend', name:'聖誕 · 跨年', icon:'🎄', months:[12], examples:[
      ['🎄','裝飾聖誕樹','Merry Christmas','好漂亮！','兩個小朋友一起裝飾聖誕樹，掛上彩球和星星','客廳，旁邊有禮物盒'],
      ['🎅','聖誕老人','Ho ho ho!','禮物來了！','聖誕老人扛著大袋子站在聖誕樹旁邊微笑','客廳，聖誕樹上掛滿燈泡'],
      ['☃️','堆雪人','Let it snow','好冷！','兩個穿厚外套的小朋友在雪地裡堆雪人','雪地，遠處有小屋'],
      ['🎆','跨年倒數','Happy New Year','5...4...3!','一家人在客廳手舉杯子，電視顯示倒數','客廳，背景有煙火'],
    ]},
  ];

  function getCurrentThemePack() {
    const m = new Date().getMonth() + 1;
    return THEME_PACKS.find((p) => p.months.includes(m)) || null;
  }

  function renderThemePack() {
    const wrap = $('theme-pack');
    if (!wrap) return;
    const pack = getCurrentThemePack();
    if (!pack) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    wrap.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'theme-pack-head';
    head.innerHTML = `<span class="lbl">📅 本月主題</span>
                      <span class="theme-name">${pack.icon} ${pack.name}</span>`;
    wrap.appendChild(head);
    const chips = document.createElement('div');
    chips.className = 'theme-pack-chips';
    pack.examples.forEach(([emoji, label, title, dialogue, character, background]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'theme-chip';
      btn.textContent = `${emoji} ${label}`;
      btn.title = `${title}｜${character.slice(0, 30)}`;
      btn.addEventListener('click', () => loadExample({ title, character, dialogue, background }));
      chips.appendChild(btn);
    });
    wrap.appendChild(chips);
  }

  function renderExamplesTabs() {
    const wrap = $('examples-tabs');
    if (!wrap) return;
    wrap.innerHTML = '';
    CATEGORIES.forEach((c) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tab-btn' + (c.id === _selectedCategory ? ' active' : '');
      btn.innerHTML = `<span class="em">${c.em}</span>${c.label}`;
      btn.addEventListener('click', () => {
        _selectedCategory = c.id;
        renderExamplesTabs();
        renderExamplesChips();
        renderGallery();
      });
      wrap.appendChild(btn);
    });
  }
  function renderExamplesChips() {
    const wrap = $('examples-chips');
    if (!wrap) return;
    wrap.innerHTML = '';
    EXAMPLES.filter(e => e.cat === _selectedCategory).forEach((ex) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      btn.textContent = `${ex.emoji} ${ex.label}`;
      btn.addEventListener('click', () => loadExample(ex));
      wrap.appendChild(btn);
    });
  }
  function renderGallery() {
    const wrap = $('gallery-grid');
    if (!wrap) return;
    wrap.innerHTML = '';
    // 同分類前 4 個（不足就有多少給多少）
    EXAMPLES.filter(e => e.cat === _selectedCategory).slice(0, 4).forEach((ex) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gallery-card';
      const esc = (s) => s.replace(/[<>&"']/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
      btn.innerHTML = `
        <span class="emo">${ex.emoji}</span>
        <span class="cap">${esc(ex.label)}</span>
        <span class="desc">${esc(ex.desc || '')}</span>
        <span class="cta">↑ 載入 →</span>
      `;
      btn.addEventListener('click', () => loadExample(ex));
      wrap.appendChild(btn);
    });
  }
  function loadExample(ex) {
    fTitle.value = ex.title || '';
    fChar.value  = ex.character || '';
    fDlg.value   = ex.dialogue || '';
    fBg.value    = ex.background || '';
    refreshPrompt();
    hideError();
    if (window.innerWidth < 1100) {
      document.querySelector('.board')?.scrollIntoView({ behavior:'smooth', block:'start' });
    }
    fChar.focus();
  }

  // $ 已在頂端 EARLY BOOT 區宣告，此處不再重複
  const fTitle = $('f-title'),
        fChar  = $('f-character'),
        fDlg   = $('f-dialogue'),
        fBg    = $('f-background'),
        promptPreview = $('prompt-preview');

  // ===== Prompt Synthesis =====
  const CJK_RE = /[぀-ヿ㐀-䶿一-鿿＀-￯]/;

  // 5 種風格樣板 — 切換改變 prompt 的 lead + style 段
  const STYLE_PRESETS = [
    { id:'line-art', label:'黑白線稿', em:'✏️', desc:'純黑白線稿 · 列印不吃墨水 · 適合著色頁',
      lead:'Generate a minimalist black and white vector line art image, coloring book style.',
      style:'Style: Thick bold black outlines, pure white background, no shading, no gradients, no colors, no gray scales, high contrast. Professional comic-strip layout. Suitable as a coloring page for kids. No frame around the image.' },
    { id:'cartoon', label:'卡通彩色', em:'🎨', desc:'飽和色塊 · 兒童繪本風 · 黑色粗線條',
      lead:'Generate a vibrant cartoon-style illustration suitable for children.',
      style:'Style: Bold black outlines with flat saturated colors filling each shape. Friendly cheerful cartoon style. No gradients, no realistic shading. White background. Approachable for elementary school audience. No frame.' },
    { id:'manga', label:'漫畫風', em:'💥', desc:'日系少年漫 · 網點 · 動感',
      lead:'Generate a Japanese manga style illustration.',
      style:'Style: Japanese manga style, dynamic poses, expressive eyes, clean ink-pen line work, screentone (halftone dot) shading for depth, predominantly black and white with occasional spot color accents. Speed lines for motion. No frame.' },
    { id:'watercolor', label:'水彩', em:'🖌️', desc:'柔和暈染 · 故事繪本氛圍',
      lead:'Generate a gentle watercolor painting illustration.',
      style:'Style: Soft watercolor painting, gentle washes of muted pastel colors, visible brush strokes and slight paper texture, dreamy and warm atmosphere. Mostly white background with soft color zones. Suitable for storybook illustration.' },
    { id:'realistic', label:'寫實照片', em:'📷', desc:'擬真攝影 · 自然光 · DSLR',
      lead:'Generate a photorealistic illustration that looks like a high-quality photograph.',
      style:'Style: Photorealistic, natural lighting, detailed textures, sharp focus, professional photography quality. Soft background bokeh. As if captured by a DSLR camera with a 50mm lens.' },
  ];

  function getStylePreset() {
    return STYLE_PRESETS.find((p) => p.id === _selectedStyle) || STYLE_PRESETS[0];
  }

  function buildPrompt() {
    const title = fTitle.value.trim();
    const character = fChar.value.trim();
    const dialogue = fDlg.value.trim();
    const background = fBg.value.trim();

    const preset = getStylePreset();
    const lines = [preset.lead];
    const textElements = [];
    const cjkTexts = [];

    if (title) {
      const hasCJK = CJK_RE.test(title);
      const t = hasCJK ? title : title.toUpperCase();
      textElements.push(`A large, bold title that reads EXACTLY "${t}" at the top center of the image.`);
      if (hasCJK) cjkTexts.push(title);
    }
    if (dialogue) {
      const hasCJK = CJK_RE.test(dialogue);
      if (character) {
        textElements.push(`A clean speech bubble with a clear pointing arrow towards the ${character}, containing the text EXACTLY "${dialogue}".`);
      } else {
        textElements.push(`A clean speech bubble containing the text EXACTLY "${dialogue}".`);
      }
      if (hasCJK) cjkTexts.push(dialogue);
    }
    if (textElements.length) lines.push('Text Elements: ' + textElements.join(' '));
    if (character)  lines.push(`Subject: ${character}.`);
    if (background) lines.push(`Setting: ${background}.`);

    lines.push(preset.style);
    if (cjkTexts.length) lines.push('Render any Chinese / CJK text crisply and accurately as provided, using standard Traditional Chinese typography.');
    return lines.join('\n');
  }

  function refreshPrompt() {
    // 編輯模式中不覆蓋使用者輸入（避免改欄位時把編輯的 prompt 沖掉）
    if (_promptEditMode) return;
    const p = buildPrompt();
    promptPreview.textContent = p;
    $('prompt-char-count').textContent = p.length;
  }

  [fTitle, fChar, fDlg, fBg].forEach(el => {
    el.addEventListener('input', refreshPrompt);
    // 任何輸入動作 → 清掉殘留錯誤訊息，避免「明明改了還顯示舊錯」誤導
    el.addEventListener('input', () => hideError());
  });
  refreshPrompt();

  // ===== Style picker（黑白線稿 / 卡通 / 漫畫 / 水彩 / 寫實）=====
  function renderStylePicker() {
    const wrap = $('style-picker');
    if (!wrap) return;
    wrap.innerHTML = '';
    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = '🎨 風格';
    wrap.appendChild(lbl);
    STYLE_PRESETS.forEach((p) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'style-btn' + (p.id === _selectedStyle ? ' active' : '');
      btn.innerHTML = `<span class="em">${p.em}</span>${p.label}`;
      btn.title = p.desc;
      btn.addEventListener('click', () => {
        _selectedStyle = p.id;
        try { localStorage.setItem('pm-style', p.id); } catch {}
        renderStylePicker();      // 重渲染 active 狀態
        refreshPrompt();          // 更新 prompt 預覽
        showToast(`已切換到「${p.em} ${p.label}」風格`, 1200);
      });
      wrap.appendChild(btn);
    });
    // 當前風格描述
    const desc = document.createElement('span');
    desc.className = 'style-desc';
    desc.textContent = '↑ ' + getStylePreset().desc;
    wrap.appendChild(desc);
  }

  // ===== Examples (tabs + chips + gallery，全部 JS 渲染) =====
  renderStylePicker();    // 5 種風格切換鈕
  renderThemePack();      // 當月主題包（端午 / 母親節 / 教師節...）
  renderExamplesTabs();
  renderExamplesChips();
  renderGallery();

  // ===== Clear =====
  $('btn-clear').addEventListener('click', () => {
    [fTitle, fChar, fDlg, fBg].forEach(el => el.value = '');
    refreshPrompt();
    setStatus('idle');
    hideError();
  });

  // ===== Copy Prompt =====
  $('btn-copy-prompt').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(buildPrompt());
      const btn = $('btn-copy-prompt');
      const orig = btn.innerHTML;
      btn.innerHTML = '✓ 已複製';
      setTimeout(() => { btn.innerHTML = orig; }, 1400);
    } catch {
      alert('複製失敗');
    }
  });

  // ===== 檔名語意化 =====
  // title 優先（老師最先想到的描述），無 title 則退到 character 前 10 字
  // 中文檔名現代瀏覽器都接受，Windows 自動 UTF-8 處理
  function slugifyForFilename(s) {
    if (!s) return 'untitled';
    s = s.trim().slice(0, 14);
    s = s.replace(/[\\/:*?"<>|]/g, '');  // Windows 路徑禁字
    s = s.replace(/[\s　]+/g, '-');  // 半形 + 全形空白 → -
    s = s.replace(/[!@#$%^&*()=+,.;'`~]/g, ''); // 標點
    s = s.replace(/-+/g, '-').replace(/^-|-$/g, '');
    return s || 'untitled';
  }
  function makeFilename(i) {
    const title = fTitle.value.trim();
    const character = fChar.value.trim();
    const slug = slugifyForFilename(title || character);
    return `${slug}-${String(i + 1).padStart(2, '0')}.png`;
  }

  // ===== Toast (生成成功 / 提示) =====
  function showToast(msg, ms = 1800) {
    // 先把舊的清掉，避免疊起來
    document.querySelectorAll('.toast').forEach(el => el.remove());
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = `<span class="ok">✓</span>${msg}`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  // ===== Quota (local, per-day) =====
  function todayKey() {
    return 'pm-quota-' + new Date().toISOString().slice(0, 10);
  }
  function getQuotaUsed() {
    return +(localStorage.getItem(todayKey()) || 0);
  }
  function incQuota() {
    localStorage.setItem(todayKey(), getQuotaUsed() + 1);
  }
  function refreshQuotaUI() {
    const used = getQuotaUsed();
    const remain = Math.max(0, DAILY_QUOTA - used);
    // status bar
    $('quota-remain').textContent = remain;
    $('quota-max').textContent = DAILY_QUOTA;
    // chalkboard quota
    $('quota-remain-text').textContent = remain;
    $('quota-max-text').textContent = DAILY_QUOTA;
    // ticks
    const ticks = $('quota-ticks');
    ticks.innerHTML = '';
    for (let i = 0; i < DAILY_QUOTA; i++) {
      const t = document.createElement('span');
      t.className = 'tick' + (i < used ? ' used' : '');
      ticks.appendChild(t);
    }
    // 配額耗盡 → 按鈕直接灰掉
    if (typeof updateGenerateButton === 'function') updateGenerateButton();
  }
  refreshQuotaUI();

  // ===== Mode + Backend =====
  // IS_LOCAL 已在頂端 EARLY BOOT 區宣告
  if (IS_LOCAL) $('mode-indicator').classList.add('show');

  const CFG = window.__PM_CONFIG || {};
  const TURNSTILE_ENABLED =
    !IS_LOCAL &&
    CFG.TURNSTILE_SITE_KEY &&
    /^[0123]x[A-Za-z0-9_-]+$/.test(CFG.TURNSTILE_SITE_KEY);

  let turnstileWidgetId = null;
  window.__turnstileToken = null;

  window.__onTurnstileLoad = function () {
    try {
      turnstileWidgetId = turnstile.render('#turnstile-widget', {
        sitekey: CFG.TURNSTILE_SITE_KEY,
        callback: (token) => { window.__turnstileToken = token; },
        'expired-callback': () => { window.__turnstileToken = null; },
        'error-callback':   () => { window.__turnstileToken = null; },
        theme: 'dark',
        size: 'flexible',
      });
    } catch (e) { console.error('Turnstile render failed', e); }
  };

  function loadTurnstile() {
    if (!TURNSTILE_ENABLED) return;
    $('turnstile-wrap').classList.add('show');
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__onTurnstileLoad&render=explicit';
    s.async = true;
    s.defer = true;
    document.head.appendChild(s);
  }
  loadTurnstile();

  async function waitForTurnstileToken(timeoutMs = 10000) {
    if (!TURNSTILE_ENABLED) return null;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (window.__turnstileToken) return window.__turnstileToken;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('人機驗證超時，請重新整理頁面');
  }

  function resetTurnstile() {
    if (!TURNSTILE_ENABLED || turnstileWidgetId === null) return;
    try {
      turnstile.reset(turnstileWidgetId);
      window.__turnstileToken = null;
    } catch (e) { console.warn('Turnstile reset failed', e); }
  }

  // ===== Status (idle | loading | ready | error) =====
  const elEmpty   = $('output-empty');
  const elLoading = $('output-loading');
  const elReady   = $('output-ready');
  const statDot   = $('paper-stat-dot');
  const statText  = $('paper-stat-text');

  function setStatus(s, info) {
    _currentStatus = s;
    elEmpty.style.display   = (s === 'idle' || s === 'error') ? '' : 'none';
    elLoading.style.display = (s === 'loading') ? '' : 'none';
    elReady.style.display   = (s === 'ready') ? '' : 'none';
    // 列印工具列只在 ready 狀態顯示
    const pt = $('print-toolbar');
    if (pt) pt.style.display = (s === 'ready') ? '' : 'none';
    let dot = 'idle', text = 'STANDBY';
    if (s === 'loading') { dot = 'busy'; text = 'GENERATING'; }
    else if (s === 'ready') { dot = 'live'; text = `READY · ${info?.count || 0} IMAGES`; }
    else if (s === 'error') { dot = 'idle'; text = 'WAITING'; }
    statDot.className = 'd ' + dot;
    statText.textContent = text;
    updateGenerateButton();
  }

  // 統合 loading 狀態 + 配額判斷 → 按鈕 label / disabled
  function updateGenerateButton() {
    const isLoading = _currentStatus === 'loading';
    const outOfQuota = getQuotaUsed() >= DAILY_QUOTA;
    const btn = $('btn-generate');
    const lbl = $('btn-generate-label');
    btn.disabled = isLoading || outOfQuota;
    lbl.textContent = isLoading
      ? '繪製中…'
      : outOfQuota
        ? '今日額度已用完 · 明日再試'
        : '生成兩張線稿';
  }

  function showError(msg) {
    $('error-msg').textContent = msg;
    $('errorbar').style.display = '';
    setStatus('error');
  }
  function hideError() {
    $('errorbar').style.display = 'none';
  }

  // ===== Print Worksheet (A4) =====
  // 用 window.print() + @media print CSS（依 pdf-export-print-best-practice skill）
  $('btn-print-worksheet').addEventListener('click', () => {
    if (!_lastImages.length) {
      showToast('沒有可列印的圖片，請先生成');
      return;
    }
    // 標題優先序：toolbar 輸入 > 表單 title > 角色描述前 12 字 > 預設「學習單」
    const fromInput = $('ws-title-input').value.trim();
    const fromForm  = fTitle.value.trim();
    const fromChar  = fChar.value.trim().slice(0, 12);
    const title = fromInput || fromForm || fromChar || '學習單';
    $('ws-print-title').textContent = title;

    // 設定列印排版（CSS data-layout 屬性選擇器接手）
    const layout = $('ws-layout-select').value || '2-side';
    $('worksheet-print').setAttribute('data-layout', layout);

    // 注入圖片到列印區
    const grid = $('ws-images');
    grid.innerHTML = '';
    _lastImages.forEach((src, i) => {
      const fig = document.createElement('figure');
      const img = document.createElement('img');
      img.src = src;
      img.alt = `插畫 ${i + 1}`;
      const cap = document.createElement('figcaption');
      cap.textContent = `圖 ${i + 1}`;
      fig.appendChild(img);
      fig.appendChild(cap);
      grid.appendChild(fig);
    });

    // 等 base64 image 解碼完才呼叫 print，否則 print preview 會空白
    Promise.all(
      Array.from(grid.querySelectorAll('img')).map((im) =>
        im.complete ? Promise.resolve()
          : new Promise((r) => { im.onload = im.onerror = r; })
      )
    ).then(() => {
      showToast('開啟列印對話框…');
      setTimeout(() => window.print(), 150);
    });
  });

  // ===== History (localStorage 最近 10 筆壓縮縮圖) =====
  const HISTORY_KEY = 'pm-history';
  const HISTORY_MAX = 10;
  const HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // 7 天過期自動清
  const THUMB_SIZE = 256;       // 壓成 256x256 (~30KB jpeg)
  const THUMB_QUALITY = 0.72;

  function getHistory() {
    try {
      const v = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      if (!Array.isArray(v)) return [];
      // 過濾 7 天前的紀錄
      const cutoff = Date.now() - HISTORY_TTL_MS;
      const fresh = v.filter(e => e && typeof e.ts === 'number' && e.ts >= cutoff);
      // 如果有舊紀錄被淘汰，回寫
      if (fresh.length !== v.length) {
        try { localStorage.setItem(HISTORY_KEY, JSON.stringify(fresh)); } catch {}
      }
      return fresh;
    } catch { return []; }
  }
  function saveHistory(arr) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(arr));
    } catch (e) {
      // localStorage 5MB 上限 → LRU 淘汰最舊的繼續嘗試
      console.warn('history save quota exceeded, trimming', e);
      while (arr.length > 1) {
        arr.shift();
        try {
          localStorage.setItem(HISTORY_KEY, JSON.stringify(arr));
          return;
        } catch {}
      }
      // 連 1 筆都存不下就放棄
      localStorage.removeItem(HISTORY_KEY);
    }
  }

  // 把 1024×1024 base64 PNG 壓成 256×256 jpeg thumb，~30KB
  function compressThumb(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = THUMB_SIZE; canvas.height = THUMB_SIZE;
          const ctx = canvas.getContext('2d');
          // 白底（黑白線稿透明處才不會變黑）
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, THUMB_SIZE, THUMB_SIZE);
          ctx.drawImage(img, 0, 0, THUMB_SIZE, THUMB_SIZE);
          resolve(canvas.toDataURL('image/jpeg', THUMB_QUALITY));
        } catch (e) { reject(e); }
      };
      img.onerror = reject;
      img.src = src;
    });
  }

  async function addToHistory(images, fields) {
    const thumbs = await Promise.all(images.map(compressThumb));
    const entry = {
      ts: Date.now(),
      title: fields.title || '',
      character: fields.character || '',
      dialogue: fields.dialogue || '',
      background: fields.background || '',
      thumbs,
    };
    const arr = getHistory();
    arr.push(entry);
    while (arr.length > HISTORY_MAX) arr.shift();
    saveHistory(arr);
    renderHistory();
  }

  function renderHistory() {
    const arr = getHistory();
    const wrap = $('history-strip');
    const grid = $('history-grid');
    if (!wrap || !grid) return;
    if (!arr.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    grid.innerHTML = '';
    // 最新在前
    arr.slice().reverse().forEach((e, displayIdx) => {
      const realIdx = arr.length - 1 - displayIdx;
      const card = document.createElement('button');
      card.className = 'history-card';
      card.type = 'button';
      const cap = e.title || (e.character || '').slice(0, 14) || '無標題';
      const d = new Date(e.ts);
      const time = d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
      const date = d.toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit' });
      const esc = (s) => s.replace(/[<>&"']/g, (c) => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;' }[c]));
      card.innerHTML = `
        <button class="history-del" type="button" data-del="${realIdx}" title="刪除這筆">×</button>
        <div class="history-thumbs">
          <img src="${e.thumbs[0] || ''}" alt="作品 1">
          <img src="${e.thumbs[1] || e.thumbs[0] || ''}" alt="作品 2">
        </div>
        <div class="history-cap">
          <span class="title">${esc(cap)}</span>
          <span class="ts">${date} ${time}</span>
        </div>
      `;
      card.addEventListener('click', (ev) => {
        // 點到 × 鈕 → 不要載入欄位，改執行刪除
        if (ev.target.classList.contains('history-del')) {
          ev.stopPropagation();
          deleteHistoryEntry(realIdx);
          return;
        }
        loadHistoryEntry(realIdx);
      });
      grid.appendChild(card);
    });
  }

  function deleteHistoryEntry(idx) {
    const arr = getHistory();
    if (!arr[idx]) return;
    if (!confirm('刪除這一筆歷史紀錄？')) return;
    arr.splice(idx, 1);
    saveHistory(arr);
    renderHistory();
    showToast('已刪除 1 筆');
  }

  function loadHistoryEntry(idx) {
    const arr = getHistory();
    const e = arr[idx];
    if (!e) return;
    fTitle.value = e.title || '';
    fChar.value  = e.character || '';
    fDlg.value   = e.dialogue || '';
    fBg.value    = e.background || '';
    refreshPrompt();
    hideError();
    showToast('已載入欄位 — 按「生成兩張線稿」可重產');
    // 滾到 chalkboard
    document.querySelector('.board')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('btn-clear-history').addEventListener('click', () => {
    if (!confirm('清除全部歷史紀錄？此動作無法復原。')) return;
    localStorage.removeItem(HISTORY_KEY);
    renderHistory();
    showToast('歷史紀錄已清除');
  });

  // 頁面載入時 render 一次（如果之前有存）
  renderHistory();

  // ===== 我的範本（localStorage 老師自存 prompt 快取）=====
  const TPL_KEY = 'pm-templates';
  const TPL_MAX = 10;

  function getTemplates() {
    try {
      const v = JSON.parse(localStorage.getItem(TPL_KEY) || '[]');
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  }
  function saveTemplates(arr) {
    try { localStorage.setItem(TPL_KEY, JSON.stringify(arr)); }
    catch (e) { console.warn('save tpl failed', e); }
  }

  function renderTemplates() {
    const wrap = $('my-templates-chips');
    if (!wrap) return;
    const arr = getTemplates();
    wrap.innerHTML = '';
    if (!arr.length) {
      const hint = document.createElement('span');
      hint.className = 'my-templates-empty';
      hint.textContent = '尚無範本 — 填好欄位後按「+ 存為範本」可保存常用設定';
      wrap.appendChild(hint);
      return;
    }
    const esc = (s) => s.replace(/[<>&"']/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
    arr.forEach((t) => {
      const chip = document.createElement('span');
      chip.className = 'tpl-chip';
      chip.title = `${t.title || ''}｜${(t.character || '').slice(0, 30)}`;
      chip.innerHTML = `
        <span class="star">★</span>
        <span class="label">${esc(t.name)}</span>
        <button class="del" type="button" data-del="${t.id}" title="刪除這個範本">×</button>
      `;
      chip.addEventListener('click', (ev) => {
        if (ev.target.classList.contains('del')) {
          ev.stopPropagation();
          deleteTemplate(t.id);
          return;
        }
        loadTemplate(t.id);
      });
      wrap.appendChild(chip);
    });
  }

  function loadTemplate(id) {
    const t = getTemplates().find((x) => x.id === id);
    if (!t) return;
    fTitle.value = t.title || '';
    fChar.value  = t.character || '';
    fDlg.value   = t.dialogue || '';
    fBg.value    = t.background || '';
    refreshPrompt();
    hideError();
    showToast(`★ 已載入範本「${t.name}」`);
    fChar.focus();
  }

  function deleteTemplate(id) {
    const arr = getTemplates();
    const idx = arr.findIndex((x) => x.id === id);
    if (idx === -1) return;
    if (!confirm(`刪除範本「${arr[idx].name}」？`)) return;
    arr.splice(idx, 1);
    saveTemplates(arr);
    renderTemplates();
    showToast('已刪除 1 個範本');
  }

  $('btn-save-tpl').addEventListener('click', () => {
    // 必須至少有角色描述才有保存價值
    if (!fChar.value.trim()) {
      showError('「角色描述」是空的，沒有可保存的內容');
      fChar.focus();
      return;
    }
    const arr = getTemplates();
    if (arr.length >= TPL_MAX) {
      showError(`範本上限 ${TPL_MAX} 個 — 請先刪舊的再存`);
      return;
    }
    // 預設名稱：title 或 character 前 10 字
    const defaultName = (fTitle.value.trim() || fChar.value.trim().slice(0, 10) || '範本');
    const name = prompt('幫這個範本取個名字（最多 12 字）：', defaultName);
    if (!name) return;
    const cleanName = name.trim().slice(0, 12);
    if (!cleanName) return;
    arr.push({
      id: 't_' + Date.now().toString(36),
      name: cleanName,
      title: fTitle.value.trim(),
      character: fChar.value.trim(),
      dialogue: fDlg.value.trim(),
      background: fBg.value.trim(),
      ts: Date.now(),
    });
    saveTemplates(arr);
    renderTemplates();
    showToast(`★ 範本「${cleanName}」已保存（${arr.length}/${TPL_MAX}）`);
  });

  renderTemplates();

  // ===== Tweaks 面板（字型 / 配色 / 黑板深淺 / 紙張膠帶）=====
  const CHALK_PAIRINGS = [
    { id:'marker',    label:'簽字筆 Permanent Marker',  latin:'Permanent Marker',    cjk:'ZCOOL QingKe HuangYou' },
    { id:'brush',     label:'粉筆楷書 Caveat',           latin:'Caveat',              cjk:'Ma Shan Zheng' },
    { id:'flowing',   label:'飄逸草書 Reenie Beanie',    latin:'Reenie Beanie',       cjk:'Liu Jian Mao Cao' },
    { id:'print',     label:'工整手寫 Patrick Hand',     latin:'Patrick Hand',        cjk:'ZCOOL XiaoWei' },
    { id:'architect', label:'建築師 Architects Daughter',latin:'Architects Daughter', cjk:'Long Cang' },
    { id:'kid',       label:'童趣 Gochi Hand',           latin:'Gochi Hand',          cjk:'ZCOOL KuaiLe' },
    { id:'kalam',     label:'硬筆 Kalam',                latin:'Kalam',               cjk:'Ma Shan Zheng' },
    { id:'shadow',    label:'影線 Shadows Into Light',   latin:'Shadows Into Light',  cjk:'ZCOOL XiaoWei' },
  ];
  const ACCENT_COLORS = [
    { id:'yellow', hex:'#f6c560', name:'金黃' },
    { id:'pink',   hex:'#e8a3b4', name:'櫻粉' },
    { id:'blue',   hex:'#9cc4d8', name:'天藍' },
    { id:'green',  hex:'#a9d6a3', name:'草綠' },
    { id:'orange', hex:'#e07c5e', name:'橙紅' },
  ];
  const TWEAKS_KEY = 'pm-tweaks';
  const TWEAKS_DEFAULTS = {
    accent: 'yellow',
    chalkFont: 'marker',
    darkRoom: false,
    showTape: true,
  };

  function getTweaks() {
    try {
      const v = JSON.parse(localStorage.getItem(TWEAKS_KEY) || '{}');
      return { ...TWEAKS_DEFAULTS, ...v };
    } catch { return { ...TWEAKS_DEFAULTS }; }
  }
  function saveTweaks(t) {
    try { localStorage.setItem(TWEAKS_KEY, JSON.stringify(t)); }
    catch (e) { console.warn('save tweaks failed', e); }
  }

  function applyTweaks(t) {
    const root = document.documentElement;
    const ac = ACCENT_COLORS.find((x) => x.id === t.accent) || ACCENT_COLORS[0];
    root.style.setProperty('--chalk-yellow', ac.hex);
    const cp = CHALK_PAIRINGS.find((x) => x.id === t.chalkFont) || CHALK_PAIRINGS[0];
    root.style.setProperty('--font-chalk',
      `"${cp.latin}","${cp.cjk}","Noto Serif TC",cursive`);
    document.body.style.background = t.darkRoom ? '#1a1714' : '#2d2922';
    // 膠帶顯隱：插一個 inline <style> 控制
    let tapeStyle = document.getElementById('tweaks-tape-style');
    if (!tapeStyle) {
      tapeStyle = document.createElement('style');
      tapeStyle.id = 'tweaks-tape-style';
      document.head.appendChild(tapeStyle);
    }
    tapeStyle.textContent = t.showTape ? '' : '.paper::before,.paper::after{display:none}';
  }

  function renderTweaksPanel() {
    const t = getTweaks();
    // 色票
    const accentWrap = $('tweaks-accent');
    accentWrap.innerHTML = '';
    ACCENT_COLORS.forEach((c) => {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'swatch' + (c.id === t.accent ? ' active' : '');
      sw.style.background = c.hex;
      sw.title = c.name;
      sw.addEventListener('click', () => {
        const cur = getTweaks();
        cur.accent = c.id;
        saveTweaks(cur); applyTweaks(cur); renderTweaksPanel();
      });
      accentWrap.appendChild(sw);
    });
    // 字型列表
    const fontWrap = $('tweaks-chalk-font');
    fontWrap.innerHTML = '';
    CHALK_PAIRINGS.forEach((cp) => {
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'font-opt' + (cp.id === t.chalkFont ? ' active' : '');
      opt.style.fontFamily = `"${cp.latin}","${cp.cjk}","Noto Serif TC",cursive`;
      opt.innerHTML = `<span>${cp.label}</span>${cp.id === t.chalkFont ? '<span class="check">✓</span>' : ''}`;
      opt.addEventListener('click', () => {
        const cur = getTweaks();
        cur.chalkFont = cp.id;
        saveTweaks(cur); applyTweaks(cur); renderTweaksPanel();
      });
      fontWrap.appendChild(opt);
    });
    // 開關狀態
    $('tweaks-dark-room').classList.toggle('on', !!t.darkRoom);
    $('tweaks-show-tape').classList.toggle('on', !!t.showTape);
  }

  $('tweaks-dark-room').addEventListener('click', () => {
    const cur = getTweaks(); cur.darkRoom = !cur.darkRoom;
    saveTweaks(cur); applyTweaks(cur); renderTweaksPanel();
  });
  $('tweaks-show-tape').addEventListener('click', () => {
    const cur = getTweaks(); cur.showTape = !cur.showTape;
    saveTweaks(cur); applyTweaks(cur); renderTweaksPanel();
  });
  $('tweaks-reset').addEventListener('click', () => {
    if (!confirm('重置所有外觀設定為預設值？')) return;
    saveTweaks({ ...TWEAKS_DEFAULTS });
    applyTweaks({ ...TWEAKS_DEFAULTS });
    renderTweaksPanel();
    showToast('外觀已重置為預設值');
  });

  // 開合 panel
  $('tweaks-fab').addEventListener('click', () => {
    $('tweaks-backdrop').classList.add('open');
    $('tweaks-panel').classList.add('open');
    $('tweaks-panel').setAttribute('aria-hidden', 'false');
  });
  function closeTweaks() {
    $('tweaks-backdrop').classList.remove('open');
    $('tweaks-panel').classList.remove('open');
    $('tweaks-panel').setAttribute('aria-hidden', 'true');
  }
  $('tweaks-close').addEventListener('click', closeTweaks);
  $('tweaks-backdrop').addEventListener('click', closeTweaks);

  // 頁面載入：套用儲存的 tweaks + render
  applyTweaks(getTweaks());
  renderTweaksPanel();

  // ===== Keyboard Shortcuts =====
  // Ctrl/Cmd+Enter 任何欄位 → 生成
  // 1-6 → 切分類 tab（不在輸入框時）
  // L → 滾到歷史區
  // E → 清欄位
  // ← → / Esc 已在 lightbox handler 內
  document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd+Enter：任何欄位裡都能生成
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      $('btn-generate').click();
      return;
    }
    // 其餘 single-key 捷徑：在 input/textarea/contenteditable 內不觸發
    const tag = e.target.tagName;
    const inField = tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable;
    if (inField) return;
    // 修飾鍵存在時也跳過（避免 Ctrl+L、Cmd+E 等系統快捷被搶）
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    // 1-6 → 切分類 tab
    if (e.key >= '1' && e.key <= '6') {
      const idx = parseInt(e.key, 10) - 1;
      const cat = CATEGORIES[idx];
      if (cat) {
        _selectedCategory = cat.id;
        renderExamplesTabs();
        renderExamplesChips();
        renderGallery();
        showToast(`分類：${cat.em} ${cat.label}`, 900);
      }
      return;
    }
    // L → 看歷史
    if (e.key === 'l' || e.key === 'L') {
      const hist = $('history-strip');
      if (hist && hist.style.display !== 'none') {
        hist.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        showToast('尚無歷史紀錄', 1000);
      }
      return;
    }
    // E → 清欄位
    if (e.key === 'e' || e.key === 'E') {
      $('btn-clear').click();
      return;
    }
    // ? → 顯示快捷鍵清單
    if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
      showToast('⌨ Ctrl+Enter 生成 · 1-6 分類 · L 歷史 · E 清欄位 · ← → 切圖 · Esc 關', 4000);
    }
  });

  // statusbar ⌨ ? 點擊也顯示同一份提示
  $('kbd-hint')?.addEventListener('click', (e) => {
    e.preventDefault();
    showToast('⌨ Ctrl+Enter 生成 · 1-6 分類 · L 歷史 · E 清欄位 · ← → 切圖 · Esc 關', 4000);
  });

  // ===== Generate =====
  // 抽出 runGenerate(customPrompt?) — 給「生成 / 重生 / 編輯 prompt 重生」共用
  async function runGenerate(customPrompt) {
    const character = fChar.value.trim();
    // 用編輯後的 prompt 重生時放寬欄位檢查（使用者可能完全改成自由 prompt）
    if (!customPrompt && !character) {
      showError('請至少填寫「角色描述」');
      fChar.focus();
      return;
    }
    if (getQuotaUsed() >= DAILY_QUOTA) {
      showError(`今日配額已用滿（${getQuotaUsed()} / ${DAILY_QUOTA} 次）— 請明日再試`);
      return;
    }

    hideError();
    setStatus('loading');

    try {
      const prompt = customPrompt || buildPrompt();
      const fields = {
        title: fTitle.value.trim(),
        character,
        dialogue: fDlg.value.trim(),
        background: fBg.value.trim(),
      };
      const token = await waitForTurnstileToken();
      const images = await callBackend(prompt, fields, token);
      renderImages(images);
      incQuota();
      refreshQuotaUI();
      resetTurnstile();
      setStatus('ready', { count: images.length });
      const remain = Math.max(0, DAILY_QUOTA - getQuotaUsed());
      showToast(`已產 ${images.length} 張（今日剩 ${remain} 次）`);
      addToHistory(images, fields).catch((he) => console.warn('history save failed', he));
      if (window.innerWidth < 1100) elReady.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      console.error(e);
      showError(e.message || '生成失敗，請稍後再試');
      resetTurnstile();
    }
  }

  $('btn-generate').addEventListener('click', () => runGenerate());

  // 重新生成（同 4 欄位，不用重填）
  $('btn-regenerate').addEventListener('click', () => {
    showToast('用相同設定重新生成…', 1200);
    runGenerate();
  });

  // ===== Prompt 編輯模式 =====
  // _promptEditMode 已在 IIFE 頂端宣告（避免 refreshPrompt 在 init 時 TDZ）
  function setPromptEditMode(edit) {
    _promptEditMode = edit;
    promptPreview.contentEditable = edit ? 'true' : 'false';
    promptPreview.spellcheck = false;
    $('btn-edit-prompt').textContent = edit ? '✓ 完成編輯' : '✏️ 編輯';
    $('btn-regen-from-prompt').style.display = edit ? '' : 'none';
    $('btn-prompt-reset').style.display = edit ? '' : 'none';
    if (edit) {
      promptPreview.focus();
      // 把游標放到文字尾端，方便接著打
      const range = document.createRange();
      range.selectNodeContents(promptPreview);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      // 退出編輯 → 重新依表單渲染
      const p = buildPrompt();
      promptPreview.textContent = p;
      $('prompt-char-count').textContent = p.length;
    }
  }

  $('btn-edit-prompt').addEventListener('click', () => {
    setPromptEditMode(!_promptEditMode);
  });

  $('btn-prompt-reset').addEventListener('click', () => {
    // 強制依表單重渲（即使在編輯模式）
    const p = buildPrompt();
    promptPreview.textContent = p;
    $('prompt-char-count').textContent = p.length;
    showToast('已重置為表單合成的 prompt');
  });

  $('btn-regen-from-prompt').addEventListener('click', () => {
    const customPrompt = (promptPreview.textContent || '').trim();
    if (!customPrompt) {
      showError('Prompt 是空的，請編輯後再生');
      return;
    }
    // 編輯模式關掉，避免之後改欄位的 refreshPrompt 衝突
    setPromptEditMode(false);
    promptPreview.textContent = customPrompt;
    $('prompt-char-count').textContent = customPrompt.length;
    showToast('用編輯後的 prompt 生成…', 1200);
    runGenerate(customPrompt);
  });

  // ===== Lightbox =====
  const lightbox = $('lightbox');
  const lightboxImg = $('lightbox-img');
  const lightboxDl = $('lightbox-download');
  const lightboxCap = $('lightbox-caption');
  let _lightboxBlobUrl = null;
  let _lbIdx = 0;

  function openLightbox(src, downloadName, idx) {
    _lbIdx = idx || 0;
    showLightboxImage(_lbIdx);
    lightbox.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function showLightboxImage(idx) {
    if (idx < 0 || idx >= _lastImages.length) return;
    _lbIdx = idx;
    const src = _lastImages[idx];
    const dlName = makeFilename(idx);
    lightboxImg.src = src;
    lightboxDl.href = src;
    lightboxDl.download = dlName;
    lightboxCap.textContent = `ILLUSTRATION 0${idx + 1} · 1024×1024 · PNG`;
    // 左右鈕 disabled 狀態 + 只有 1 張時整組隱藏
    const multi = _lastImages.length > 1;
    $('lb-prev').style.display = multi ? '' : 'none';
    $('lb-next').style.display = multi ? '' : 'none';
    $('lb-prev').disabled = idx === 0;
    $('lb-next').disabled = idx === _lastImages.length - 1;
  }
  function nextLightboxImage() {
    if (_lbIdx < _lastImages.length - 1) showLightboxImage(_lbIdx + 1);
  }
  function prevLightboxImage() {
    if (_lbIdx > 0) showLightboxImage(_lbIdx - 1);
  }
  function closeLightbox() {
    lightbox.classList.remove('open');
    lightboxImg.src = '';
    document.body.style.overflow = '';
    if (_lightboxBlobUrl) {
      URL.revokeObjectURL(_lightboxBlobUrl);
      _lightboxBlobUrl = null;
    }
  }
  $('lightbox-close').addEventListener('click', closeLightbox);
  $('lb-prev').addEventListener('click', (e) => { e.stopPropagation(); prevLightboxImage(); });
  $('lb-next').addEventListener('click', (e) => { e.stopPropagation(); nextLightboxImage(); });
  lightbox.addEventListener('click', (e) => { if (e.target === lightbox) closeLightbox(); });
  document.addEventListener('keydown', (e) => {
    if (!lightbox.classList.contains('open')) return;
    if (e.key === 'Escape')     closeLightbox();
    else if (e.key === 'ArrowLeft')  prevLightboxImage();
    else if (e.key === 'ArrowRight') nextLightboxImage();
  });

  // 手機滑動切換
  let _touchStartX = null;
  lightbox.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) _touchStartX = e.touches[0].clientX;
  }, { passive: true });
  lightbox.addEventListener('touchend', (e) => {
    if (_touchStartX === null) return;
    const dx = (e.changedTouches[0]?.clientX || _touchStartX) - _touchStartX;
    if (Math.abs(dx) > 50) {
      if (dx > 0) prevLightboxImage();
      else nextLightboxImage();
    }
    _touchStartX = null;
  }, { passive: true });
  $('lightbox-newtab').addEventListener('click', async () => {
    // base64 data URIs are too large for window.open in most browsers — fetch to Blob URL first.
    try {
      const res = await fetch(lightboxImg.src);
      const blob = await res.blob();
      if (_lightboxBlobUrl) URL.revokeObjectURL(_lightboxBlobUrl);
      _lightboxBlobUrl = URL.createObjectURL(blob);
      window.open(_lightboxBlobUrl, '_blank', 'noopener,noreferrer');
    } catch {
      alert('開啟新分頁失敗，請改用「DOWNLOAD」儲存後在本機開');
    }
  });

  // ===== Render Images =====
  function renderImages(images) {
    _lastImages = images.slice();  // 保存供列印 / 歷史使用
    const grid = elReady;
    grid.innerHTML = '';
    images.forEach((src, i) => {
      const dlName = makeFilename(i);
      const card = document.createElement('div');
      card.className = 'img-card';
      card.innerHTML = `
        <div class="frame"><img src="${src}" alt="生成結果 ${i + 1}"></div>
        <div class="label">
          <span>ILLUSTRATION 0${i + 1}</span>
          <a href="${src}" download="${dlName}" class="dl" onclick="event.stopPropagation()">↓ PNG</a>
        </div>
      `;
      card.addEventListener('click', () => openLightbox(src, dlName, i));
      grid.appendChild(card);
    });
  }

  // ===== Backend Call =====
  async function callBackend(prompt, fields, turnstileToken) {
    if (IS_LOCAL) {
      await new Promise((r) => setTimeout(r, 1500));
      return [makeMockSVG(prompt, 1), makeMockSVG(prompt, 2)];
    }

    const backendUrl = CFG.BACKEND_URL;
    if (!backendUrl) throw new Error('後端 URL 未設定');

    const res = await fetch(backendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { prompt, fields, turnstileToken } }),
    });

    let json;
    try { json = await res.json(); }
    catch { throw new Error(`後端錯誤 ${res.status}：回應非 JSON`); }

    // 後端配額爆了（per-IP Firestore quota，整個 IP 共算，比前端 per-browser 嚴格）
    // → 前端 localStorage 同步拉到上限，按鈕立刻變灰，避免使用者繼續按
    if (res.status === 429) {
      localStorage.setItem(todayKey(), String(DAILY_QUOTA));
      refreshQuotaUI();
      const backendMsg = json?.error?.message || '配額已用滿';
      throw new Error(`本 IP 今日配額已用滿（後端記錄）— ${backendMsg}。可能因為同網路其他人也用過。`);
    }

    if (!res.ok || json.error) {
      throw new Error(json?.error?.message || `後端錯誤 ${res.status}`);
    }
    return json.result.images;
  }

  function makeMockSVG(prompt, idx) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400">
<rect width="400" height="400" fill="white"/>
<text x="200" y="50" font-family="Arial Black, sans-serif" font-size="26" font-weight="900" text-anchor="middle" fill="black">DEMO #${idx}</text>
<rect x="60" y="80" width="280" height="50" rx="25" fill="white" stroke="black" stroke-width="3"/>
<text x="200" y="112" font-family="Arial, sans-serif" font-size="16" font-weight="700" text-anchor="middle" fill="black">"Hello, World!"</text>
<path d="M 195 130 L 175 165 L 215 165 Z" fill="white" stroke="black" stroke-width="3"/>
<circle cx="200" cy="225" r="32" fill="white" stroke="black" stroke-width="4"/>
<circle cx="190" cy="220" r="3" fill="black"/>
<circle cx="210" cy="220" r="3" fill="black"/>
<path d="M 188 235 Q 200 245 212 235" fill="none" stroke="black" stroke-width="3" stroke-linecap="round"/>
<path d="M 200 257 L 200 320" stroke="black" stroke-width="4" stroke-linecap="round"/>
<path d="M 170 285 L 200 270 L 230 285" fill="none" stroke="black" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M 180 320 L 175 360" stroke="black" stroke-width="4" stroke-linecap="round"/>
<path d="M 220 320 L 225 360" stroke="black" stroke-width="4" stroke-linecap="round"/>
<text x="200" y="385" font-family="monospace" font-size="9" text-anchor="middle" fill="#999">本機預覽佔位圖 · 部署後會換成 gpt-image-2 真實生成</text>
</svg>`;
    return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
  }

  // 版本顯示 + SW 註冊已搬到 IIFE 頂端 EARLY BOOT 區
})();
