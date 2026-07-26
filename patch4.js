const fs = require('fs');
const path = 'D:/pj/spider-store-front/frontend/src/components/admin/tabs/CategoriesTab.jsx';
let content = fs.readFileSync(path, 'utf8');

const target1 = '<div className="grid-cards-container">\r\n          {finalFilteredCats.map((cat) => (';
const new1 = '{finalFilteredCats.map((cat) => (';

const target1Alt = '<div className="grid-cards-container">\n          {finalFilteredCats.map((cat) => (';

content = content.replace(target1, new1);
content = content.replace(target1Alt, new1);

const target2 = '        ))}\r\n        </div>\r\n      </div>';
const new2 = '        ))}\r\n      </div>';

const target2Alt = '        ))}\n        </div>\n      </div>';
const new2Alt = '        ))}\n      </div>';

content = content.replace(target2, new2);
content = content.replace(target2Alt, new2Alt);

fs.writeFileSync(path, content, 'utf8');
console.log('CategoriesTab grid fixed');
