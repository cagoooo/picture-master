/**
 * 試卷出題配圖生成大師 - Cloud Functions
 *
 * generateImage: callable HTTP endpoint that:
 *   1. Verifies Cloudflare Turnstile token (fail-open if secret unset, fail-closed on CF API error)
 *   2. Enforces per-IP per-day quota via Firestore
 *   3. Calls Gemini 2.5 Flash Image (Nano Banana) via @google/genai SDK — better CJK rendering
 *   4. Returns 2 PNG images as data URIs (parallel calls, 1 image each)
 *   5. Pushes admin LINE Flex card on started / success / failed (best-effort, fail-open)
 *
 * Secrets needed (set via `firebase functions:secrets:set NAME`):
 *   - GEMINI_API_KEY                       (Imagen API access, restricted key from gcloud)
 *   - TURNSTILE_SECRET                     (Cloudflare Turnstile secret key)
 *   - PICTURE_LINE_CHANNEL_ACCESS_TOKEN    (shared LINE Bot Channel push token)
 *   - PICTURE_LINE_ADMIN_USER_ID           (LINE userId to receive admin notifications)
 */

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { setGlobalOptions } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { GoogleGenAI } = require('@google/genai');
const crypto = require('node:crypto');

initializeApp();
const db = getFirestore();

setGlobalOptions({
  region: 'us-central1',
  maxInstances: 5,
});

const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');
const TURNSTILE_SECRET = defineSecret('TURNSTILE_SECRET');
const PICTURE_LINE_CHANNEL_ACCESS_TOKEN = defineSecret('PICTURE_LINE_CHANNEL_ACCESS_TOKEN');
const PICTURE_LINE_ADMIN_USER_ID = defineSecret('PICTURE_LINE_ADMIN_USER_ID');

const DAILY_QUOTA = 5;
const PLACEHOLDER = 'PLACEHOLDER_NOT_CONFIGURED';
const APP_NAME = '試卷出題配圖生成大師';

const ALLOWED_ORIGINS = [
  'https://cagoooo.github.io',
  'http://localhost:8000',
  'http://localhost:5000',
  'http://localhost:3000',
  'http://127.0.0.1:8000',
];

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
      GEMINI_API_KEY,
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

      // Fire-and-forget "started" notification (parallel with main work)
      const startedNotify = notifyAdminCard({
        status: 'started',
        title: '使用者開始生成插畫',
        appName: APP_NAME,
        fields: [
          ...cardFields,
          { icon: '🔑', label: 'IP', value: ipHash },
        ],
      });

      // Turnstile verification
      const turnstileSecret = TURNSTILE_SECRET.value();
      if (turnstileSecret && turnstileSecret !== PLACEHOLDER) {
        if (!turnstileToken) {
          await Promise.allSettled([startedNotify]);
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
            await Promise.allSettled([startedNotify]);
            return res.status(403).json({ error: { message: '人機驗證失敗，請重整頁面再試' } });
          }
        } catch (e) {
          console.error('Turnstile API error', e);
          await Promise.allSettled([startedNotify]);
          return res.status(503).json({ error: { message: '人機驗證服務暫時無法連線，請稍後再試' } });
        }
      }

      // Rate limit
      const today = new Date().toISOString().slice(0, 10);
      const quotaRef = db.collection('quota').doc(`${today}_${ipHash}`);
      const snap = await quotaRef.get();
      const used = snap.exists ? snap.data().count || 0 : 0;
      if (used >= DAILY_QUOTA) {
        await Promise.allSettled([
          startedNotify,
          notifyAdminCard({
            status: 'warning',
            title: '使用者額度已用完',
            appName: APP_NAME,
            fields: [
              { icon: '🔑', label: 'IP', value: ipHash },
              { icon: '📊', label: '今日', value: `${used} / ${DAILY_QUOTA}` },
            ],
          }),
        ]);
        return res.status(429).json({
          error: { message: `今日 ${DAILY_QUOTA} 次額度已用完，請明日再試` },
        });
      }

      // Call Gemini Nano Banana
      const apiKey = GEMINI_API_KEY.value();
      if (!apiKey || apiKey === PLACEHOLDER) {
        await Promise.allSettled([startedNotify]);
        return res.status(500).json({ error: { message: 'GEMINI_API_KEY 未設定，請聯絡管理員' } });
      }

      const ai = new GoogleGenAI({ apiKey });
      const callOnce = async () => {
        const out = await ai.models.generateContent({
          model: 'gemini-2.5-flash-image',
          contents: prompt,
        });
        const parts = out?.candidates?.[0]?.content?.parts || [];
        for (const p of parts) {
          if (p.inlineData?.data) {
            const mime = p.inlineData.mimeType || 'image/png';
            return `data:${mime};base64,${p.inlineData.data}`;
          }
        }
        return null;
      };

      const settled = await Promise.allSettled([callOnce(), callOnce()]);
      const images = settled
        .filter((r) => r.status === 'fulfilled' && r.value)
        .map((r) => r.value);

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

      if (!images.length) {
        const firstReason = settled.find((r) => r.status === 'rejected')?.reason;
        const errMsg = firstReason?.message || '無圖回傳，可能觸發安全過濾';
        console.warn('Nano Banana returned no images', firstReason);
        await Promise.allSettled([
          startedNotify,
          notifyAdminCard({
            status: 'failed',
            title: '圖像生成失敗',
            appName: APP_NAME,
            fields: [
              ...cardFields,
              { icon: '💥', label: '錯誤', value: trim(errMsg, 200) },
            ],
            footerNote: `⏱️ ${elapsed}s`,
          }),
        ]);
        return res.status(502).json({
          error: {
            message: '圖像生成失敗，可能 prompt 觸發安全過濾。請調整角色 / 對話描述後重試。',
          },
        });
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

      // Push success card (await to ensure delivery before response closes function context)
      await Promise.allSettled([
        startedNotify,
        notifyAdminCard({
          status: 'success',
          title: '生成成功',
          appName: APP_NAME,
          fields: [
            ...cardFields,
            { icon: '🖼️', label: '張數', value: `${images.length} 張` },
            { icon: '📊', label: '今日', value: `${used + 1} / ${DAILY_QUOTA}` },
          ],
          footerNote: `⏱️ ${elapsed}s`,
        }),
      ]);

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
