/**
 * WhatsApp Client Singleton -- whatsapp-web.js
 * Manages QR code generation, persistent session, and message sending.
 *
 * KEY FIXES (v2):
 *  1. isRestarting flag -- ONLY released inside 'ready' or error handlers,
 *     NOT prematurely at end of initWhatsApp(). Prevents duplicate inits.
 *  2. webVersionCache LOCAL mode -- no GitHub fetch on every restart that
 *     can fail or pull an incompatible version. Uses bundled wa-web version.
 *  3. Heartbeat every 10 minutes (was 25) -- catches disconnects sooner.
 *     On getState() failure -> immediate reconnect (was just a warning).
 *  4. SESSION_PATH uses env var WA_SESSION_PATH for Docker volume support.
 *     Map /app/wa-session in docker-compose to persist across container rebuilds.
 *  5. QR expiry: auto-restart after 60s if QR not scanned, to get fresh QR.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');

// --------- state -------------------------------------------------------------
let client            = null;
let qrDataUrl         = null;          // base64 PNG of current QR
let status            = 'disconnected'; // 'disconnected' | 'qr' | 'loading' | 'ready'
let heartbeatTimer    = null;           // keeps WS connection alive
let reconnectTimer    = null;           // scheduled re-init
let qrExpiryTimer     = null;           // restart if QR not scanned in time
let reconnectAttempts = 0;              // for exponential back-off
let isRestarting      = false;          // guard against concurrent inits

// FIX 4: Use env var so Docker volume can persist session across container rebuilds
const SESSION_PATH = process.env.WA_SESSION_PATH || path.join(__dirname, 'wa-session');

// --------- getters -----------------------------------------------------------
function getClient() { return client; }
function getStatus() { return status; }
function getQR()     { return qrDataUrl; }

// --------- helpers -----------------------------------------------------------
function clearHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function clearQrExpiryTimer() {
  if (qrExpiryTimer) {
    clearTimeout(qrExpiryTimer);
    qrExpiryTimer = null;
  }
}

// FIX 3: Heartbeat every 10 minutes (was 25). On failure -> immediate reconnect.
function startHeartbeat() {
  clearHeartbeat();
  heartbeatTimer = setInterval(async () => {
    if (!client || status !== 'ready') return;
    try {
      const state = await client.getState();
      console.log('[WhatsApp] heartbeat -- state: ' + state);
      if (state !== 'CONNECTED') {
        console.warn('[WhatsApp] Heartbeat: non-CONNECTED state. Reconnecting...');
        await safeDestroy();
        scheduleReconnect(3000);
      }
    } catch (err) {
      // FIX 3: getState() threw -> connection is dead, force reconnect immediately
      console.warn('[WhatsApp] Heartbeat getState() failed -- forcing reconnect:', err.message);
      await safeDestroy();
      scheduleReconnect(5000);
    }
  }, 10 * 60 * 1000); // every 10 minutes
}

function cleanSessionFolder(wipe = false) {
  const sessionPath = path.join(SESSION_PATH, 'session-bot');
  if (!fs.existsSync(sessionPath)) return;

  try {
    if (wipe) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      console.log('[WhatsApp] Session wiped.');
    } else {
      const lockFiles = [
        path.join(sessionPath, 'Default', 'SingletonLock'),
        path.join(sessionPath, 'Default', 'SingletonCookie'),
        path.join(sessionPath, 'SingletonLock'),
        path.join(sessionPath, '.org.chromium.Chromium'),
      ];
      for (const f of lockFiles) {
        if (fs.existsSync(f)) {
          try { fs.unlinkSync(f); } catch {}
        }
      }
      console.log('[WhatsApp] Browser lock files cleared (session preserved).');
    }
  } catch (err) {
    console.error('[WhatsApp] Error cleaning session:', err.message);
  }
}

async function safeDestroy() {
  clearHeartbeat();
  clearQrExpiryTimer();
  if (client) {
    const c = client;
    client = null;
    try { await c.destroy(); } catch {}
  }
}

function scheduleReconnect(forceDelayMs = null) {
  if (isRestarting) return;
  clearReconnectTimer();

  reconnectAttempts++;
  const delay = forceDelayMs !== null
    ? forceDelayMs
    : Math.min(5000 * Math.pow(2, reconnectAttempts - 1), 60000);

  console.log('[WhatsApp] Reconnect in ' + (delay / 1000) + 's (attempt #' + reconnectAttempts + ')');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    initWhatsApp();
  }, delay);
}

// --------- main init ---------------------------------------------------------
function initWhatsApp() {
  // FIX 1: Guard stays true until 'ready' fires -- no premature release
  if (isRestarting) {
    console.log('[WhatsApp] Already restarting -- skipping duplicate call.');
    return;
  }
  if (client) {
    console.log('[WhatsApp] Client already exists -- skipping init.');
    return;
  }

  isRestarting = true;
  console.log('[WhatsApp] Initialising client...');
  status = 'loading';

  cleanSessionFolder(false);

  client = new Client({
    authStrategy: new LocalAuth({
      clientId: 'bot',
      dataPath: SESSION_PATH,
    }),
    // FIX 2: LOCAL webVersionCache -- no GitHub fetch on every restart
    // Uses the WA Web version bundled with whatsapp-web.js package (stable)
    webVersionCache: {
      type: 'local',
    },
    takeoverOnConflict: true,
    takeoverTimeoutMs: 10000,
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-extensions',
        '--disable-software-rasterizer',
        '--disable-features=CalculateNativeWinOcclusion',
        '--enable-features=NetworkService,NetworkServiceInProcess',
        '--disable-infobars',
        '--window-size=1280,800',
        '--disable-component-update',
        '--memory-pressure-off',
      ],
      timeout: 120000,
    },
  });

  // QR
  client.on('qr', async (qr) => {
    console.log('[WhatsApp] QR code received -- waiting for scan...');
    status = 'qr';
    try {
      qrDataUrl = await qrcode.toDataURL(qr, { scale: 6, color: { dark: '#000000', light: '#ffffff' } });
    } catch (e) {
      console.error('[WhatsApp] Failed to generate QR image:', e);
    }

    // FIX 5: QR expires after 60s -- restart to get a fresh QR code
    clearQrExpiryTimer();
    qrExpiryTimer = setTimeout(async () => {
      if (status === 'qr') {
        console.warn('[WhatsApp] QR expired (not scanned). Restarting for fresh QR...');
        isRestarting = false;
        await safeDestroy();
        scheduleReconnect(2000);
      }
    }, 60 * 1000);
  });

  // Loading screen
  client.on('loading_screen', (percent) => {
    status = 'loading';
    clearQrExpiryTimer();
    console.log('[WhatsApp] Loading... ' + percent + '%');
  });

  // Authenticated
  client.on('authenticated', () => {
    console.log('[WhatsApp] Authenticated');
    status = 'loading';
    qrDataUrl = null;
    clearQrExpiryTimer();
    reconnectAttempts = 0;
  });

  // Ready -- FIX 1: isRestarting released HERE only, not at end of initWhatsApp()
  client.on('ready', () => {
    console.log('[WhatsApp] Client ready');
    status = 'ready';
    qrDataUrl = null;
    isRestarting = false;
    reconnectAttempts = 0;
    startHeartbeat();
  });

  // Auth Failure
  client.on('auth_failure', async (msg) => {
    console.error('[WhatsApp] Auth failure:', msg);
    status = 'disconnected';
    isRestarting = false;
    await safeDestroy();
    const shouldWipe = reconnectAttempts >= 2;
    if (shouldWipe) {
      console.warn('[WhatsApp] Wiping session after repeated auth failures...');
      cleanSessionFolder(true);
    } else {
      cleanSessionFolder(false);
    }
    scheduleReconnect();
  });

  // Disconnected
  client.on('disconnected', async (reason) => {
    console.warn('[WhatsApp] Disconnected:', reason);
    status = 'disconnected';
    qrDataUrl = null;
    isRestarting = false;
    await safeDestroy();
    if (reason === 'LOGOUT') {
      console.log('[WhatsApp] User logged out. Wiping session...');
      cleanSessionFolder(true);
      reconnectAttempts = 0;
    } else {
      cleanSessionFolder(false);
    }
    scheduleReconnect(5000);
  });

  // Init error (e.g. Chromium failed to start)
  client.initialize().catch(async (err) => {
    console.error('[WhatsApp] Init error:', err.message || err);
    status = 'disconnected';
    isRestarting = false;
    await safeDestroy();
    scheduleReconnect();
  });

  // FIX 1: The old `isRestarting = false` line that was here is now REMOVED.
  // isRestarting is only released inside the event handlers above.
}

// --------- withTimeout -------------------------------------------------------
function withTimeout(promise, ms = 15000) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('انتهت مهلة الارسال (Timed out)')), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// --------- sendMessage -------------------------------------------------------
async function sendMessage(numbers, text, imageBase64 = null) {
  if (!client || status !== 'ready') {
    throw new Error('WhatsApp client is not ready. Please scan the QR code first.');
  }

  const results = [];
  for (let num of numbers) {
    let cleaned = num.replace(/[^0-9]/g, '');
    if (cleaned.startsWith('01') && cleaned.length === 11) cleaned = '2' + cleaned;
    else if (cleaned.startsWith('1') && cleaned.length === 10) cleaned = '20' + cleaned;
    const chatId = cleaned + '@c.us';

    try {
      if (imageBase64) {
        const base64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        let mime = 'image/jpeg';
        if (imageBase64.startsWith('data:image/png'))  mime = 'image/png';
        else if (imageBase64.startsWith('data:image/webp')) mime = 'image/webp';
        const media = new MessageMedia(mime, base64, 'receipt.jpg');
        await withTimeout(client.sendMessage(chatId, media, { caption: text }), 20000);
      } else {
        await withTimeout(client.sendMessage(chatId, text), 20000);
      }
      results.push({ num, ok: true });
      console.log('[WhatsApp] Message sent to ' + num);
    } catch (err) {
      console.error('[WhatsApp] Failed to send to ' + num + ':', err.message);
      results.push({ num, ok: false, error: err.message });
    }
  }
  return results;
}

// --------- sendDocument ------------------------------------------------------
async function sendDocument(numbers, filePath, caption) {
  if (caption === undefined) caption = 'ملف النسخة الاحتياطية';
  if (!client || status !== 'ready') throw new Error('WhatsApp client is not ready.');
  if (!fs.existsSync(filePath)) throw new Error('File not found: ' + filePath);

  const fileData = fs.readFileSync(filePath, { encoding: 'base64' });
  const filename = path.basename(filePath);
  const media = new MessageMedia('application/json', fileData, filename);

  const results = [];
  for (let num of numbers) {
    let cleaned = num.replace(/[^0-9]/g, '');
    if (cleaned.startsWith('01') && cleaned.length === 11) cleaned = '2' + cleaned;
    else if (cleaned.startsWith('1') && cleaned.length === 10) cleaned = '20' + cleaned;
    const chatId = cleaned + '@c.us';
    try {
      await withTimeout(client.sendMessage(chatId, media, { caption }), 30000);
      results.push({ num, ok: true });
      console.log('[WhatsApp] Document sent to ' + num);
    } catch (err) {
      console.error('[WhatsApp] Failed to send document to ' + num + ':', err.message);
      results.push({ num, ok: false, error: err.message });
    }
  }
  return results;
}

// --------- destroyClient -----------------------------------------------------
async function destroyClient() {
  clearReconnectTimer();
  await safeDestroy();
  status = 'disconnected';
  qrDataUrl = null;
  reconnectAttempts = 0;
  isRestarting = false;
  cleanSessionFolder(true);
  console.log('[WhatsApp] Client destroyed and session wiped.');
}

module.exports = { initWhatsApp, getClient, getStatus, getQR, sendMessage, sendDocument, destroyClient };
