/**
 * 試卷出題配圖生成大師 - Cloud Functions
 *
 * generateImage: callable HTTP endpoint that:
 *   1. Requires Google sign-in (Bearer ID token, anonymous rejected) → 401
 *   2. Verifies Cloudflare Turnstile token (after login, before quota)
 *   3. Enforces per-user 3/day quota (Taipei date, Firestore transaction, refunded on Gemini failure)
 *   3. Calls Gemini gemini-3.1-flash-lite-image (cheapest; no pro fallback by design)
 *   4. Returns 1-2 images as data URIs (Gemini returns JPEG)
 *   5. Google Chat on every use / block / failure; admin LINE Flex card ONLY on failure
 *      (shared LINE OA, 200 msgs/month free; success & quota-exhausted are Chat-only)
 *
 * Model history:
 *   v0.2-0.3 gemini-2.5-flash-image garbled CJK → v0.4 switched to OpenAI gpt-image-2.
 *   v0.6 (2026-10) back to Gemini: gemini-3.1-flash-lite-image renders
 *   Traditional Chinese titles + speech bubbles correctly (tested 2026-10-22), and the
 *   OpenAI prepaid credits ran out. Correct Chinese rendering is non-negotiable.
 *
 * Secrets needed (set via `firebase functions:secrets:set NAME`):
 *   - GEMINI_API_KEY                       (Gemini API key, restricted to generativelanguage)
 *   - TURNSTILE_SECRET                     (Cloudflare Turnstile secret key)
 *   - PICTURE_LINE_CHANNEL_ACCESS_TOKEN    (shared LINE Bot Channel push token)
 *   - PICTURE_LINE_ADMIN_USER_ID           (LINE userId to receive admin notifications)
 *   - GOOGLE_CHAT_WEBHOOK_URL              (Google Chat room webhook; every use is reported)
 */

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { setGlobalOptions } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const crypto = require('node:crypto');

initializeApp();
const db = getFirestore();
const adminAuth = getAuth();

setGlobalOptions({
  region: 'us-central1',
  maxInstances: 5,
});

const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');
const TURNSTILE_SECRET = defineSecret('TURNSTILE_SECRET');
const PICTURE_LINE_CHANNEL_ACCESS_TOKEN = defineSecret('PICTURE_LINE_CHANNEL_ACCESS_TOKEN');
const PICTURE_LINE_ADMIN_USER_ID = defineSecret('PICTURE_LINE_ADMIN_USER_ID');

const DAILY_QUOTA = 3;
const PLACEHOLDER = 'PLACEHOLDER_NOT_CONFIGURED';
const APP_NAME = '試卷出題配圖生成大師';
// 只用最便宜的 flash-lite；不要加 pro 當備援（費用考量，使用者明確要求）
const IMAGE_MODELS = ['gemini-3.1-flash-lite-image'];
// flash-lite 會把 EXACTLY 與引號照抄進圖裡，補一句說明（2026-10-22 實測有效）
const PROMPT_SUFFIX =
  '\nIMPORTANT: The word EXACTLY and the quotation marks above only mark which text to draw. ' +
  'Do NOT draw the word "EXACTLY" and do NOT draw quotation marks in the image; draw only the text inside them.';
const IMAGE_QUALITY = '1K';
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

// 呼叫一次 Gemini 生一張圖；失敗時丟出帶 status 的 Error
async function geminiGenerateOne(apiKey, model, prompt) {
  const r = await fetch(`${GEMINI_ENDPOINT}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt + PROMPT_SUFFIX }] }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '1:1' } },
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(j?.error?.message || `Gemini HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  const cand = j.candidates?.[0];
  const img = (cand?.content?.parts || []).find((p) => p.inlineData?.data);
  if (!img) {
    const reason = cand?.finishReason || j.promptFeedback?.blockReason || 'NO_IMAGE';
    const err = new Error(`無圖回傳（${reason}），可能觸發安全過濾`);
    err.status = 400;
    err.safety = true;
    throw err;
  }
  return `data:${img.inlineData.mimeType || 'image/jpeg'};base64,${img.inlineData.data}`;
}

// 生 n 張：同一模型並行呼叫
async function geminiGenerate(apiKey, prompt, n) {
  let lastErr = null;
  for (const model of IMAGE_MODELS) {
    const settled = await Promise.allSettled(
      Array.from({ length: n }, () => geminiGenerateOne(apiKey, model, prompt))
    );
    const images = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
    if (images.length) return { images, model };
    lastErr = settled.find((s) => s.status === 'rejected')?.reason || lastErr;
    console.error('Gemini generate failed', model, lastErr?.status, lastErr?.message);
    if (lastErr?.safety) break;
  }
  throw lastErr || new Error('Gemini 無圖回傳');
}
// 2026-11-18 省錢：每次生圖固定 1 張（原本 2 張，費用依張數計，改 1 張直接減半）。
const IMAGES_PER_CALL = 1;

const ALLOWED_ORIGINS = [
  'https://cagoooo.github.io',
  'http://localhost:8000',
  'http://localhost:5000',
  'http://localhost:3000',
  'http://127.0.0.1:8000',
];

// CJK detection（同前端 buildPrompt 邏輯）— 用來標記 prompt 是否含中文/日文
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿＀-￯]/;

// 寫一筆 generation log 到 Firestore `generations` collection（fire-and-forget）
// 設計原則：絕不寫 PII（不存 prompt 內容、不存欄位文字），只存可聚合的 metadata
// 給未來 /admin 後台分析熱度 / failed rate / 同 IP 行為 / 高峰時段
async function logGeneration(entry) {
  try {
    await db.collection('generations').add({
      ts: FieldValue.serverTimestamp(),
      ...entry,
    });
  } catch (e) {
    // 紀錄失敗不該影響主流程，只在 functions log 留警告
    console.warn('generation log write failed', e?.message);
  }
}

// ──────────────────────────────────────────────────────────────────
// LINE Flex Message helper (v2 dark header, mega bubble, 4:6 flex)
// ──────────────────────────────────────────────────────────────────

const LINE_PUSH_API = 'https://api.line.me/v2/bot/message/push';

const CARD_THEMES = {
  started: { bg: '#1E40AF', sub: '#BFDBFE', icon: '🆕' }, // blue-800
  success: { bg: '#065F46', sub: '#A7F3D0', icon: '✅' }, // emerald-800
  failed:  { bg: '#991B1B', sub: '#FECACA', icon: '❌' }, // red-800
  warning: { bg: '#92400E', sub: '#FDE68A', icon: '⚠️' }, // amber-800
};

function buildFlexBubble(card) {
  const theme = CARD_THEMES[card.status];
  const now = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());

  const headerContents = [
    { type: 'text', text: theme.icon, color: '#FFFFFF', size: 'xl' },
    { type: 'text', text: card.title, color: '#FFFFFF', weight: 'bold', size: 'lg', wrap: true, margin: 'sm' },
  ];
  if (card.appName) {
    headerContents.push({ type: 'text', text: card.appName, color: theme.sub, size: 'sm', margin: 'xs' });
  }

  const bodyContents = card.fields.map((f) => {
    const row = [];
    if (f.icon) row.push({ type: 'text', text: f.icon, size: 'sm', flex: 0, color: '#64748B' });
    row.push(
      { type: 'text', text: f.label, color: '#64748B', size: 'sm', flex: f.icon ? 3 : 4, weight: 'bold' },
      { type: 'text', text: f.value || '—', color: '#0F172A', size: 'sm', flex: 6, wrap: true },
    );
    return { type: 'box', layout: 'horizontal', spacing: 'sm', contents: row };
  });

  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box', layout: 'vertical',
      backgroundColor: theme.bg, paddingAll: '16px', spacing: 'none',
      contents: headerContents,
    },
    body: {
      type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '16px',
      contents: bodyContents,
    },
    footer: {
      type: 'box', layout: 'vertical', paddingAll: '12px',
      contents: [{
        type: 'text',
        text: card.footerNote ? `${now} · ${card.footerNote}` : now,
        color: '#94A3B8', size: 'xs', align: 'end', wrap: true,
      }],
    },
  };
}

function cardToPlainText(card) {
  const theme = CARD_THEMES[card.status];
  return [
    `${theme.icon} ${card.title}`,
    card.appName ? `(${card.appName})` : '',
    '',
    ...card.fields.map((f) => `${f.icon || ''} ${f.label}：${f.value || '—'}`),
    card.footerNote ? `\n${card.footerNote}` : '',
  ].filter(Boolean).join('\n').substring(0, 4900);
}

async function notifyAdminCard(card) {
  const token = PICTURE_LINE_CHANNEL_ACCESS_TOKEN.value()?.trim();
  const userId = PICTURE_LINE_ADMIN_USER_ID.value()?.trim();
  if (!token || token === PLACEHOLDER || !userId || userId === PLACEHOLDER) return;

  const flex = buildFlexBubble(card);
  const altText = `${CARD_THEMES[card.status].icon} ${card.title}`.substring(0, 380);

  try {
    const res = await fetch(LINE_PUSH_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: userId, messages: [{ type: 'flex', altText, contents: flex }] }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.warn('[notify-line] Flex failed, fallback to text', { status: res.status, errBody: errBody.slice(0, 200) });
      // Fallback to plain text
      await fetch(LINE_PUSH_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ to: userId, messages: [{ type: 'text', text: cardToPlainText(card) }] }),
      });
    }
  } catch (err) {
    console.warn('[notify-line] push failed', { msg: err?.message });
  }
}

// ──────────────────────────────────────────────────────────────────
// Google 登入門禁 + 每人每天 3 次 + Google Chat 通知（2026-11-16）
// 順序固定：登入 → Turnstile → 扣每日次數 → Gemini（失敗退回次數）
// ──────────────────────────────────────────────────────────────────

const GOOGLE_CHAT_WEBHOOK_URL = defineSecret('GOOGLE_CHAT_WEBHOOK_URL');

class HttpError extends Error {
  constructor(status, message, kind) {
    super(message);
    this.status = status;
    this.kind = kind; // 'auth' | 'turnstile' | 'quota' | ...
  }
}

// 台北日期 YYYY-MM-DD（台北午夜重置）
function taipeiDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

async function requireGoogleUser(req) {
  const m = (req.get('Authorization') || '').match(/^Bearer (.+)$/);
  if (!m) throw new HttpError(401, '請先用 Google 帳號登入才能使用（每人每天 3 次）', 'auth');
  let decoded;
  try {
    decoded = await adminAuth.verifyIdToken(m[1]);
  } catch {
    throw new HttpError(401, '登入已過期，請重新登入', 'auth');
  }
  if (decoded.firebase?.sign_in_provider === 'anonymous') {
    throw new HttpError(401, '請先用 Google 帳號登入才能使用（每人每天 3 次）', 'auth');
  }
  return {
    uid: decoded.uid,
    email: decoded.email || '',
    name: decoded.name || decoded.email || 'Google 使用者',
  };
}

function quotaDocRef(uid, day) {
  return db.collection('rateLimits').doc(`user_${uid}_${day}`);
}

// 預扣一次；超過回 429
async function reserveQuota(user, day) {
  const ref = quotaDocRef(user.uid, day);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const count = snap.exists ? Number(snap.data().count) || 0 : 0;
    if (count >= DAILY_QUOTA) {
      throw new HttpError(429, `今天的 ${DAILY_QUOTA} 次已用完，明天（台北時間午夜後）再來`, 'quota');
    }
    tx.set(ref, {
      count: count + 1,
      uid: user.uid,
      email: user.email,
      day,
      updatedAt: FieldValue.serverTimestamp(),
      expireAt: new Date(Date.now() + 3 * 24 * 3600 * 1000),
    }, { merge: true });
    return DAILY_QUOTA - count - 1; // 今日剩餘
  });
}

// Gemini 失敗時退回次數
async function refundQuota(user, day) {
  const ref = quotaDocRef(user.uid, day);
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const count = snap.exists ? Number(snap.data().count) || 0 : 0;
      const next = Math.max(0, count - 1);
      tx.set(ref, { count: next, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return DAILY_QUOTA - next;
    });
  } catch (e) {
    console.warn('quota refund failed', e?.message);
    return null;
  }
}

async function readRemaining(user, day) {
  const snap = await quotaDocRef(user.uid, day).get();
  const count = snap.exists ? Number(snap.data().count) || 0 : 0;
  return Math.max(0, DAILY_QUOTA - count);
}

// ---- 通知內容過濾（防亂碼／防注入）----
const FEATURE_LABELS = {
  generate: '生成線稿（一般模式）',
  batch: '批次生成（CSV）',
};
// eslint-disable-next-line no-control-regex
const BAD_CHARS_RE = /[�\p{Cc}]/u;
function featureLabel(raw) {
  if (typeof raw !== 'string' || BAD_CHARS_RE.test(raw)) return '未知功能（已過濾）';
  return FEATURE_LABELS[raw] || '未知功能（已過濾）';
}
function cleanText(raw, max) {
  if (raw == null || raw === '') return '';
  const s = String(raw).replace(/[�\p{Cc}]/gu, '').replace(/[<>]/g, '').trim();
  if (!s) return '（無法辨識的文字，已過濾）';
  return s.length > max ? s.slice(0, max) + '…' : s;
}
function maskIp(ip) {
  if (!ip || ip === 'unknown') return '未知';
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + ':…';
  const p = ip.split('.');
  return p.length === 4 ? `${p[0]}.${p[1]}.x.x` : '未知';
}

// 被擋通知：同 IP 每 5 分鐘最多 1 則
async function allowBlockedNotify(ipHash) {
  const ref = db.collection('chatThrottle').doc(`ip_${ipHash}`);
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const last = snap.exists ? Number(snap.data().lastAt) || 0 : 0;
      if (Date.now() - last < 5 * 60 * 1000) return false;
      tx.set(ref, { lastAt: Date.now(), expireAt: new Date(Date.now() + 24 * 3600 * 1000) });
      return true;
    });
  } catch (e) {
    console.warn('chat throttle check failed', e?.message);
    return false;
  }
}

async function notifyChat({ icon, title, fields }) {
  const url = (GOOGLE_CHAT_WEBHOOK_URL.value() || '').trim();
  if (!url.startsWith('https://chat.googleapis.com/')) return;
  const now = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date());
  const allFields = [{ label: '網站', value: APP_NAME }, ...fields, { label: '時間（台北）', value: now }];
  const text = `${icon} ${title}\n` + allFields.map((f) => `${f.label}：${f.value}`).join('\n');
  const payload = {
    text: `${icon} ${title}（${APP_NAME}）`,
    cardsV2: [{
      cardId: 'pm-' + Date.now(),
      card: {
        header: { title: `${icon} ${title}`, subtitle: APP_NAME },
        sections: [{
          widgets: allFields.map((f) => ({
            decoratedText: { topLabel: f.label, text: String(f.value || '—'), wrapText: true },
          })),
        }],
      },
    }],
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      console.warn('[notify-gchat] card failed, fallback text', r.status);
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ text }),
      }).catch(() => {});
    }
  } catch (e) {
    console.warn('[notify-gchat] push failed', e?.message);
  } finally {
    clearTimeout(timer);
  }
}

function userLabel(user, ip) {
  return user ? `${user.name}（${user.email || '無 Email'}）` : `未登入（IP ${maskIp(ip)}）`;
}

// ──────────────────────────────────────────────────────────────────
// Main endpoint
// ──────────────────────────────────────────────────────────────────

exports.generateImage = onRequest(
  {
    cors: ALLOWED_ORIGINS,
    timeoutSeconds: 120,
    memory: '512MiB',
    maxInstances: 3,
    invoker: 'public',
    secrets: [
      GEMINI_API_KEY,
      TURNSTILE_SECRET,
      PICTURE_LINE_CHANNEL_ACCESS_TOKEN,
      PICTURE_LINE_ADMIN_USER_ID,
      GOOGLE_CHAT_WEBHOOK_URL,
    ],
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: { message: 'POST only' } });
    }

    const t0 = Date.now();
    const elapsedS = () => `${((Date.now() - t0) / 1000).toFixed(1)} 秒`;
    const payload = req.body?.data || req.body || {};
    const { prompt, turnstileToken, fields = {} } = payload;
    const { title = '', character = '', dialogue = '', background = '' } = fields;
    // 不論前端傳幾張，一律只生 IMAGES_PER_CALL 張（避免繞過網頁要求多張）
    const imagesPerCall = IMAGES_PER_CALL;
    const feature = featureLabel(payload.feature);
    const topic = cleanText(title, 30) || '（無標題）';

    const ip =
      (req.headers['x-forwarded-for'] || '').split(',')[0]?.trim() ||
      req.ip ||
      'unknown';
    const ipHash = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
    const today = taipeiDate();

    // LINE 卡片欄位（只在失敗時推 LINE；含使用者輸入摘要）
    const trim = (s, n) => (s || '').toString().substring(0, n);
    const cardFields = [
      { icon: '📌', label: '標題', value: trim(title, 40) || '（無）' },
      { icon: '👤', label: '角色', value: trim(character, 80) || '（無）' },
      { icon: '💬', label: '對話', value: trim(dialogue, 60) || '（無）' },
      { icon: '🌅', label: '背景', value: trim(background, 60) || '（無）' },
    ];

    let user = null;
    let reserved = false;
    let remaining = null;

    const blocked = async (err) => {
      const allow = await allowBlockedNotify(ipHash);
      if (!allow) {
        // 同 IP 5 分鐘內已通知過，不再洗版
      } else if (err.kind === 'quota') {
        await notifyChat({
          icon: '⛔', title: '今日次數已用完被擋',
          fields: [
            { label: '使用者', value: userLabel(user, ip) },
            { label: '功能', value: feature },
            { label: '今日剩餘', value: '0 次' },
          ],
        });
      } else {
        await notifyChat({
          icon: '⚠️', title: '被擋下的呼叫',
          fields: [
            { label: '使用者', value: userLabel(user, ip) },
            { label: '功能', value: feature },
            { label: '原因', value: err.message },
            { label: '耗時', value: elapsedS() },
          ],
        });
      }
      return res.status(err.status).json({ error: { message: err.message } });
    };

    try {
      // 1. Google 登入（拒絕匿名）
      user = await requireGoogleUser(req);

      // 只查今日剩餘（登入後前端顯示用；不扣次、不發通知）
      if (payload.action === 'quota') {
        const left = await readRemaining(user, today);
        return res.json({ result: { remaining: left, limit: DAILY_QUOTA } });
      }

      if (!prompt || typeof prompt !== 'string') {
        return res.status(400).json({ error: { message: 'prompt 必填且需為字串' } });
      }
      if (prompt.length > 3000) {
        return res.status(400).json({ error: { message: 'prompt 長度超過 3000 字' } });
      }

      // 2. Turnstile（登入之後、扣次之前）
      const turnstileSecret = TURNSTILE_SECRET.value();
      if (turnstileSecret && turnstileSecret !== PLACEHOLDER) {
        if (!turnstileToken) {
          throw new HttpError(403, '請完成人機驗證後再試', 'turnstile');
        }
        let verifyJson;
        try {
          const verifyRes = await fetch(
            'https://challenges.cloudflare.com/turnstile/v0/siteverify',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ secret: turnstileSecret, response: turnstileToken, remoteip: ip }),
            }
          );
          verifyJson = await verifyRes.json();
        } catch (e) {
          console.error('Turnstile API error', e);
          return res.status(503).json({ error: { message: '人機驗證服務暫時無法連線，請稍後再試' } });
        }
        if (!verifyJson.success) {
          console.warn('Turnstile failed', verifyJson['error-codes']);
          throw new HttpError(403, '人機驗證失敗，請重整頁面再試', 'turnstile');
        }
      }

      // 3. 扣每日次數（transaction，台北日期）
      try {
        remaining = await reserveQuota(user, today);
        reserved = true;
      } catch (e) {
        // 額度用完只發 Google Chat（由 blocked() 處理），不推 LINE：
        // 所有網站共用同一個 LINE 官方帳號，每月 200 則留給錯誤告警
        throw e;
      }

      // 4. Gemini
      const apiKey = GEMINI_API_KEY.value();
      if (!apiKey || apiKey === PLACEHOLDER) {
        throw new Error('GEMINI_API_KEY 未設定，請聯絡管理員');
      }

      let images = [];
      let usedModel = IMAGE_MODELS[0];
      let genErr = null;
      try {
        const out = await geminiGenerate(apiKey, prompt, imagesPerCall);
        images = out.images;
        usedModel = out.model;
      } catch (e) {
        genErr = e;
      }

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

      if (!images.length) {
        const errMsg = genErr?.message || '無圖回傳，可能觸發安全過濾或內容政策';
        const errStatus = genErr?.status || 502;
        const left = await refundQuota(user, today);
        reserved = false;
        if (left != null) remaining = left;
        await notifyAdminCard({
          status: 'failed',
          title: '圖像生成失敗',
          appName: APP_NAME,
          fields: [
            ...cardFields,
            { icon: '🤖', label: '模型', value: usedModel },
            { icon: '💥', label: '錯誤', value: trim(errMsg, 200) },
            { icon: '🚦', label: 'HTTP', value: String(errStatus) },
          ],
          footerNote: `⏱️ ${elapsed}s`,
        });
        await notifyChat({
          icon: '❌', title: `${APP_NAME} 生成失敗`,
          fields: [
            { label: '使用者', value: userLabel(user, ip) },
            { label: '功能', value: feature },
            { label: '標題', value: topic },
            { label: '錯誤', value: cleanText(errMsg, 120) || '—' },
            { label: '耗時', value: elapsedS() },
            { label: '今日剩餘', value: remaining != null ? `${remaining} 次（失敗已退回）` : '未知' },
          ],
        });
        let userMsg = '圖像生成失敗，可能 prompt 觸發內容政策。請調整角色 / 對話描述後重試（這次不扣次數）。';
        if (errStatus === 429) userMsg = '生圖服務暫時太忙，請稍候再試（這次不扣次數）。';
        else if (errStatus === 401 || errStatus === 403) userMsg = '伺服器設定錯誤（Gemini API key 無效），請聯絡管理員。';
        else if (genErr?.safety) userMsg = '描述觸發安全過濾，請改寫角色 / 對話內容（這次不扣次數）。';
        logGeneration({
          status: 'failed',
          ipHash,
          uid: user.uid,
          email: user.email || null,
          model: usedModel,
          promptLen: prompt.length,
          hasCJK: CJK_RE.test(prompt),
          errStatus: Number(errStatus) || 500,
          errMsg: (errMsg || '').slice(0, 200),
          elapsedMs: Date.now() - t0,
          dayKey: today,
        });
        return res.status(errStatus === 502 ? 502 : 500).json({ error: { message: userMsg }, remaining });
      }

      logGeneration({
        status: 'success',
        ipHash,
        uid: user.uid,
        email: user.email || null,
        model: usedModel,
        quality: IMAGE_QUALITY,
        imageCount: images.length,
        promptLen: prompt.length,
        hasCJK: CJK_RE.test(prompt),
        fieldsFilled: {
          title: !!title,
          character: !!character,
          dialogue: !!dialogue,
          background: !!background,
        },
        charLen: (character || '').length,
        elapsedMs: Date.now() - t0,
        dayKey: today,
      });

      // 成功只發 Google Chat，不推 LINE（LINE 月額度 200 則留給失敗告警）
      await notifyChat({
        icon: '✅', title: `有人使用了 ${APP_NAME}`,
        fields: [
          { label: '使用者', value: userLabel(user, ip) },
          { label: '功能', value: feature },
          { label: '標題', value: topic },
          { label: '張數', value: `${images.length} 張` },
          { label: '耗時', value: elapsedS() },
          { label: '今日剩餘', value: `${remaining} 次` },
        ],
      });

      return res.json({ result: { images, remaining } });
    } catch (e) {
      if (e instanceof HttpError) return blocked(e);
      console.error('generateImage uncaught error', e);
      const msg = e?.message || '未知錯誤';
      if (reserved && user) {
        const left = await refundQuota(user, today);
        if (left != null) remaining = left;
      }
      try {
        await notifyAdminCard({
          status: 'failed',
          title: '伺服器例外',
          appName: APP_NAME,
          fields: [...cardFields, { icon: '💥', label: '例外', value: trim(msg, 250) }],
          footerNote: `⏱️ ${elapsedS()}`,
        });
      } catch {}
      await notifyChat({
        icon: '❌', title: `${APP_NAME} 失敗（伺服器例外）`,
        fields: [
          { label: '使用者', value: userLabel(user, ip) },
          { label: '功能', value: feature },
          { label: '標題', value: topic },
          { label: '錯誤', value: cleanText(msg, 120) || '—' },
          { label: '耗時', value: elapsedS() },
          { label: '今日剩餘', value: remaining != null ? `${remaining} 次` : '未知' },
        ],
      });
      return res.status(500).json({ error: { message: `生成失敗：${msg}` }, remaining });
    }
  }
);
