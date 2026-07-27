require('dotenv').config();
const { allQuery } = require("./db");
async function test() {
  const orders = await allQuery("SELECT id, service_id, custom_fields, player_id, phone FROM orders ORDER BY id DESC LIMIT 5");
  console.log("Last 5 Orders:");
  console.log(JSON.stringify(orders, null, 2));

  for (const o of orders) {
    const service = await allQuery(`SELECT id, name, api_provider_id, api_service_id, api_source FROM services WHERE id = ${o.service_id}`);
    console.log(`Service for order ${o.id}:`, JSON.stringify(service[0]));
  }
}
test().catch(console.error);
