const { allQuery, runQuery } = require('./db');

async function removeDuplicates() {
  console.log("[Auto Clean] Starting deduplication...");
  
  // 1. Deduplicate Categories
  const categories = await allQuery('SELECT * FROM categories ORDER BY id ASC');
  const catGroups = {};
  for (const cat of categories) {
    const name = (cat.name || '').trim().toLowerCase();
    if (!catGroups[name]) catGroups[name] = [];
    catGroups[name].push(cat);
  }
  
  let deletedCats = 0;
  for (const name in catGroups) {
    const list = catGroups[name];
    if (list.length > 1) {
      const kept = list[0];
      for (let i = 1; i < list.length; i++) {
        const dup = list[i];
        await runQuery('UPDATE services SET category_id = ? WHERE category_id = ?', [kept.id, dup.id]);
        await runQuery('DELETE FROM categories WHERE id = ?', [dup.id]);
        deletedCats++;
      }
    }
  }

  // 2. Deduplicate Services
  const services = await allQuery('SELECT * FROM services ORDER BY id ASC');
  const srvGroups = {};
  for (const srv of services) {
    const key = `${srv.category_id}_${(srv.name || '').trim().toLowerCase()}`;
    if (!srvGroups[key]) srvGroups[key] = [];
    srvGroups[key].push(srv);
  }

  let deletedSrvs = 0;
  let updatedPackages = 0;
  
  for (const key in srvGroups) {
    const list = srvGroups[key];
    const kept = list[0];
    
    // Deduplicate packages within the kept service
    if (kept.packages && kept.packages !== '[]') {
      try {
        let pkgs = typeof kept.packages === 'string' ? JSON.parse(kept.packages) : kept.packages;
        if (Array.isArray(pkgs)) {
          const uniquePkgs = [];
          const seenPkgNames = new Set();
          for (const pkg of pkgs) {
            const pkgName = (pkg.name || '').trim().toLowerCase();
            if (!seenPkgNames.has(pkgName)) {
              seenPkgNames.add(pkgName);
              uniquePkgs.push(pkg);
            }
          }
          if (uniquePkgs.length !== pkgs.length) {
             await runQuery('UPDATE services SET packages = ? WHERE id = ?', [JSON.stringify(uniquePkgs), kept.id]);
             updatedPackages++;
          }
        }
      } catch(e) {
        console.error("[Auto Clean] Error parsing packages for service", kept.id, e.message);
      }
    }

    if (list.length > 1) {
      for (let i = 1; i < list.length; i++) {
        const dup = list[i];
        await runQuery('UPDATE orders SET service_id = ? WHERE service_id = ?', [kept.id, dup.id]);
        await runQuery('DELETE FROM services WHERE id = ?', [dup.id]);
        deletedSrvs++;
      }
    }
  }
  
  if (deletedCats > 0 || deletedSrvs > 0 || updatedPackages > 0) {
    console.log(`[Auto Clean] Deleted ${deletedCats} duplicate categories, ${deletedSrvs} duplicate services, deduplicated packages in ${updatedPackages} services.`);
  } else {
    console.log(`[Auto Clean] No duplicates found.`);
  }
}

module.exports = { removeDuplicates };

// If run directly
if (require.main === module) {
  removeDuplicates().then(() => process.exit(0)).catch(e => {
    console.error(e);
    process.exit(1);
  });
}
