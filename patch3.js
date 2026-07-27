require('dotenv').config({ path: './.env' });
const { runQuery } = require("./db");

async function runPatch() {
  console.log("Applying patch for api_delivery_time...");
  try {
    await runQuery("ALTER TABLE services ADD COLUMN IF NOT EXISTS api_delivery_time VARCHAR(255) DEFAULT '';");
    console.log("api_delivery_time column added to services table.");
  } catch (err) {
    console.error("Error adding api_delivery_time column:", err);
  }
}

runPatch().catch(console.error);
