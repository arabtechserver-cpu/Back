const axios = require('axios');

async function testEA() {
  try {
    const loginRes = await axios.post('http://127.0.0.1:5000/api/auth/login', {
      username: 'admin',
      password: 'admin123'
    });
    const token = loginRes.data.token;
    
    // Get providers
    const provRes = await axios.get('http://127.0.0.1:5000/api/api-providers', { headers: { Authorization: `Bearer ${token}` } });
    const eaProvider = provRes.data.find(p => p.name === 'EA Unlocker');
    if (!eaProvider) {
      console.log('EA Unlocker not found');
      return;
    }
    console.log('Found Provider ID:', eaProvider.id);

    // Check Balance
    try {
      const balRes = await axios.get(`http://127.0.0.1:5000/api/api-providers/${eaProvider.id}/balance`, { headers: { Authorization: `Bearer ${token}` } });
      console.log('Balance:', balRes.data);
    } catch(err) {
      console.error('Balance error:', err.response?.data || err.message);
    }

    // Fetch Services
    try {
      const srvRes = await axios.post(`http://127.0.0.1:5000/api/api-providers/${eaProvider.id}/fetch-services`, {}, { headers: { Authorization: `Bearer ${token}` } });
      console.log('Fetched Services Count:', srvRes.data.servicesCount);
      if (srvRes.data.servicesCount > 0) {
        console.log('Sample Service 1 (name):', srvRes.data.services[0].name);
        console.log('Sample Service 1 (fields):', srvRes.data.services[0].require_custom_fields || 'None');
        console.log('Sample Service 2 (name):', srvRes.data.services[1].name);
      }
    } catch(err) {
      console.error('Fetch services error:', err.response?.data || err.message);
    }
    
  } catch (err) {
    console.error('Error:', err.message);
  }
}
testEA();
