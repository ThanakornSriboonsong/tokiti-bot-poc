import { DB_PATH, openDb, seedDb } from "./db.ts";

const db = openDb(DB_PATH);
seedDb(db);
db.close();
console.log(`Seeded ${DB_PATH}`);
