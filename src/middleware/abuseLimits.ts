import rateLimit from 'express-rate-limit';

export const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { success: false, error: 'تم تجاوز محاولات التسجيل. يرجى المحاولة لاحقاً.' }
});
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { success: false, error: 'محاولات دخول كثيرة. يرجى المحاولة لاحقاً.' }
});
export const otpSendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { success: false, error: 'طلبات تحقق كثيرة. يرجى الانتظار قبل طلب كود جديد.' }
});
export const depositIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: 'طلبات إيداع كثيرة. يرجى الانتظار قبل المحاولة مجدداً.' }
});
export const depositAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false,
  keyGenerator: (req: any) => req.user.id,
  message: { error: 'تم تجاوز عدد طلبات الإيداع المسموح لحسابك. يرجى الانتظار.' }
});
