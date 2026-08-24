const { Client } = require('pg');
const client = new Client({ connectionString: 'postgresql://postgres:opsmnpb8a5ls89e2@arab-tech-arabtech-v07els:5432/postgres' });
client.connect().then(() => {
  client.query("SELECT id, name, packages, fields, api_service_type FROM services WHERE id = 14925").then(res => {
    console.log(JSON.stringify(res.rows[0], null, 2));
    client.end();
  });
}).catch(console.error);
