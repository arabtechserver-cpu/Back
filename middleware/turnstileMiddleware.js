// middleware/turnstileMiddleware.js

module.exports = async function turnstileMiddleware(req, res, next) {
  const token = req.body['cf-turnstile-response'];
  const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress;

  if (!token) {
    return res.status(403).json({ message: 'التحقق الأمني مطلوب (CAPTCHA).' });
  }

  try {
    const params = new URLSearchParams({
      secret: process.env.TURNSTILE_SECRET,
      response: token,
      remoteip: clientIp || '',
    });

    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });

    if (!response.ok) {
      throw new Error(`siteverify ${response.status}`);
    }

    const result = await response.json();

    if (!result.success) {
      console.warn("Turnstile failed:", result['error-codes']);
      return res.status(403).json({ message: 'فشل التحقق الأمني. يرجى المحاولة مرة أخرى.' });
    }

    // Success, proceed to the handler
    next();
  } catch (err) {
    console.error("Turnstile error:", err.message);
    return res.status(403).json({ message: 'خطأ في خادم التحقق الأمني.' });
  }
};
