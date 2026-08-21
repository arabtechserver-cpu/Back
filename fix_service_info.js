const fs = require('fs');
let code = fs.readFileSync('routes/orderRoutes.js', 'utf8');

code = code.replace(
    /SELECT s\.name as service_name, s\.download_link, s\.download_link_title, s\.api_source, c\.name as category_name/,
    `SELECT s.name as service_name, s.download_link, s.download_link_title, s.api_source, s.api_provider_id, c.name as category_name`
);

fs.writeFileSync('routes/orderRoutes.js', code);
console.log("Fixed serviceInfo regex");
