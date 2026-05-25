/**
 * 試卷出題配圖生成大師 - Cloud Functions
 *
 * generateImage: callable HTTP endpoint that:
 *   1. Verifies Cloudflare Turnstile token (fail-open if secret unset, fail-closed on CF API error)
 *   2. Enforces per-IP per-day quota via Firestore
 *   3. Calls OpenAI gpt-image-2 (Apr 2026, ~99% typography accuracy for CJK) via openai SDK
 *   4. Returns 2 PNG images as data URIs
 *   5. Pushes admin LINE Flex card on started / success / failed (best-effort, fail-open)
 *
 * Why OpenAI gpt-image-2 over Imagen 4 / Nano Banana:
 *   Imagen 4 + Gemini 2.5 Flash Image both produce garbled CJK glyphs (Japanese
 *   katakana / Cyrillic substitutions, made-up "characters") even with explicit
 *   "render Chinese exactly" prompts. gpt-image-2 has near-perfect typography
 *   including CJK / Hindi / Bengali. For an exam-illustration tool aimed at
 *   Taiwanese teachers, correct Chinese rendering is non-negotiable.
 *
 * Secrets needed (set via `firebase functions:secrets:set NAME`):
 *   - OPENAI_API_KEY                       (OpenAI API access for gpt-image-2)
 *   - TURNSTILE_SECRET                     (Cloudflare Turnstile secret key)
 *   - PICTURE_LINE_CHANNEL_ACCESS_TOKEN    (shared LINE Bot Channel push token)
 *   - PICTURE_LINE_ADMIN_USER_ID           (LINE userId to receive admin notifications)
 */

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { setGlobalOptions } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const OpenAI = require('openai');
const crypto = require('node:crypto');

initializeApp();
const db = getFirestore();

setGlobalOptions({
  region: 'us-central1',
  maxInstances: 5,
});

const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');
const TURNSTILE_SECRET = defineSecret('TURNSTILE_SECRET');
const PICTURE_LINE_CHANNEL_ACCESS_TOKEN = defineSecret('PICTURE_LINE_CHANNEL_ACCESS_TOKEN');
const PICTURE_LINE_ADMIN_USER_ID = defineSecret('PICTURE_LINE_ADMIN_USER_ID');

const DAILY_QUOTA = 5;
const PLACEHOLDER = 'PLACEHOLDER_NOT_CONFIGURED';
const APP_NAME = '試卷出題配圖生成大師';
const IMAGE_MODEL = 'gpt-image-2';
const IMAGE_QUALITY = 'medium'; // ~$0.04-0.08/img at 1024x1024
const IMAGE_SIZE = '1024x1024';
const IMAGES_PER_CALL = 2;

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
// Main endpoint
// ──────────────────────────────────────────────────────────────────

exports.generateImage = onRequest(
  {
    cors: ALLOWED_ORIGINS,
    timeoutSeconds: 120,
    memory: '512MiB',
    secrets: [
      OPENAI_API_KEY,
      TURNSTILE_SECRET,
      PICTURE_LINE_CHANNEL_ACCESS_TOKEN,
      PICTURE_LINE_ADMIN_USER_ID,
    ],
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: { message: 'POST only' } });
    }

    const t0 = Date.now();
    const payload = req.body?.data || req.body || {};
    const { prompt, turnstileToken, fields = {} } = payload;
    const { title = '', character = '', dialogue = '', background = '' } = fields;
    // n: 每次生幾張（1 或 2）。批次模式用 1 省配額（每行 1 圖而非 2 圖），
    // 一般模式維持預設 2（每 prompt 提供 2 個變體讓老師挑）
    const reqN = Number(payload.n);
    const imagesPerCall = (reqN === 1 || reqN === 2) ? reqN : IMAGES_PER_CALL;

    // Snapshot for LINE cards (truncated for readability)
    const trim = (s, n) => (s || '').toString().substring(0, n);
    const cardFields = [
      { icon: '📌', label: '標題', value: trim(title, 40) || '（無）' },
      { icon: '👤', label: '角色', value: trim(character, 80) || '（無）' },
      { icon: '💬', label: '對話', value: trim(dialogue, 60) || '（無）' },
      { icon: '🌅', label: '背景', value: trim(background, 60) || '（無）' },
    ];

    try {
      if (!prompt || typeof prompt !== 'string') {
        return res.status(400).json({ error: { message: 'prompt 必填且需為字串' } });
      }
      if (prompt.length > 3000) {
        return res.status(400).json({ error: { message: 'prompt 長度超過 3000 字' } });
      }

      // Caller IP
      const ip =
        (req.headers['x-forwarded-for'] || '').split(',')[0]?.trim() ||
        req.ip ||
        'unknown';
      const ipHash = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);

      // NOTE: No "started" notification — wastes LINE monthly push quota (200-500 free).
      // Admin learns nothing actionable from "user clicked generate" that they don't
      // already learn from the imminent success / failure card 15-30s later.

      // Turnstile verification
      const turnstileSecret = TURNSTILE_SECRET.value();
      if (turnstileSecret && turnstileSecret !== PLACEHOLDER) {
        if (!turnstileToken) {
          return res.status(400).json({ error: { message: '請完成人機驗證後再試' } });
        }
        try {
          const verifyRes = await fetch(
            'https://challenges.cloudflare.com/turnstile/v0/siteverify',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                secret: turnstileSecret,
                response: turnstileToken,
                remoteip: ip,
              }),
            }
          );
          const verifyJson = await verifyRes.json();
          if (!verifyJson.success) {
            console.warn('Turnstile failed', verifyJson['error-codes']);
            return res.status(403).json({ error: { message: '人機驗證失敗，請重整頁面再試' } });
          }
        } catch (e) {
          console.error('Turnstile API error', e);
          return res.status(503).json({ error: { message: '人機驗證服務暫時無法連線，請稍後再試' } });
        }
      }

      // Rate limit
      const today = new Date().toISOString().slice(0, 10);
      const quotaRef = db.collection('quota').doc(`${today}_${ipHash}`);
      const snap = await quotaRef.get();
      const used = snap.exists ? snap.data().count || 0 : 0;
      if (used >= DAILY_QUOTA) {
        await notifyAdminCard({
          status: 'warning',
          title: '使用者額度已用完',
          appName: APP_NAME,
          fields: [
            { icon: '🔑', label: 'IP', value: ipHash },
            { icon: '📊', label: '今日', value: `${used} / ${DAILY_QUOTA}` },
          ],
        });
        return res.status(429).json({
          error: { message: `今日 ${DAILY_QUOTA} 次額度已用完，請明日再試` },
        });
      }

      // Call OpenAI gpt-image-2 (near-perfect CJK text rendering)
      const apiKey = OPENAI_API_KEY.value();
      if (!apiKey || apiKey === PLACEHOLDER) {
        return res.status(500).json({ error: { message: 'OPENAI_API_KEY 未設定，請聯絡管理員' } });
      }

      const openai = new OpenAI({ apiKey });

      let images = [];
      let openaiErr = null;
      try {
        const result = await openai.images.generate({
          model: IMAGE_MODEL,
          prompt,
          n: imagesPerCall,
          size: IMAGE_SIZE,
          quality: IMAGE_QUALITY,
          output_format: 'png',
          background: 'opaque',
        });
        images = (result.data || [])
          .filter((d) => d.b64_json)
          .map((d) => `data:image/png;base64,${d.b64_json}`);
      } catch (e) {
        openaiErr = e;
        console.error('OpenAI images.generate failed', e?.status, e?.message);
      }

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

      if (!images.length) {
        const errMsg = openaiErr?.message || '無圖回傳，可能觸發安全過濾或內容政策';
        const errStatus = openaiErr?.status || 502;
        await notifyAdminCard({
          status: 'failed',
          title: '圖像生成失敗',
          appName: APP_NAME,
          fields: [
            ...cardFields,
            { icon: '🤖', label: '模型', value: IMAGE_MODEL },
            { icon: '💥', label: '錯誤', value: trim(errMsg, 200) },
            { icon: '🚦', label: 'HTTP', value: String(errStatus) },
          ],
          footerNote: `⏱️ ${elapsed}s`,
        });
        // User-friendly message based on common OpenAI errors
        let userMsg = '圖像生成失敗，可能 prompt 觸發內容政策。請調整角色 / 對話描述後重試。';
        if (errStatus === 429) userMsg = 'OpenAI 額度暫時用完或頻率太高，請稍候再試。';
        else if (errStatus === 401 || errStatus === 403) userMsg = '伺服器設定錯誤（OpenAI API key 無效），請聯絡管理員。';
        else if (errStatus === 400 && /safety|content_policy/i.test(errMsg)) userMsg = '描述觸發 OpenAI 安全過濾，請改寫角色 / 對話內容。';
        // 記錄失敗事件供 admin 後台分析（hashed IP，無 PII）
        logGeneration({
          status: 'failed',
          ipHash,
          model: IMAGE_MODEL,
          promptLen: prompt.length,
          hasCJK: CJK_RE.test(prompt),
          errStatus: Number(errStatus) || 500,
          errMsg: (errMsg || '').slice(0, 200),
          elapsedMs: Date.now() - t0,
          dayKey: today,
        });
        return res.status(errStatus === 502 ? 502 : 500).json({ error: { message: userMsg } });
      }

      // Increment quota only after successful generation
      await quotaRef.set(
        {
          count: FieldValue.increment(1),
          ipHash,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      // 記錄成功事件供 admin 後台分析熱度 / 高峰時段 / 字段填寫率
      logGeneration({
        status: 'success',
        ipHash,
        model: IMAGE_MODEL,
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

      // Push success card (await to ensure delivery before response closes function context)
      await notifyAdminCard({
        status: 'success',
        title: '生成成功',
        appName: APP_NAME,
        fields: [
          ...cardFields,
          { icon: '🤖', label: '模型', value: `${IMAGE_MODEL} (${IMAGE_QUALITY})` },
          { icon: '🖼️', label: '張數', value: `${images.length} 張` },
          { icon: '📊', label: '今日', value: `${used + 1} / ${DAILY_QUOTA}` },
        ],
        footerNote: `⏱️ ${elapsed}s`,
      });

      return res.json({
        result: {
          images,
          remaining: DAILY_QUOTA - used - 1,
        },
      });
    } catch (e) {
      console.error('generateImage uncaught error', e);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const msg = e?.message || '未知錯誤';
      // Best-effort notify, never let notify error mask the original
      try {
        await notifyAdminCard({
          status: 'failed',
          title: '伺服器例外',
          appName: APP_NAME,
          fields: [
            ...cardFields,
            { icon: '💥', label: '例外', value: trim(msg, 250) },
          ],
          footerNote: `⏱️ ${elapsed}s`,
        });
      } catch {}
      return res.status(500).json({ error: { message: `生成失敗：${msg}` } });
    }
  }
);
