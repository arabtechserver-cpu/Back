const axios = require('axios');

async function test() {
  try {
    const formData = new URLSearchParams();
    formData.append('key', 'mina15g4y');
    formData.append('action', 'provider_services');

    console.log("Sending request to live server...");
    const res = await axios.post('https://arab-tech1.online/api/reseller/action', formData, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    if (res.data.SUCCESS) {
        const services = res.data.SUCCESS[0].LIST;
        const service = services.find(s => s.SERVICEID === '08a37d70-7fc9-4430-82a8-be4c3391b267' || String(s.SERVICE_NAME).includes('14868'));
        console.log("Found service on live:", JSON.stringify(service, null, 2));
    } else {
        console.log("No success:", JSON.stringify(res.data, null, 2));
    }
  } catch (err) {
    if (err.response) {
      console.error("API Error:", JSON.stringify(err.response.data, null, 2));
    } else {
      console.error("Network Error:", err.message);
    }
  }
}

test();
