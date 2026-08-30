export const PROJECTION_SCHEMA_VERSION = 1;

export const FROZEN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS executions(
  execution_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  workspace_id TEXT,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  base_revision TEXT,
  runtime TEXT,
  runtime_version TEXT,
  model TEXT,
  fingerprint_hash TEXT,
  artifact_path TEXT,
  worktree_path TEXT,
  review_bundle_id TEXT,
  retention_class TEXT,
  gc_eligible_at INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS workspaces(
  workspace_id TEXT PRIMARY KEY,
  canonical_path TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS workspace_locks(
  workspace_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  hostname TEXT NOT NULL,
  heartbeat_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS reviews(
  review_bundle_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  review_id TEXT,
  decision TEXT,
  review_hash TEXT,
  applied_at INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS artifacts(
  artifact_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  immutable INTEGER NOT NULL CHECK(immutable IN (0, 1))
) STRICT;

CREATE TABLE IF NOT EXISTS storage_usage(
  execution_id TEXT PRIMARY KEY,
  artifact_bytes INTEGER NOT NULL,
  worktree_bytes INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS storage_reservations(
  reservation_id TEXT PRIMARY KEY,
  reservation_set_id TEXT,
  execution_id TEXT NOT NULL,
  volume_id TEXT NOT NULL,
  reserved_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  pid INTEGER,
  hostname TEXT,
  roles_json TEXT,
  record_path TEXT,
  record_hash TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS recovery_cases(
  execution_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS projection_meta(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
`;
