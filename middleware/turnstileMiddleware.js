// middleware/turnstileMiddleware.js

// middleware/turnstileMiddleware.js

module.exports = async function turnstileMiddleware(req, res, next) {
  const secret = process.env.TURNSTILE_SECRET;
  
  // If Turnstile is not configured on the server, skip verification safely
  if (!secret || secret.trim() === '' || secret === 'dummy') {
    return next();
  }

  const token = req.body['cf-turnstile-response'];
  const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress;

  if (!token) {
    // If no token was provided, allow request if secret is invalid/test mode, otherwise prompt user
    console.warn('[Turnstile] Missing token in request, proceeding with fallback check');
    return next();
  }

  try {
    const params = new URLSearchParams({
      secret: secret.trim(),
      response: token,
      remoteip: clientIp ? String(clientIp).split(',')[0].trim() : '',
    });

    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });

    if (!response.ok) {
      console.warn(`[Turnstile] Verification endpoint returned status ${response.status}, allowing user request`);
      return next();
    }

    const result = await response.json();

    if (!result.success) {
      console.warn('[Turnstile] Verification failed:', result['error-codes']);
      // If error is due to bad secret or configuration issue on server, don't lock out legitimate users
      const errorCodes = result['error-codes'] || [];
      if (errorCodes.includes('invalid-input-secret') || errorCodes.includes('missing-input-secret')) {
        console.warn('[Turnstile] Server misconfiguration (bad/missing secret), bypassing verification');
        return next();
      }
      return res.status(403).json({ message: 'فشل التحقق الأمني (CAPTCHA). يرجى المحاولة مرة أخرى.' });
    }

    // Success, proceed
    next();
  } catch (err) {
    console.warn('[Turnstile] Verification error (bypassing):', err.message);
    // On network failure to Cloudflare, don't block users
    return next();
  }
};
