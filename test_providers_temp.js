const { callDhruApi } = require('./services/dhruClient');

async function runTest() {
  const providers = [
    {
      name: 'amrr',
      api_url: 'https://amrr-unlocker.com/api/index.php',
      username: 'Hassen1990',
      api_key: '5TC-O62-NRZ-HF3-NQ4-3VJ-S7V-FPK'
    },
    {
      name: 'gsmserver24',
      api_url: 'https://gsmserver24.com/api/index.php',
      username: 'Hassen1963',
      api_key: '4ZZ-46R-TSF-PRJ-HPI-M88-IO9-TMW'
    }
  ];

  for (const provider of providers) {
    console.log(`\n===========================================`);
    console.log(`Testing Provider: ${provider.name}`);
    console.log(`URL: ${provider.api_url}`);
    console.log(`===========================================`);
    try {
      const response = await callDhruApi(
        provider.api_url, 
        provider.username, 
        provider.api_key, 
        'accountinfo'
      );
      console.log(`[SUCCESS] Response from ${provider.name}:`);
      console.log(JSON.stringify(response, null, 2));
    } catch (e) {
      console.log(`[ERROR] calling ${provider.name}:`);
      console.log(e.message);
    }
  }
}

runTest();
