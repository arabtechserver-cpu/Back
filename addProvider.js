const axios = require('axios');

async function addProvider() {
  try {
    const loginRes = await axios.post('http://127.0.0.1:5000/api/admin/login', {
      username: 'admin',
      password: 'admin123'
    });
    const token = loginRes.data.token;
    
    const addRes = await axios.post('http://127.0.0.1:5000/api/api-providers', {
      name: 'EA Unlocker',
      api_url: 'https://ea-unlocker.com/api/index.php',
      username: 'fHSUFoci',
      api_key: '66M-EL4-LB1-QEW-TGN-7D2-A3U-8Z6',
      is_active: true
    }, {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log('Provider added:', addRes.data);
    process.exit(0);
  } catch (err) {
    console.error('Error adding provider:', err.response?.data || err.message);
    process.exit(1);
  }
}
addProvider();
