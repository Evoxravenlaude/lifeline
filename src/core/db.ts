/**
 * Thin query layer that runs on either a real Postgres (DATABASE_URL) or an
 * embedded PGlite database (dev, tests, single-VPS installs). Same SQL both ways.
 */
import { config } from "./config.js";
import { log } from "./log.js";
import { MIGRATIONS } from "./migrations.js";
import { applySchemas } from "./plugins.js";

export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = any>(sql: string, params?: unknown[]): Promise<T | undefined>;
  close(): Promise<void>;
}

let instance: Db | null = null;

export async function getDb(): Promise<Db> {
  if (instance) return instance;
  instance = config.databaseUrl ? await openPostgres(config.databaseUrl) : await openPglite();
  await migrate(instance);
  return instance;
}

/** Used by tests to get an isolated in-memory database. */
export async function openTestDb(): Promise<Db> {
  const db = await openPglite("memory://");
  await migrate(db);
  return db;
}

async function openPostgres(url: string): Promise<Db> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: url });
  return {
    async query(sql, params = []) {
      const r = await pool.query(sql, params as any[]);
      return r.rows;
    },
    async one(sql, params = []) {
      const r = await pool.query(sql, params as any[]);
      return r.rows[0];
    },
    async close() {
      await pool.end();
    },
  };
}

async function openPglite(path = "./data/lifeline.pglite"): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite(path);
  return {
    async query(sql, params = []) {
      const r = await pg.query(sql, params as any[]);
      return r.rows as any[];
    },
    async one(sql, params = []) {
      const r = await pg.query(sql, params as any[]);
      return r.rows[0] as any;
    },
    async close() {
      await pg.close();
    },
  };
}

async function migrate(db: Db) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (id INT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
  const applied = new Set((await db.query<{ id: number }>(`SELECT id FROM schema_migrations`)).map((r) => Number(r.id)));
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    for (const stmt of m.sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
      await db.query(stmt);
    }
    await db.query(`INSERT INTO schema_migrations (id) VALUES ($1)`, [m.id]);
    log.info({ migration: m.id }, "migration applied");
  }
  await applySchemas(db);
}
