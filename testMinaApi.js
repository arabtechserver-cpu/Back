const axios = require('axios');
const FormData = require('form-data');
const https = require('https');
const fs = require('fs');

async function testApi() {
  const url = 'https://ea-unlocker.com/api/index.php';
  const username = process.env.MINA_API_USERNAME;
  const apiKey = process.env.MINA_API_KEY;

  if (!username || !apiKey) {
    console.error('Missing MINA_API_USERNAME or MINA_API_KEY environment variable.');
    process.exit(1);
  }
  
  const formData = new FormData();
  formData.append('username', username);
  formData.append('apiaccesskey', apiKey);
  formData.append('action', 'serverservicelist');
  formData.append('requestformat', 'JSON');

  try {
    console.log('Testing EA Unlocker API...');
    const response = await axios.post(url, formData, {
      headers: formData.getHeaders(),
      httpsAgent: new https.Agent({ family: 4 })
    });
    fs.writeFileSync('server_response.json', JSON.stringify(response.data, null, 2));
    console.log('Response saved to server_response.json');
  } catch (error) {
    console.error('Error testing API:', error.message);
    if (error.response) {
      console.error('Error Details:', error.response.data);
    }
  }
}

testApi();
