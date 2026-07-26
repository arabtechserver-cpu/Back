const fs = require('fs');

try {
  const dbPath = './database.json';
  const data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  
  if (!data.api_providers) {
    data.api_providers = [];
  }
  
  const newProvider = {
    id: data.api_providers.length > 0 ? Math.max(...data.api_providers.map(p => p.id)) + 1 : 1,
    name: 'EA Unlocker',
    api_url: 'https://ea-unlocker.com/api/index.php',
    username: 'fHSUFoci',
    api_key: '66M-EL4-LB1-QEW-TGN-7D2-A3U-8Z6',
    is_active: 1,
    balance: "0.00",
    currency: "USD"
  };
  
  data.api_providers.push(newProvider);
  
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf8');
  console.log('Provider EA Unlocker successfully added to database.json!');
} catch (err) {
  console.error('Error modifying database.json:', err);
}
