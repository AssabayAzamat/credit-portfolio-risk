import pg from 'pg';
export function connect() {
  // For local psql/CI, standard PG* variables are also supported.
  return new pg.Client(process.env.DATABASE_URL ? {connectionString: process.env.DATABASE_URL} : {
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 55432),
    user: process.env.PGUSER || 'analyst',
    database: process.env.PGDATABASE || 'credit_risk',
    password: process.env.PGPASSWORD || 'local_demo_only'
  });
}
