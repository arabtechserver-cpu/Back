const { allQuery } = require('./db.js'); (async () => { try { const res = await allQuery('SELECT * FROM api_providers'); console.log(res); } catch(e) { console.error(e); } process.exit(); })();
