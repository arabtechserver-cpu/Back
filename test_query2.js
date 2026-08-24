const { Client } = require('pg');
require('dotenv').config();
const client = new Client({ connectionString: 'postgresql://postgres:opsmnpb8a5ls89e2@arab-tech-arabtech-v07els:5432/postgres' });
client.connect().then(async () => {
  try {
    const res = await client.query("SELECT id, name, packages, fields, api_service_type, is_imei_service FROM services WHERE id = 14868");
    console.log("=== Original Service 14868 ===");
    console.log(JSON.stringify(res.rows[0], null, 2));

    const res2 = await client.query("SELECT id, service_id, package_id, \"Requires\" FROM \"DhruService\" WHERE id = '08a37d70-7fc9-4430-82a8-be4c3391b267'");
    console.log("=== Dhru Service ===");
    console.log(JSON.stringify(res2.rows[0], null, 2));
  } catch (err) {
    console.error(err);
  } finally {
    client.end();
  }
}).catch(console.error);
