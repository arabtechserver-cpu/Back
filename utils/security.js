const DEFAULT_DEV_JWT_SECRET = 'zoom_charging_store_jwt_secret_key_2026';

function getJwtSecret() {
  const secret = process.env.JWT_SECRET && process.env.JWT_SECRET.trim();
  if (secret) {
    return secret;
  }
  return DEFAULT_DEV_JWT_SECRET;
}

function getAllowedOrigins() {
  const configuredOrigins = [
    process.env.CORS_ORIGIN,
    process.env.FRONTEND_URL,
    process.env.SITE_URL,
    process.env.NEXT_PUBLIC_SITE_URL,
  ]
    .filter(Boolean)
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter(Boolean);

  const devOrigins = [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
  ];

  return Array.from(new Set([...configuredOrigins, ...devOrigins]));
}

function isOriginAllowed(origin, allowedOrigins) {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  
  try {
    const url = new URL(origin);
    const hostname = url.hostname.toLowerCase();
    
    // Dynamically allow all subdomains of arab-tech1.online
    if (hostname === 'arab-tech1.online' || hostname.endsWith('.arab-tech1.online')) {
      return true;
    }
    // Dynamically allow duckdns domains used for deployment
    if (hostname === 'spider-store-api.duckdns.org' || hostname.endsWith('.duckdns.org')) {
      return true;
    }
  } catch (e) {
    // Ignore invalid URLs, fall back to checking prefix
  }

  if (origin.startsWith('http://localhost:') || 
      origin.startsWith('http://127.0.0.1:') || 
      origin.startsWith('http://192.168.') || 
      origin.startsWith('http://10.') || 
      origin.startsWith('http://172.')) {
    return true;
  }
  return false;
}

module.exports = {
  getJwtSecret,
  getAllowedOrigins,
  isOriginAllowed,
};
