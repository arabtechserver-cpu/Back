require('dotenv').config();
const { callDhruApi, parseDhruServices } = require('./services/dhruClient');
const db = require('./db');

async function runTest() {
  try {
    const data = await db.getQuery('SELECT * FROM api_providers WHERE name = ?', ['EA Unlocker']);
    const eaProvider = Array.isArray(data) ? data[0] : data;
    
    if (!eaProvider) {
      console.log('Provider not found');
      return;
    }
    
    console.log('Provider found:', eaProvider.name);
    
    // Check balance
    try {
      const balanceData = await callDhruApi(eaProvider.api_url, eaProvider.username, eaProvider.api_key, 'accountinfo');
      console.log('Balance Data:', JSON.stringify(balanceData, null, 2));
    } catch (e) {
      console.error('Balance Error:', e.message);
    }
    
    // Check services
    try {
      const servicesData = await callDhruApi(eaProvider.api_url, eaProvider.username, eaProvider.api_key, 'imeiservicelist');
      const services = parseDhruServices(servicesData, 'imei');
      console.log('Total services fetched:', services.length);
      if (services.length > 0) {
        console.log('Sample service 1:', JSON.stringify(services[0], null, 2));
      }
    } catch (e) {
      console.error('Services Error:', e.message);
    }
  } catch (err) {
    console.error('General Error:', err);
  } finally {
    process.exit(0);
  }
}
runTest();
