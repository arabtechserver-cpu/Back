const {query} = require('./psql');
query('SELECT id, package_id, "Requires" FROM "DhruService" WHERE id = $1', ['08a37d70-7fc9-4430-82a8-be4c3391b267'])
  .then(r => console.log(JSON.stringify(r.rows, null, 2)))
  .catch(console.error)
  .finally(() => process.exit(0));
