const { Client } = require('pg');
const client = new Client({
  connectionString: 'postgresql://postgres:opsmnpb8a5ls89e2@arab-tech-arabtech-v07els:5432/postgres'
});

async function run() {
  await client.connect();
  const res = await client.query('SELECT username, api_key FROM customers WHERE api_key IS NOT NULL LIMIT 1');
  console.log(res.rows);
  await client.end();
}
run();
