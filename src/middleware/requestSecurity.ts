import { Request, Response, NextFunction } from 'express';

export function getAllowedOrigins(): string[] {
  return [
    'https://borai.store', 'https://www.borai.store', 'https://api.borai.store',
    ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://borai.local', 'http://borai.local:3000', 'http://borai-server.local', 'http://borai-server.local:3000'] : []),
    ...(process.env.FRONTEND_URL || '').split(',').map(origin => origin.trim()).filter(Boolean)
  ];
}

export function isAllowedOrigin(origin: string): boolean {
  return getAllowedOrigins().includes(origin);
}

export function protectBrowserMutation(req: Request, res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if ((origin && !isAllowedOrigin(origin)) || req.get('sec-fetch-site') === 'cross-site') {
    return res.status(403).json({ error: 'Request origin is not allowed' });
  }
  if (req.headers.cookie && !req.headers.authorization && !origin) {
    return res.status(403).json({ error: 'Origin is required for cookie-authenticated changes' });
  }
  return next();
}
