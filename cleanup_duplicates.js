const { getAll, runQuery } = require('./db');

async function cleanupCategories() {
  console.log("Cleaning up categories...");
  const categories = await getAll('SELECT * FROM categories');
  if (!categories || categories.length === 0) return;
  const groups = {};
  for (const cat of categories) {
    if (!groups[cat.name]) groups[cat.name] = [];
    groups[cat.name].push(cat);
  }
  let deleted = 0;
  for (const name in groups) {
    const list = groups[name].sort((a, b) => a.id - b.id);
    if (list.length > 1) {
      const kept = list[0];
      for (let i = 1; i < list.length; i++) {
        const dup = list[i];
        // Move services to kept category
        await runQuery('UPDATE services SET category_id = $1 WHERE category_id = $2', [kept.id, dup.id]);
        // Delete dup
        await runQuery('DELETE FROM categories WHERE id = $1', [dup.id]);
        deleted++;
      }
    }
  }
  console.log(`Deleted ${deleted} duplicate categories.`);
}

async function cleanupServices() {
  console.log("Cleaning up services...");
  const services = await getAll('SELECT * FROM services');
  if (!services || services.length === 0) return;
  const groups = {};
  for (const srv of services) {
    const key = `${srv.category_id}_${srv.name}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(srv);
  }
  let deleted = 0;
  for (const key in groups) {
    const list = groups[key].sort((a, b) => a.id - b.id);
    if (list.length > 1) {
      const kept = list[0];
      for (let i = 1; i < list.length; i++) {
        const dup = list[i];
        // Move packages
        await runQuery('UPDATE packages SET service_id = $1 WHERE service_id = $2', [kept.id, dup.id]);
        // Delete dup
        await runQuery('DELETE FROM services WHERE id = $1', [dup.id]);
        deleted++;
      }
    }
  }
  console.log(`Deleted ${deleted} duplicate services.`);
}

async function cleanupPackages() {
  console.log("Cleaning up packages...");
  const packages = await getAll('SELECT * FROM packages');
  if (!packages || packages.length === 0) return;
  const groups = {};
  for (const pkg of packages) {
    const key = `${pkg.service_id}_${pkg.name}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(pkg);
  }
  let deleted = 0;
  for (const key in groups) {
    const list = groups[key].sort((a, b) => a.id - b.id);
    if (list.length > 1) {
      const kept = list[0];
      for (let i = 1; i < list.length; i++) {
        const dup = list[i];
        await runQuery('DELETE FROM packages WHERE id = $1', [dup.id]);
        deleted++;
      }
    }
  }
  console.log(`Deleted ${deleted} duplicate packages.`);
}

(async () => {
  try {
    await cleanupCategories();
    await cleanupServices();
    await cleanupPackages();
    console.log("Cleanup completed successfully.");
    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
})();
