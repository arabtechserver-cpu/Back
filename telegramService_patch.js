const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'utils', 'telegramService.js');
let code = fs.readFileSync(filePath, 'utf8');

// 1. Fix fields parsing (lines ~451-460)
code = code.replace(
    /let fields = \[\];\s*try \{\s*const category = await getQuery\('SELECT fields FROM categories WHERE id = \?', \[service\.category_id\]\);\s*if \(category && category\.fields\) \{\s*fields = typeof category\.fields === 'string' \? JSON\.parse\(category\.fields\) : category\.fields;\s*\}\s*\} catch\(e\) \{\}/g,
    `let fields = [];
    try {
      if (service.fields) {
        fields = typeof service.fields === 'string' ? JSON.parse(service.fields) : service.fields;
      } else {
        const category = await getQuery('SELECT fields FROM categories WHERE id = ?', [service.category_id]);
        if (category && category.fields) {
          fields = typeof category.fields === 'string' ? JSON.parse(category.fields) : category.fields;
        }
      }
    } catch(e) {}`
);

// 2. Fix AWAITING_ORDER_FIELD to generate player_id and custom_fields (around line 764)
code = code.replace(
    /setUserState\(chatId, 'CONFIRM_ORDER', data\);\s*let fieldsStr = data\.collected_fields\.map\(f => `\$\{f\.name\}: \$\{f\.value\}`\)\.join\('\\n'\);/g,
    `let playerId = '';
       let customFields = {};
       
       data.collected_fields.forEach(f => {
         customFields[f.id || f.name] = f.value;
       });
       if (data.collected_fields.length > 0) {
          playerId = data.collected_fields[0].value;
       }
       
       data.player_id = playerId;
       data.custom_fields = JSON.stringify(customFields);
       setUserState(chatId, 'CONFIRM_ORDER', data);
       
       let fieldsStr = data.collected_fields.map(f => \`\${f.name}: \${f.value}\`).join('\\n');`
);

// 3. Fix confirm_order insert (around line 539)
// It was: orderData.api_source, \n '{}'
code = code.replace(
    /orderData\.api_source,\s*'\{\}'/g,
    `orderData.api_source,\n        orderData.custom_fields || '{}'`
);

fs.writeFileSync(filePath, code);
console.log('Patch applied successfully!');
