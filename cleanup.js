const db = require('./db');

(async () => {
  try {
    console.log('=== بدء عملية تنظيف التكرارات ===');

    // 1. تنظيف الأقسام المكررة
    const categories = await db.allQuery('SELECT * FROM categories');
    if (categories && categories.length > 0) {
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
            await db.runQuery('UPDATE services SET category_id = $1 WHERE category_id = $2', [kept.id, dup.id]);
            await db.runQuery('DELETE FROM categories WHERE id = $1', [dup.id]);
            deleted++;
          }
        }
      }
      console.log(`تم حذف ${deleted} قسم مكرر.`);
    } else {
        console.log('لا يوجد أقسام لفحصها أو لم يتم العثور عليها.');
    }

    // 2. تنظيف الخدمات المكررة
    const services = await db.allQuery('SELECT * FROM services');
    if (services && services.length > 0) {
      const groups = {};
      for (const srv of services) {
        const key = srv.category_id + '_' + srv.name;
        if (!groups[key]) groups[key] = [];
        groups[key].push(srv);
      }
      let deletedSrv = 0;
      for (const key in groups) {
        const list = groups[key].sort((a, b) => a.id - b.id);
        if (list.length > 1) {
          const kept = list[0];
          for (let i = 1; i < list.length; i++) {
            const dup = list[i];
            await db.runQuery('DELETE FROM services WHERE id = $1', [dup.id]);
            deletedSrv++;
          }
        }
      }
      console.log(`تم حذف ${deletedSrv} خدمة مكررة.`);
      
      // 3. تنظيف الباقات المكررة داخل الخدمات
      let updatedPkgs = 0;
      for (const srv of services) {
        let pkgs = [];
        try { pkgs = typeof srv.packages === 'string' ? JSON.parse(srv.packages) : srv.packages; } catch(e){}
        if (Array.isArray(pkgs)) {
          const pGroups = {};
          for (const p of pkgs) {
             const pName = p.name || 'Unnamed';
             if (!pGroups[pName]) pGroups[pName] = p; // Keep only one
          }
          const uniquePkgs = Object.values(pGroups);
          if (uniquePkgs.length < pkgs.length) {
            await db.runQuery('UPDATE services SET packages = $1 WHERE id = $2', [JSON.stringify(uniquePkgs), srv.id]);
            updatedPkgs++;
          }
        }
      }
      console.log(`تم تنظيف الباقات المكررة في ${updatedPkgs} خدمة.`);
    } else {
        console.log('لا يوجد خدمات لفحصها أو لم يتم العثور عليها.');
    }

    console.log('=== تمت عملية التنظيف بنجاح! ===');
    process.exit(0);
  } catch(e) {
    console.error('حدث خطأ أثناء التنظيف:', e);
    process.exit(1);
  }
})();
