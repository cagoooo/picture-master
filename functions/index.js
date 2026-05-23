/**
 * 試卷出題配圖生成大師 - Cloud Functions
 *
 * generateImage: callable HTTP endpoint that:
 *   1. Verifies Cloudflare Turnstile token (fail-open if secret unset, fail-closed on CF API error)
 *   2. Enforces per-IP per-day quota via Firestore
 *   3. Calls Google Imagen 4 via @google/genai SDK
 *   4. Returns 2 PNG images as data URIs
 *
 * Secrets needed (set via `firebase functions:secrets:set NAME`):
 *   - GEMINI_API_KEY (Imagen API access, restricted key from gcloud)
 *   - TURNSTILE_SECRET (Cloudflare Turnstile secret key)
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

const DAILY_QUOTA = 30;
const PLACEHOLDER = 'PLACEHOLDER_NOT_CONFIGURED';

const ALLOWED_ORIGINS = [
  'https://cagoooo.github.io',
  'http://localhost:8000',
  'http://localhost:5000',
  'http://localhost:3000',
  'http://127.0.0.1:8000',
];

exports.generateImage = onRequest(
  {
    cors: ALLOWED_ORIGINS,
    timeoutSeconds: 120,
    memory: '512MiB',
    secrets: [GEMINI_API_KEY, TURNSTILE_SECRET],
  },
  async (req, res) => {
    // Preflight handled by cors option
    if (req.method !== 'POST') {
      return res.status(405).json({ error: { message: 'POST only' } });
    }

    try {
      const payload = req.body?.data || req.body || {};
      const { prompt, turnstileToken } = payload;

      if (!prompt || typeof prompt !== 'string') {
        return res.status(400).json({ error: { message: 'prompt 必填且需為字串' } });
      }
      if (prompt.length > 3000) {
        return res.status(400).json({ error: { message: 'prompt 長度超過 3000 字' } });
      }

      // 1. Caller IP (Cloud Run/Functions v2 puts real IP in x-forwarded-for)
      const ip =
        (req.headers['x-forwarded-for'] || '')
          .split(',')[0]
          ?.trim() ||
        req.ip ||
        'unknown';
      const ipHash = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);

      // 2. Turnstile verification
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
          // Fail-closed: CF API down → reject (don't let bots bypass on outage)
          console.error('Turnstile API error', e);
          return res
            .status(503)
            .json({ error: { message: '人機驗證服務暫時無法連線，請稍後再試' } });
        }
      } else {
        console.warn('TURNSTILE_SECRET not configured — running in fail-open mode');
      }

      // 3. Rate limit (per IP per day)
      const today = new Date().toISOString().slice(0, 10);
      const quotaRef = db.collection('quota').doc(`${today}_${ipHash}`);
      const snap = await quotaRef.get();
      const used = snap.exists ? snap.data().count || 0 : 0;
      if (used >= DAILY_QUOTA) {
        return res.status(429).json({
          error: { message: `今日 ${DAILY_QUOTA} 次額度已用完，請明日再試` },
        });
      }

      // 4. Call Imagen 4
      const apiKey = GEMINI_API_KEY.value();
      if (!apiKey || apiKey === PLACEHOLDER) {
        return res
          .status(500)
          .json({ error: { message: 'GEMINI_API_KEY 未設定，請聯絡管理員' } });
      }

      const ai = new GoogleGenAI({ apiKey });
      const genResult = await ai.models.generateImages({
        model: 'imagen-4.0-generate-001',
        prompt,
        config: {
          numberOfImages: 2,
          aspectRatio: '1:1',
          personGeneration: 'allow_all',
        },
      });

      const images = (genResult.generatedImages || []).map(
        (g) => `data:image/png;base64,${g.image.imageBytes}`
      );

      if (!images.length) {
        return res.status(502).json({
          error: {
            message:
              'Imagen 未回傳圖片，可能 prompt 觸發安全過濾。請調整角色 / 對話描述後重試。',
          },
        });
      }

      // 5. Increment quota only after successful generation
      await quotaRef.set(
        {
          count: FieldValue.increment(1),
          ipHash,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return res.json({
        result: {
          images,
          remaining: DAILY_QUOTA - used - 1,
        },
      });
    } catch (e) {
      console.error('generateImage uncaught error', e);
      const msg = e?.message || '未知錯誤';
      return res.status(500).json({ error: { message: `生成失敗：${msg}` } });
    }
  }
);
