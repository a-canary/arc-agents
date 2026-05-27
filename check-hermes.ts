import Database from 'bun:sqlite';

const home = '/home/aaron';

// Check all kanban.db locations
const dbs = [
  `${home}/vault/webui/kanban.db`,
  `${home}/.hermes/kanban.db`,
  `${home}/hermes/kanban.db`,
];

for (const path of dbs) {
  try {
    const db = new Database(path, { readonly: true });
    const rows = db.query("SELECT id, title, state FROM issues WHERE title LIKE '%hermes%' OR body_md LIKE '%hermes%';").all();
    console.log(`=== ${path} ===`);
    console.log(JSON.stringify(rows));
    db.close();
  } catch (e) {
    console.log(`=== ${path} === ERROR: ${e.message}`);
  }
}