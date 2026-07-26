const fetch = require('node-fetch');

const API_URL = 'https://api.arab-tech1.online/api/v1';
const API_KEY = '393391-719FEB-4AEC2A-81E052-67EB59-E1FCA1-B15B7D';

async function testApi() {
  console.log('--- 1. Testing Wallet Balance ---');
  try {
    let res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ key: API_KEY, action: 'accountinfo' })
    });
    console.log(await res.text());
  } catch(e) {
    console.error('Error in accountinfo:', e);
  }

  console.log('\n--- 2. Testing Service List ---');
  try {
    let res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ key: API_KEY, action: 'imeiservicelist' })
    });
    const text = await res.text();
    console.log('Services Response Length:', text.length, 'bytes');
    if (text.includes('SUCCESS')) {
      console.log('✅ Services fetched successfully!');
    } else {
      console.log('Response:', text);
    }
  } catch(e) {
    console.error('Error in imeiservicelist:', e);
  }
}

testApi();
