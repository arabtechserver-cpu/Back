const nodemailer = require('nodemailer');
const https = require('https');

async function testLoopsDirect() {
  console.log('--- 1. Testing Loops.so API directly ---');
  const payload = JSON.stringify({
    transactionalId: 'cmrv2rlz301lp0j2pig1clc4n',
    email: 'mina15g4y@gmail.com',
    addToAudience: true,
    dataVariables: {
      site_name: 'عرب تك سيرفر',
      username: 'مينا',
      code: '987654',
      otp_code: '987654',
      message_body: 'اختبار تجريبي مباشر لـ Loops',
      actionLabel: 'تأكيد الحساب',
      reset_url: 'https://arab-tech1.online'
    }
  });

  const options = {
    hostname: 'app.loops.so',
    port: 443,
    path: '/api/v1/transactional',
    method: 'POST',
    headers: {
      'Authorization': 'Bearer c54fb8a81230d2f9432530b5fdf9ac4b',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  await new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        console.log(`Loops HTTP Status: ${res.statusCode}`);
        console.log(`Loops Response Body: ${body}`);
        resolve();
      });
    });
    req.on('error', err => {
      console.error('Loops HTTP Error:', err.message);
      resolve();
    });
    req.write(payload);
    req.end();
  });

  console.log('--- 2. Testing Gmail SMTP directly ---');
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: 'arabtechserver@gmail.com',
        pass: 'ejow pcqv otls vayx'
      }
    });

    const info = await transporter.sendMail({
      from: '"عرب تك سيرفر" <arabtechserver@gmail.com>',
      to: 'mina15g4y@gmail.com',
      subject: '[عرب تك سيرفر] كود أمان جديد (Nodemailer Gmail)',
      html: `<h3>مرحباً مينا 👋</h3><p>كود أمانك الجديد هو: <strong style="font-size: 24px; color: #f59e0b;">987654</strong></p>`
    });
    console.log('Gmail SMTP MessageID:', info.messageId);
  } catch (err) {
    console.error('Gmail SMTP Error:', err.message);
  }

  process.exit(0);
}

testLoopsDirect();
