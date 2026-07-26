const fs = require('fs');
const path = 'D:/pj/spider-store-front/frontend/src/components/admin/tabs/OrdersTab.jsx';
let content = fs.readFileSync(path, 'utf8');

const targetProps = '  filteredWalletTransactions\r\n}) {';
const newProps = '  filteredWalletTransactions,\r\n  apiProviders = []\r\n}) {';

if (content.includes(targetProps)) {
  content = content.replace(targetProps, newProps);
  
  const targetRender = '                  {order.api_order_id && (';
  const newRender = `                  {order.api_provider_id && (
                    <div style={{ fontSize: "0.75rem", background: "rgba(34, 211, 238, 0.12)", color: "#22d3ee", padding: "4px 10px", borderRadius: "8px", display: "inline-flex", gap: "6px", alignItems: "center", marginTop: "6px", fontWeight: "bold" }}>
                      <span>🔗 مرتبط بمزود: {apiProviders.find(p => p.id === order.api_provider_id)?.name || \`مجهول (\${order.api_provider_id})\`}</span>
                    </div>
                  )}
                  {order.api_order_id && (`.trim();
  
  if (content.includes(targetRender)) {
    content = content.replace(targetRender, newRender);
    fs.writeFileSync(path, content, 'utf8');
    console.log('OrdersTab patched successfully');
  } else {
    console.log('Render target not found');
  }
} else {
  console.log('Props target not found');
}
