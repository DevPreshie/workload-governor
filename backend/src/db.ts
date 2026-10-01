/**
 * db.ts — PostgreSQL connection pool
 *
 * Exposes a single Pool instance shared across all modules.
 * Connection parameters are read from environment variables:
 *   DATABASE_URL  (preferred, takes precedence)
 *   PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD
 *
 * Pool sizing is configurable via environment variables (issue #561):
 *   DB_POOL_MIN: minimum connections kept alive (default: 2)
 *   DB_POOL_MAX: maximum connections allowed   (default: 10)
 *   DB_IDLE_TIMEOUT: ms before idle connection is closed (default: 30000)
 *   DB_CONNECTION_TIMEOUT: ms to wait for a connection   (default: 5000)
 *
 * SQL DIALECT COMPATIBILITY AUDIT (#861):
 *   This module uses the node-postgres (pg) driver and targets PostgreSQL
 *   exclusively. SQLite is NOT supported as a backend database for the
 *   backend/ package. Integration tests run against PostgreSQL 15/16
 *   containers (see .github/workflows/backend-integration.yml).
 *   No SQLite-specific SQL or INSERT OR IGNORE constructs exist in this file.
 */

import pg from "pg";

const { Pool } = pg;

const poolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      min: parseInt(process.env.DB_POOL_MIN ?? "2", 10),
      max: parseInt(process.env.DB_POOL_MAX ?? "10", 10),
      idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT ?? "30000", 10),
      connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT ?? "5000", 10),
    }
  : {
      host:     process.env.PGHOST     ?? "localhost",
      port:     parseInt(process.env.PGPORT ?? "5432", 10),
      database: process.env.PGDATABASE ?? "workload_governor",
      user:     process.env.PGUSER     ?? "postgres",
      password: process.env.PGPASSWORD ?? "",
      min: parseInt(process.env.DB_POOL_MIN ?? "2", 10),
      max: parseInt(process.env.DB_POOL_MAX ?? "10", 10),
      idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT ?? "30000", 10),
      connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT ?? "5000", 10),
    };

export const pool = new Pool(poolConfig);

// Log and alert on unexpected idle-client errors (fixes issue #561)
pool.on("error", (err) => {
  console.error("[db] Unexpected error on idle DB client:", err.message, err.stack);
});

export interface IndexerCheckpoint {
  contract_id: string;
  last_ledger: number;
  last_ledger_hash: string | null;
  updated_at: Date;
}

/**
 * Persist indexer checkpoint to database transactionally.
 */
export async function saveCheckpoint(
  contractId: string,
  lastLedger: number,
  lastLedgerHash?: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO indexer_checkpoints (contract_id, last_ledger, last_ledger_hash, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (contract_id)
     DO UPDATE SET last_ledger = EXCLUDED.last_ledger,
                   last_ledger_hash = EXCLUDED.last_ledger_hash,
                   updated_at = NOW()`,
    [contractId, lastLedger, lastLedgerHash ?? null],
  );
}

/**
 * Retrieve indexer checkpoint for contract from database.
 */
export async function getCheckpoint(
  contractId: string,
): Promise<IndexerCheckpoint | null> {
  const res = await pool.query<IndexerCheckpoint>(
    `SELECT contract_id, last_ledger, last_ledger_hash, updated_at
     FROM indexer_checkpoints
     WHERE contract_id = $1`,
    [contractId],
  );
  return res.rows[0] ?? null;
}

export default pool;

