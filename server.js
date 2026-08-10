const express = require('express');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();
const { getAllowedOrigins, getJwtSecret, isOriginAllowed } = require('./utils/security');

// Ensure database is initialized
const db = require('./db');

// Global Error Handlers to prevent random crashes
process.on('uncaughtException', (err) => {
  console.error('[Anti-Crash] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Anti-Crash] Unhandled Rejection at:', promise, 'reason:', reason);
});


const authRoutes = require('./routes/authRoutes');
const categoryRoutes = require('./routes/categoryRoutes');
const serviceRoutes = require('./routes/serviceRoutes');
const orderRoutes = require('./routes/orderRoutes');
const resellerApiRoutes = require('./routes/resellerApiRoutes');
const customerRoutes = require('./routes/customerRoutes');
const bannerRoutes = require('./routes/bannerRoutes');
const walletRoutes = require('./routes/walletRoutes');
const settingRoutes = require('./routes/settingRoutes');
const whatsappRoutes = require('./routes/whatsappRoutes');
const whatsappPortalRoutes = require('./routes/whatsappPortalRoutes');
const otpRoutes = require('./routes/otpRoutes');
const excelRoutes = require('./routes/excelRoutes');
const unlockerRoutes = require('./routes/unlockerRoutes');
const backupRoutes = require('./routes/backupRoutes');
const membershipRoutes = require('./routes/membershipRoutes');
const telegramRoutes = require('./routes/telegramRoutes');
const reviewRoutes = require('./routes/reviewRoutes');
const telegram = require('./utils/telegramService');
const { startDatabaseBackupScheduler } = require('./utils/databaseBackup');
const { startAutoSyncScheduler } = require('./utils/autoSync');
// Load update_contact_info safely (may not exist in all environments)
try {
  require('./update_contact_info');
} catch (e) {
  // Not critical — skip if missing
}

const app = express();
const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0'; // Listen on all interfaces (required for Docker/proxy)
app.set('trust proxy', 1);
app.disable('x-powered-by');
getJwtSecret();

// ── Global error handlers — prevent silent server death ────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception — server will continue:', err.message, err.stack);
  // Log but do NOT call process.exit() — let PM2/Docker restart handle it only on actual crash
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[WARN] Unhandled Promise Rejection:', reason);
  // Do NOT crash on unhandled rejections — this prevents background fire-and-forget from killing server
});
// ──────────────────────────────────────────────────────────────────────────────

const allowedOrigins = getAllowedOrigins();

// ── Security Headers (Helmet) ────────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: false,
}));

// ── Rate Limiting ────────────────────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 300, // 300 requests per minute
  message: { message: 'طلب مفرط، يرجى الانتظار دقيقة والمحاولة مجدداً.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', generalLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // max 20 login/register attempts
  message: { message: 'محاولات دخول مفرطة، يرجى المحاولة بعد 15 دقيقة.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/auth/login', authLimiter);
app.use('/api/customer/login', authLimiter);
app.use('/api/customer/register', authLimiter);

// ── CORS ─────────────────────────────────────────────────────────────────────
const corsOptions = {
  origin(origin, callback) {
    if (isOriginAllowed(origin, allowedOrigins)) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization', 'X-OTP-Code'],
  credentials: false,
};

app.use(cors(corsOptions));

app.options('*', cors(corsOptions));

const bodyLimit = process.env.BODY_LIMIT || '15mb';
app.use(express.json({ limit: bodyLimit }));
app.use(express.urlencoded({ limit: bodyLimit, extended: true }));

// Enable gzip/brotli compression for all responses
app.use(compression());

const apiProviderRoutes = require('./routes/apiProviderRoutes');

// Prevent sensitive responses from being cached by browsers or proxies
app.use(['/api/auth', '/api/customer', '/api/orders', '/api/wallet', '/api/whatsapp', '/api/whatsapp-portal', '/api/otp'], (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  next();
});

// Serve static assets with aggressive caching (30 days)
const path = require('path');
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  maxAge: '30d',
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (/\.(png|jpe?g|gif|webp|svg|ico)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    }
  }
}));

// ── Server-Side API Caching (Extreme Performance Boost) ──────────────
const apiCache = new Map();
const CACHE_TTL_MS = 30 * 1000;
const CACHE_MAX_ENTRIES = 200;
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET') {
    apiCache.clear();
    return next();
  }
  
  // Do not cache sensitive or dynamic user data routes
  const skipPaths = ['/auth', '/customer', '/wallet', '/otp', '/orders', '/backups', '/v1', '/telegram', '/settings/admin'];
  if (skipPaths.some(p => req.path.startsWith(p))) return next();

  const key = req.originalUrl;
  const cached = apiCache.get(key);
  
  if (cached && (Date.now() - cached.time < CACHE_TTL_MS)) {
    res.setHeader('X-Server-Cache', 'HIT');
    return res.json(cached.data);
  }

  // Intercept response and save to cache
  const originalJson = res.json;
  res.json = function(body) {
    if (res.statusCode === 200) {
      if (apiCache.size >= CACHE_MAX_ENTRIES && !apiCache.has(key)) {
        apiCache.delete(apiCache.keys().next().value);
      }
      apiCache.set(key, { time: Date.now(), data: body });
    }
    return originalJson.call(this, body);
  };
  next();
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/v1', resellerApiRoutes);
app.use('/api/customer', customerRoutes);
app.use('/api/banners', bannerRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/settings', settingRoutes);
app.use('/api/otp', otpRoutes);
app.use('/api/excel', excelRoutes);
app.use('/api/unlocker', unlockerRoutes);
app.use('/api/api-providers', apiProviderRoutes);
app.use('/api/backups', backupRoutes);
app.use('/api/memberships', membershipRoutes);
app.use('/api/reviews', reviewRoutes);

// Health check endpoint
app.get('/', (req, res) => {
  res.status(200).send('API is running successfully!');
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date(),
    database: db.getDatabaseMode(),
    version: 'v2.1', // Verify deployment
  });
});

// Start Server — bind to 0.0.0.0 so Docker proxy can reach it
const server = app.listen(PORT, HOST, () => {
  console.log(`Backend server running on ${HOST}:${PORT}`);
  
  // ── Telegram bot migration: ensure telegram_chat_id column exists ──────────
  (async () => {
    try {
      await db.db.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS telegram_chat_id VARCHAR(50) DEFAULT NULL`);
      console.log('[PostgreSQL] telegram_chat_id column ensured on customers table.');
    } catch (e) {
      // Column may already exist or running in JSON mode — not critical
      if (!e.message.includes('already exists')) {
        console.warn('[PostgreSQL] telegram_chat_id migration note:', e.message);
      }
    }

    try {
      await db.db.query(`CREATE TABLE IF NOT EXISTS reviews (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        rating INTEGER DEFAULT 5,
        review TEXT,
        country_code VARCHAR(10) DEFAULT 'EG',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
      
      // Migration to add country_code if the table already existed
      try {
        await db.db.query(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS country_code VARCHAR(10) DEFAULT 'EG'`);
      } catch (alterErr) {}
      
      console.log('[PostgreSQL] reviews table ensured.');
    } catch (e) {
      console.warn('[PostgreSQL] reviews table creation note:', e.message);
    }
  })();

  // ── Verify Telegram bot is accessible ─────────────────────────────────────
  telegram.getBotInfo().then(async info => {
    if (info.ok) {
      console.log(`[Telegram] Bot ready: @${info.result.username} (${info.result.first_name})`);
      // Clear any old webhook and use reliable polling mode
      await telegram.deleteWebhook();
      console.log('[Telegram] Starting polling mode...');
      telegram.startPolling();
    } else {
      console.warn('[Telegram] Bot check failed:', info.description || 'unknown error');
    }
  }).catch(err => console.warn('[Telegram] Bot check error:', err.message));
  startDatabaseBackupScheduler();
  startAutoSyncScheduler();

  // Keep-alive self-ping to prevent Koyeb / Render free tiers from sleeping
  setInterval(() => {
    const targetUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://api.arab-tech1.online';
    fetch(`${targetUrl}/api/health`)
      .then(res => console.log('[Keep-Alive] Ping successful:', res.status))
      .catch(err => console.error('[Keep-Alive] Ping failed:', err.message));
  }, 10 * 60 * 1000); // Every 10 minutes
});

server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 70 * 1000;
server.requestTimeout = 120 * 1000;

function shutdown(signal) {
  console.log(`[Shutdown] ${signal} received. Closing server gracefully.`);
  server.close(() => {
    db.db.end()
      .catch(err => console.error('[Shutdown] Database close error:', err.message))
      .finally(() => process.exit(0));
  });

  setTimeout(() => process.exit(1), 30 * 1000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ message: 'Request body is too large.' });
  }
  console.error('[HTTP] Unhandled request error:', err);
  return res.status(500).json({ message: 'Internal server error.' });
});

