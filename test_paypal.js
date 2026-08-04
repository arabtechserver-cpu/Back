require('dotenv').config();
const paypal = require('./services/paypalService');

(async () => {
  try {
    console.log("Testing PayPal Order Creation...");
    const order = await paypal.createOrder(10, 'http://localhost/success', 'http://localhost/cancel');
    console.log("✅ Success! Order created:", order);
    console.log("Approval URL:", order.approvalUrl);
  } catch (error) {
    console.error("❌ Failed:", error.message);
  }
})();
