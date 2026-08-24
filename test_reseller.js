const axios = require('axios');

async function test() {
  try {
    const formData = new URLSearchParams();
    formData.append('key', 'mina15g4y');
    formData.append('action', 'provider_services');

    const res = await axios.post('http://localhost:5000/api/reseller/action', formData, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const services = res.data.SUCCESS[0].LIST;
    const service = services.find(s => s.SERVICEID === '08a37d70-7fc9-4430-82a8-be4c3391b267');
    console.log(JSON.stringify(service, null, 2));
  } catch (err) {
    console.error(err.message);
  }
}

test();
