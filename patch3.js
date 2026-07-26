const fs = require('fs');
const path = 'D:/pj/spider-store-front/frontend/src/components/admin/tabs/CategoriesTab.jsx';
let content = fs.readFileSync(path, 'utf8');

const targetFunction = '  const handleSelectAll = () => {';
const newFunction = `  const handleBulkToggleVisibility = async (show) => {
    if (!window.confirm('هل أنت متأكد من ' + (show ? 'إظهار' : 'إخفاء') + ' الأقسام المحددة (' + selectedCats.length + ')؟')) return;
    for (const id of selectedCats) {
      await handleToggleCategoryMenuVisibility(id, show);
    }
    setSelectedCats([]);
  };

  const handleSelectAll = () => {`;
content = content.replace(targetFunction, newFunction);

const targetButtons = `<button 
                onClick={() => handleOpenMergeCategories(selectedCats, () => setSelectedCats([]))} 
                className="action-btn"
                style={{ background: "linear-gradient(135deg, #4f46e5 0%, #8b5cf6 100%)", color: "white", padding: "8px 16px", borderRadius: "8px" }}
              >
                🔗 تجميع الأقسام
              </button>`;
const newButtons = `<button onClick={() => handleBulkToggleVisibility(true)} className="action-btn" style={{ background: "rgba(16, 185, 129, 0.15)", color: "#10b981", border: "1px solid rgba(16, 185, 129, 0.3)", padding: "8px 16px", borderRadius: "8px" }}>👁️ إظهار بالقائمة</button>
              <button onClick={() => handleBulkToggleVisibility(false)} className="action-btn" style={{ background: "rgba(239, 68, 68, 0.15)", color: "#ef4444", border: "1px solid rgba(239, 68, 68, 0.3)", padding: "8px 16px", borderRadius: "8px" }}>👁️‍🗨️ إخفاء من القائمة</button>
              ${targetButtons}`;
content = content.replace(targetButtons, newButtons);

fs.writeFileSync(path, content, 'utf8');
console.log('CategoriesTab patched successfully');
