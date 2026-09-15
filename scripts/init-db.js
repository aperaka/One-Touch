const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
});

(async () => {
  try {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    await pool.query(schema);
    console.log('One Touch database initialized successfully.');
  } catch (err) {
    console.error('Database initialization failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
