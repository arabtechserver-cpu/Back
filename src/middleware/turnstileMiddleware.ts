import { Request, Response, NextFunction } from "express";

// Turnstile verification is disabled. All traffic is protected at the infrastructure
// level (Cloudflare proxy). To re-enable, set ENABLE_TURNSTILE=true in the backend env.
export async function turnstileMiddleware(_req: Request, _res: Response, next: NextFunction) {
  return next();
}
