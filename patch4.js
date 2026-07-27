require('dotenv').config({ path: './.env' });
const { runQuery } = require("./db");

async function runPatch() {
  console.log("Applying patch for linked_categories...");
  try {
    await runQuery("ALTER TABLE categories ADD COLUMN IF NOT EXISTS linked_categories TEXT DEFAULT '[]';");
    console.log("linked_categories column added to categories table.");
  } catch (err) {
    console.error("Error adding linked_categories column:", err);
  }
}

runPatch().catch(console.error);
