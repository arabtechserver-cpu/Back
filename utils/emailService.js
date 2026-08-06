const nodemailer = require('nodemailer');
const https = require('https');
const { getQuery } = require('../db');

/**
 * Get Loops configuration (API key and transactional IDs) from settings DB or process.env
 */
async function getLoopsConfig() {
  let loopsApiKey = process.env.LOOPS_API_KEY || '4d2c0adae7197fd0927e678eceb74c60';
  let loopsTransactionalIdOtp = process.env.LOOPS_TRANSACTIONAL_ID_OTP || 'cmrv2rlz301lp0j2pig1clc4n';
  let loopsTransactionalIdReset = process.env.LOOPS_TRANSACTIONAL_ID_RESET || '';

  try {
    const keyRow = await getQuery("SELECT value FROM settings WHERE key = 'loops_api_key'");
    const otpRow = await getQuery("SELECT value FROM settings WHERE key = 'loops_transactional_id_otp'");
    const resetRow = await getQuery("SELECT value FROM settings WHERE key = 'loops_transactional_id_reset'");

    if (keyRow && keyRow.value) loopsApiKey = keyRow.value.trim();
    if (otpRow && otpRow.value) loopsTransactionalIdOtp = otpRow.value.trim();
    if (resetRow && resetRow.value) loopsTransactionalIdReset = resetRow.value.trim();
  } catch (err) {
    // DB settings fetch failed
  }

  return { loopsApiKey, loopsTransactionalIdOtp, loopsTransactionalIdReset };
}

/**
 * Send Transactional Email via Loops API (https://app.loops.so/api/v1/transactional)
 */
async function sendViaLoops(toEmail, transactionalId, dataVariables) {
  const { loopsApiKey } = await getLoopsConfig();
  if (!loopsApiKey || !transactionalId) {
    return false;
  }

  const payload = JSON.stringify({
    transactionalId,
    email: toEmail,
    addToAudience: true,
    dataVariables
  });

  return new Promise((resolve) => {
    const options = {
      hostname: 'app.loops.so',
      port: 443,
      path: '/api/v1/transactional',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${loopsApiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[Email Service - Loops] Email sent via Loops to ${toEmail} ✓ (Status: ${res.statusCode})`);
          resolve(true);
        } else {
          console.warn(`[Email Service - Loops] API returned error ${res.statusCode} for ${toEmail}: ${body}`);
          resolve(false);
        }
      });
    });

    req.on('error', (err) => {
      console.error(`[Email Service - Loops] Connection failed for ${toEmail}:`, err.message);
      resolve(false);
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Get nodemailer transport configuration from database settings or environment variables
 */
async function getTransporter() {
  let emailUser = process.env.EMAIL_USER || '';
  let emailPass = process.env.EMAIL_PASS || '';
  let emailHost = process.env.EMAIL_HOST || 'smtp.gmail.com';
  let emailPort = process.env.EMAIL_PORT ? parseInt(process.env.EMAIL_PORT) : 465;

  try {
    const userRow = await getQuery("SELECT value FROM settings WHERE key = 'email_user'");
    const passRow = await getQuery("SELECT value FROM settings WHERE key = 'email_pass'");
    const hostRow = await getQuery("SELECT value FROM settings WHERE key = 'email_host'");
    const portRow = await getQuery("SELECT value FROM settings WHERE key = 'email_port'");

    if (userRow && userRow.value) emailUser = userRow.value;
    if (passRow && passRow.value) emailPass = passRow.value;
    if (hostRow && hostRow.value) emailHost = hostRow.value;
    if (portRow && portRow.value) emailPort = parseInt(portRow.value) || 465;
  } catch (err) {
    console.warn('[Email Service] Could not fetch email settings from DB, using env values.');
  }

  if (!emailUser || !emailPass) {
    return null;
  }

  const transportConfig = emailHost.includes('gmail.com')
    ? {
        service: 'gmail',
        auth: {
          user: emailUser,
          pass: emailPass
        }
      }
    : {
        host: emailHost,
        port: emailPort,
        secure: emailPort === 465, // true for 465, false for other ports
        auth: {
          user: emailUser,
          pass: emailPass
        }
      };

  return nodemailer.createTransport(transportConfig);
}

/**
 * Helper to wrap content in a branded, responsive right-to-left HTML wrapper
 */
function getHtmlWrapper(title, contentHtml) {
  return `
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
</head>
<body style="font-family: Arial, sans-serif; direction: rtl; text-align: right; background-color: #ffffff; color: #333333; margin: 0; padding: 20px;">
  <div style="max-width: 600px; margin: 0 auto; border: 1px solid #dddddd; border-radius: 8px; padding: 20px;">
    <h2 style="color: #0056b3; margin-top: 0; text-align: center;">عرب تك سيرفر</h2>
    <hr style="border: 0; border-top: 1px solid #eeeeee; margin-bottom: 20px;">
    ${contentHtml}
    <hr style="border: 0; border-top: 1px solid #eeeeee; margin-top: 30px; margin-bottom: 20px;">
    <p style="font-size: 12px; color: #888888; text-align: center;">جميع الحقوق محفوظة © عرب تك سيرفر<br>هذه رسالة تلقائية، يرجى عدم الرد عليها مباشرة.</p>
  </div>
</body>
</html>
  `;
}

/**
 * Modern HTML email template for Customer OTP & Password Reset
 */
function getCustomerEmailTemplate({ siteName = 'عرب تك سيرفر', username = 'عزيزنا العميل', title = '', messageBody = '', otpCode = null, resetUrl = null }) {
  const currentYear = new Date().getFullYear();
  return `
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${siteName} - ${title}</title>
</head>
<body style="height: 100% !important; margin: 0 !important; padding: 0 !important; width: 100% !important; background-color: #0f172a; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #e2e8f0; direction: rtl; text-align: right;">
  <div style="width: 100%; background-color: #0f172a; padding: 40px 10px; box-sizing: border-box;">
    <div style="max-width: 600px; margin: 0 auto; background: #1e293b; border-radius: 16px; border: 1px solid #334155; overflow: hidden; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);">
      
      <!-- Header -->
      <div style="background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 50%, #1e40af 100%); padding: 32px 24px; text-align: center;">
        <div style="font-size: 26px; font-weight: 800; color: #ffffff; letter-spacing: 0.5px;">⚡ ${siteName}</div>
        <div style="font-size: 14px; color: #93c5fd; margin-top: 6px; font-weight: 500;">بوابتك السريعة لخدمات السيرفرات والتفعيل</div>
      </div>

      <!-- Main Body -->
      <div style="padding: 36px 32px;">
        
        <!-- User Greeting -->
        <div style="font-size: 20px; font-weight: 700; color: #f8fafc; margin-bottom: 16px;">مرحباً، <span style="color: #60a5fa;">${username}</span> 👋</div>
        
        <!-- Message Description -->
        <p style="font-size: 15px; line-height: 1.8; color: #cbd5e1; margin-bottom: 24px;">
          ${messageBody}
        </p>

        <!-- OTP Section -->
        ${otpCode ? `
        <div style="background: rgba(37, 99, 235, 0.1); border: 2px dashed #3b82f6; border-radius: 12px; padding: 20px; text-align: center; margin: 28px 0;">
          <div style="font-size: 13px; font-weight: 600; color: #93c5fd; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">🔑 كود تفعيل الحساب / التحقق (OTP)</div>
          <div style="font-size: 34px; font-weight: 900; color: #60a5fa; letter-spacing: 8px; font-family: 'Courier New', Courier, monospace; margin: 6px 0;">${otpCode}</div>
          <div style="font-size: 12px; color: #94a3b8; margin-top: 6px;">⏱️ صالح لمدة 10 دقائق فقط</div>
        </div>
        ` : ''}

        <!-- Password Reset Action Button -->
        ${resetUrl ? `
        <div style="text-align: center; margin: 32px 0;">
          <a href="${resetUrl}" target="_blank" style="display: inline-block; background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); color: #ffffff !important; font-size: 16px; font-weight: 700; text-decoration: none; padding: 14px 36px; border-radius: 10px; box-shadow: 0 4px 14px 0 rgba(37, 99, 235, 0.4);">🔒 تعيين كلمة مرور جديدة</a>
        </div>
        ` : ''}

        <!-- Security Warning -->
        <div style="background-color: #0f172a; border-right: 4px solid #f59e0b; border-radius: 8px; padding: 14px 16px; margin: 24px 0; text-align: right;">
          <div style="font-size: 14px; font-weight: 700; color: #fbbf24; margin-bottom: 4px;">⚠️ تنبيه أمان مهم</div>
          <p style="font-size: 13px; color: #94a3b8; margin: 0; line-height: 1.6;">
            هذا البيانات سرية للغاية وتُستخدم لمرة واحدة فقط. يرجى عدم مشاركتها مع أي شخص، وفريق الدعم لن يطلب منك كلمة المرور أو كود التحقق أبداً.
          </p>
        </div>

        <p style="font-size: 13px; color: #94a3b8; margin-top: 20px;">
          إذا لم تقم بطلب هذا الإجراء، يمكنك تجاهل هذه الرسالة وأمان حسابك في مأمن تام.
        </p>

        <hr style="border: 0; height: 1px; background: #334155; margin: 28px 0;">

        <p style="font-size: 14px; text-align: center; color: #cbd5e1; margin-bottom: 0;">
          مع تحيات فريق عمل <strong>${siteName}</strong> ❤️
        </p>
      </div>

      <!-- Footer -->
      <div style="background-color: #0f172a; padding: 24px; text-align: center; border-top: 1px solid #334155;">
        <div style="font-size: 13px; color: #64748b; line-height: 1.6;">
          جميع الحقوق محفوظة © ${currentYear} ${siteName}
          <br>هذه الرسالة تم إرسالها آلياً، يرجى عدم الرد عليها مباشرة.
        </div>
      </div>

    </div>
  </div>
</body>
</html>
  `;
}

/**
 * Send order confirmation email when a new order is received
 */
async function sendOrderSubmittedEmail(toEmail, { orderId, serviceName, packageName, price, playerId }) {
  if (!toEmail) return false;
  const transporter = await getTransporter();
  if (!transporter) {
    console.warn('[Email Service] Transporter not configured. Skipping submitted email for order #' + orderId);
    return false;
  }

  const title = `[عرب تك سيرفر] تم استلام طلبك رقم #${orderId} بنجاح ⏳`;
  const content = `
    <h2 style="color: #60a5fa; margin-top: 0;">📦 مرحباً بك في عرب تك سيرفر!</h2>
    <p>لقد استلمنا طلبك الجديد بنجاح، وهو الآن <strong>قيد المراجعة والتنفيذ الفوري</strong> من قبل فريق العمل أو النظام الآلي.</p>
    
    <div class="order-box">
      <div class="order-item">
        <span class="order-label">رقم الطلب:</span>
        <span class="order-value">#${orderId}</span>
      </div>
      <div class="order-item">
        <span class="order-label">الخدمة المطلوبة:</span>
        <span class="order-value">${serviceName || 'تفعيل فوري'}</span>
      </div>
      <div class="order-item">
        <span class="order-label">الباقة / الكمية:</span>
        <span class="order-value">${packageName || 'باقة أساسية'}</span>
      </div>
      ${playerId ? `
      <div class="order-item">
        <span class="order-label">المعرف / السيريال:</span>
        <span class="order-value">${playerId}</span>
      </div>
      ` : ''}
      <div class="order-item">
        <span class="order-label">سعر الطلب:</span>
        <span class="order-value">$${price || 0}</span>
      </div>
      <div class="order-item">
        <span class="order-label">الحالة الحالية:</span>
        <span class="order-value" style="color: #fbbf24;">⏳ قيد المراجعة والتنفيذ</span>
      </div>
    </div>

    <p>سوف تصلك رسالة أخرى عبر البريد الإلكتروني والواتساب فور اكتمال تنفيذ طلبك بنجاح. شكراً لثقتك بنا!</p>
  `;

  try {
    const info = await transporter.sendMail({
      from: `"عرب تك سيرفر" <${transporter.options.auth.user}>`,
      to: toEmail,
      subject: title,
      html: getHtmlWrapper(title, content)
    });
    console.log(`[Email Service] Order submitted email sent to ${toEmail} (MessageID: ${info.messageId}) ✓`);
    return true;
  } catch (err) {
    console.error(`[Email Service] Failed to send submitted email to ${toEmail}:`, err.message);
    return false;
  }
}

/**
 * Send order completion email when order status changes to 'completed'
 */
async function sendOrderCompletedEmail(toEmail, { orderId, serviceName, packageName, code, downloadLink }) {
  if (!toEmail) return false;
  const transporter = await getTransporter();
  if (!transporter) {
    console.warn('[Email Service] Transporter not configured. Skipping completed email for order #' + orderId);
    return false;
  }

  const title = `🎉 مبروك! تم تنفيذ طلبك رقم #${orderId} بنجاح ✅`;
  let content = `
    <h2 style="color: #4ade80; margin-top: 0;">✅ تم تنفيذ طلبك بنجاح!</h2>
    <p>يسعدنا إبلاغك بأن طلبك رقم <strong>#${orderId}</strong> لخدمة <strong>${serviceName || 'تفعيل السيرفر'}</strong> قد تم اكتماله وتنفيذه بنجاح تام!</p>
    
    <div class="order-box">
      <div class="order-item">
        <span class="order-label">رقم الطلب:</span>
        <span class="order-value">#${orderId}</span>
      </div>
      <div class="order-item">
        <span class="order-label">الخدمة:</span>
        <span class="order-value">${serviceName || 'تفعيل فوري'}</span>
      </div>
      ${packageName ? `
      <div class="order-item">
        <span class="order-label">الباقة:</span>
        <span class="order-value">${packageName}</span>
      </div>
      ` : ''}
      <div class="order-item">
        <span class="order-label">الحالة الآن:</span>
        <span class="order-value" style="color: #4ade80;">✅ مكتمل / تم التنفيذ</span>
      </div>
    </div>
  `;

  if (code && code.trim()) {
    content += `
      <div class="code-box">
        <div style="font-size: 14px; font-weight: 700; color: #86efac;">🔑 كود التفعيل / السيريال الخاص بك:</div>
        <div class="code-text">${code}</div>
      </div>
    `;
  }

  if (downloadLink && downloadLink.trim()) {
    content += `
      <div style="text-align: center; margin: 24px 0;">
        <a href="${downloadLink}" class="btn" target="_blank">📥 اضغط هنا لتحميل الملف / البرنامج</a>
      </div>
    `;
  }

  content += `
    <p>نتمنى لك تجربة استخدام رائعة وممتعة، ونسعد دائماً بخدمتك في عرب تك سيرفر! ❤️</p>
  `;

  try {
    const info = await transporter.sendMail({
      from: `"عرب تك سيرفر" <${transporter.options.auth.user}>`,
      to: toEmail,
      subject: title,
      html: getHtmlWrapper(title, content)
    });
    console.log(`[Email Service] Order completed email sent to ${toEmail} (MessageID: ${info.messageId}) ✓`);
    return true;
  } catch (err) {
    console.error(`[Email Service] Failed to send completed email to ${toEmail}:`, err.message);
    return false;
  }
}

/**
 * Send OTP email to customer during registration or login
 */
async function sendCustomerAuthOtpEmail(toEmail, { code, username, actionLabel }) {
  if (!toEmail) return false;

  const siteName = 'عرب تك سيرفر';
  const messageBody = `لقد تم طلب كود تحقق الأمان من أجل <strong>${actionLabel || 'تفعيل وإتمام الدخول لحسابك'}</strong>. يرجى استخدام الكود التالي لإكمال العملية بنجاح:`;

  // 1. Try Loops.so for Customer Email
  const { loopsTransactionalIdOtp } = await getLoopsConfig();
  if (loopsTransactionalIdOtp) {
    const loopsSuccess = await sendViaLoops(toEmail, loopsTransactionalIdOtp, {
      site_name: siteName,
      username: username || 'عزيزنا العميل',
      code: code,
      otp_code: code,
      message_body: `لقد تم طلب كود تحقق الأمان من أجل ${actionLabel || 'تفعيل وإتمام الدخول لحسابك'}.`,
      actionLabel: actionLabel || 'تأكيد الحساب',
      reset_url: 'https://arab-tech1.online' // Required by Loops unified template
    });
    if (loopsSuccess) return true;
    console.warn('[Email Service] Loops send failed or not found. Falling back to local Nodemailer library...');
  }

  // 2. Fallback to Local Nodemailer Library
  const transporter = await getTransporter();
  if (!transporter) {
    console.warn('[Email Service] Transporter not configured. Skipping OTP email for ' + toEmail);
    return false;
  }

  const title = `[عرب تك سيرفر] كود تحقق الأمان (OTP) لحسابك`;

  const htmlContent = getCustomerEmailTemplate({
    siteName: siteName,
    username: username || 'عزيزنا العميل',
    title: 'كود تحقق الأمان (OTP)',
    messageBody,
    otpCode: code
  });

  try {
    const info = await transporter.sendMail({
      from: `"عرب تك سيرفر" <${transporter.options.auth.user}>`,
      replyTo: transporter.options.auth.user,
      to: toEmail,
      subject: title,
      html: htmlContent
    });
    console.log(`[Email Service - Local Nodemailer] Customer Auth OTP email sent to ${toEmail} (MessageID: ${info.messageId}) ✓`);
    return true;
  } catch (err) {
    console.error(`[Email Service - Local Nodemailer] Failed to send Auth OTP email to ${toEmail}:`, err.message);
    return false;
  }
}

/**
 * Send Password Reset link email to customer
 */
async function sendPasswordResetEmail(toEmail, { username, resetUrl }) {
  if (!toEmail) return false;

  const siteName = 'عرب تك سيرفر';

  // 1. Try Loops.so for Customer Email
  const { loopsTransactionalIdReset } = await getLoopsConfig();
  if (loopsTransactionalIdReset) {
    const loopsSuccess = await sendViaLoops(toEmail, loopsTransactionalIdReset, {
      site_name: siteName,
      username: username || 'عزيزنا العميل',
      code: '-', // Required by Loops unified template
      otp_code: '-',
      reset_url: resetUrl,
      resetUrl: resetUrl,
      message_body: 'لقد استلمنا طلباً لإعادة تعيين كلمة المرور الخاصة بحسابك.'
    });
    if (loopsSuccess) return true;
    console.warn('[Email Service] Loops send failed or not found. Falling back to local Nodemailer library...');
  }

  // 2. Fallback to Local Nodemailer Library
  const transporter = await getTransporter();
  if (!transporter) {
    console.warn('[Email Service] Transporter not configured. Skipping password reset email for ' + toEmail);
    return false;
  }

  const title = `[عرب تك سيرفر] رابط إعادة تعيين كلمة المرور 🔒`;
  const messageBody = `لقد استلمنا طلباً لإعادة تعيين كلمة المرور الخاصة بحسابك. يمكنك البدء في تعيين كلمة مرور جديدة وآمنة عن طريق الضغط على الزر أدناه:`;

  const htmlContent = getCustomerEmailTemplate({
    siteName: 'عرب تك سيرفر',
    username: username || 'عزيزنا العميل',
    title: 'إعادة تعيين كلمة المرور',
    messageBody,
    resetUrl
  });

  try {
    const info = await transporter.sendMail({
      from: `"عرب تك سيرفر" <${transporter.options.auth.user}>`,
      replyTo: transporter.options.auth.user,
      to: toEmail,
      subject: title,
      html: htmlContent
    });
    console.log(`[Email Service - Local Nodemailer] Password reset email sent to ${toEmail} (MessageID: ${info.messageId}) ✓`);
    return true;
  } catch (err) {
    console.error(`[Email Service - Local Nodemailer] Failed to send Password Reset email to ${toEmail}:`, err.message);
    return false;
  }
}

/**
 * Send admin email notification when a wallet recharge request is submitted
 */
async function sendWalletRechargeAdminEmail(adminEmail, { requestId, customerUsername, amount, currency, senderPhone, notes }) {
  const transporter = await getTransporter();
  if (!transporter) return false;

  const targetEmail = adminEmail || transporter.options.auth.user;
  if (!targetEmail) return false;

  const title = `[تنبيه إدارة] 💳 طلب شحن محفظة جديد رقم #${requestId}`;
  const content = `
    <h2 style="color: #f59e0b; margin-top: 0;">💳 إشعار طلب شحن رصيد جديد</h2>
    <p>لقد قام العميل <strong>${customerUsername}</strong> بتقديم طلب شحن جديد لرصيد المحفظة وهو بانتظار المراجعة والاعتماد.</p>
    
    <div class="order-box">
      <div class="order-item">
        <span class="order-label">رقم الطلب:</span>
        <span class="order-value">#${requestId}</span>
      </div>
      <div class="order-item">
        <span class="order-label">اسم العميل:</span>
        <span class="order-value">${customerUsername}</span>
      </div>
      <div class="order-item">
        <span class="order-label">المبلغ المطلوب:</span>
        <span class="order-value" style="color: #4ade80; font-size: 18px;">${amount} ${currency || 'USD'}</span>
      </div>
      <div class="order-item">
        <span class="order-label">رقم / بيانات التحويل:</span>
        <span class="order-value">${senderPhone || '-'}</span>
      </div>
      ${notes ? `
      <div class="order-item">
        <span class="order-label">ملاحظات العميل:</span>
        <span class="order-value">${notes}</span>
      </div>
      ` : ''}
      <div class="order-item">
        <span class="order-label">الحالة الحالية:</span>
        <span class="order-value" style="color: #fbbf24;">⏳ قيد المراجعة</span>
      </div>
    </div>

    <p>يمكنك مراجعة إيصال التحويل واعتماد الرصيد فوراً من خلال لوحة التحكم (الداشبورد).</p>
  `;

  try {
    const info = await transporter.sendMail({
      from: `"عرب تك سيرفر" <${transporter.options.auth.user}>`,
      to: targetEmail,
      subject: title,
      html: getHtmlWrapper(title, content)
    });
    console.log(`[Email Service] Wallet recharge admin notification sent to ${targetEmail} ✓`);
    return true;
  } catch (err) {
    console.error(`[Email Service] Failed to send wallet recharge admin email:`, err.message);
    return false;
  }
}

/**
 * List of known disposable/fake email domains
 */
const DISPOSABLE_DOMAINS = new Set([
  'tempmail.com', 'temp-mail.org', 'mailinator.com', '10minutemail.com',
  'guerrillamail.com', 'yopmail.com', 'dispostable.com', 'sharklasers.com',
  'getnada.com', 'trashmail.com', 'crazymailing.com', 'fakemail.net',
  'generator.email', 'maildrop.cc', 'mohmal.com', 'tempmail.net',
  'binkmail.com', 'bobmail.info', 'spamgourmet.com', 'mailcatch.com',
  'throwawaymail.com', 'getairmail.com', 'minutemailbox.com', 'emailondeck.com',
  'tempail.com', '0815.ru', '10minutemail.co.uk', '20minutemail.com'
]);

/**
 * Returns canonical representation of a Gmail address to prevent alias/dot tricks
 * e.g., "j.o.h.n+test@gmail.com" => "john@gmail.com"
 */
function getCanonicalGmail(email) {
  if (!email || typeof email !== 'string') return '';
  const clean = email.trim().toLowerCase();
  const parts = clean.split('@');
  if (parts.length !== 2) return clean;

  let [local, domain] = parts;
  if (domain === 'googlemail.com') domain = 'gmail.com';

  if (domain === 'gmail.com') {
    // Strip everything after '+' in local part
    const plusIndex = local.indexOf('+');
    if (plusIndex !== -1) {
      local = local.substring(0, plusIndex);
    }
    // Remove all dots in local part for Gmail
    local = local.replace(/\./g, '');
  }

  return `${local}@${domain}`;
}

/**
 * Deep validation for Gmail address to detect fake/disposable/invalid emails
 */
async function validateRealGmail(email) {
  if (!email || typeof email !== 'string') {
    return { valid: false, reason: 'يرجى إدخال بريد إلكتروني صالح.' };
  }

  const clean = email.trim().toLowerCase();

  // 1. Gmail format regex
  const gmailRegex = /^[a-zA-Z0-9._%+-]+@(gmail\.com|googlemail\.com)$/;
  if (!gmailRegex.test(clean)) {
    return { valid: false, reason: 'يجب أن يكون البريد الإلكتروني حساب Gmail صالح ينتهي بـ @gmail.com' };
  }

  const parts = clean.split('@');
  const domain = parts[1] === 'googlemail.com' ? 'gmail.com' : parts[1];

  // 2. Check disposable list
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return { valid: false, reason: 'غير مسموح باستخدام البريد الإلكتروني المؤقت أو الوهمي للتسجيل.' };
  }

  // 3. Check username length and basic sanity
  const canonical = getCanonicalGmail(clean);
  const localPart = canonical.split('@')[0];
  if (localPart.length < 4) {
    return { valid: false, reason: 'عنوان البريد الإلكتروني قصيرة جداً وغير صالح.' };
  }

  // 4. DNS MX record verification for non-gmail domains if needed, or fallback for gmail
  if (domain !== 'gmail.com' && domain !== 'googlemail.com') {
    const dns = require('dns').promises;
    try {
      const mxRecords = await dns.resolveMx(domain);
      if (!mxRecords || mxRecords.length === 0) {
        return { valid: false, reason: 'نطاق البريد الإلكتروني لا يدعم استقبال الرسائل البريدية.' };
      }
    } catch (err) {
      console.warn(`[Email Validation] MX lookup failed for ${domain}:`, err.message);
      return { valid: false, reason: 'تعذر التحقق من خادم البريد الإلكتروني. يرجى التأكد من كتابة البريد صحيحاً.' };
    }
  }

  return {
    valid: true,
    cleanEmail: clean,
    canonicalEmail: canonical
  };
}

/**
 * Send OTP email to Admin during login or sensitive deletion operations
 */
async function sendAdminOtpEmail(toEmail, { code, action, customMessage }) {
  if (!toEmail) return false;
  const transporter = await getTransporter();
  if (!transporter) {
    console.warn('[Email Service] Transporter not configured. Skipping Admin OTP email.');
    return false;
  }

  const title = `[عرب تك سيرفر] كود تحقق أمان الإدارة (OTP) 🔐`;
  
  let actionText = '';
  if (action === 'admin_login') {
    actionText = 'تسجيل الدخول إلى لوحة التحكم (الداشبورد)';
  } else if (action === 'delete') {
    actionText = 'تأكيد عملية حذف حساسة';
  } else if (action === 'whatsapp_portal_access') {
    actionText = 'تأكيد الدخول لصفحة بوابة الواتساب';
  } else {
    actionText = 'إجراء عملية إدارة حساسة';
  }

  const content = `
    <h2 style="color: #ef4444; margin-top: 0;">🔐 كود تحقق أمان المسؤول (Admin OTP)</h2>
    <p>لقد تم طلب كود تحقق أمان من أجل: <strong>${actionText}</strong></p>
    
    ${customMessage ? `<p style="background: rgba(239, 68, 68, 0.08); padding: 12px; border-radius: 8px; border-right: 4px solid #ef4444; color: #fca5a5; font-size: 14px; margin: 15px 0;">${customMessage}</p>` : ''}
    
    <div class="code-box" style="background: rgba(239, 68, 68, 0.15); border: 2px dashed #ef4444; border-radius: 12px; padding: 18px; text-align: center; margin: 24px 0;">
      <div style="font-size: 14px; font-weight: 700; color: #fda4af;">🔑 كود التحقق الخاص بك هو:</div>
      <div class="code-text" style="font-size: 32px; letter-spacing: 6px; color: #ef4444; font-weight: 900; margin-top: 8px;">${code}</div>
    </div>

    <p style="color: #cbd5e1; font-size: 14px;">⏱️ هذا الكود صالح لمدة <strong>5 دقائق</strong> ويستخدم لمرة واحدة فقط. إذا لم تكن أنت من طلب هذا الإجراء، يرجى فحص حماية السيرفر وتغيير بيانات الدخول فوراً.</p>
  `;

  try {
    const info = await transporter.sendMail({
      from: `"عرب تك سيرفر" <${transporter.options.auth.user}>`,
      to: toEmail,
      subject: title,
      html: getHtmlWrapper(title, content)
    });
    console.log(`[Email Service] Admin OTP email sent to ${toEmail} (MessageID: ${info.messageId}) ✓`);
    return true;
  } catch (err) {
    console.error(`[Email Service] Failed to send Admin OTP email to ${toEmail}:`, err.message);
    return false;
  }
}

module.exports = {
  getTransporter,
  getCustomerEmailTemplate,
  sendOrderSubmittedEmail,
  sendOrderCompletedEmail,
  sendCustomerAuthOtpEmail,
  sendPasswordResetEmail,
  sendWalletRechargeAdminEmail,
  sendAdminOtpEmail,
  getCanonicalGmail,
  validateRealGmail
};

