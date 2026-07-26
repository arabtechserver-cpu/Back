const { sendCustomerAuthOtpEmail } = require('./utils/emailService');

async function test() {
  process.env.EMAIL_USER = 'arab.tech.services2@gmail.com';
  process.env.EMAIL_PASS = 'ejow pcqv otls vayx';
  process.env.EMAIL_HOST = 'smtp.gmail.com';
  process.env.EMAIL_PORT = '465';

  try {
    const res = await sendCustomerAuthOtpEmail('iihis6915@gmail.com', {
      code: '123456',
      username: 'TestUser',
      actionLabel: 'اختبار'
    });
    console.log('Result:', res);
  } catch (e) {
    console.error('Error:', e);
  }
}
test();
