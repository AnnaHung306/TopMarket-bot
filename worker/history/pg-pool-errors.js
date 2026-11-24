const guarded = new WeakSet();

// A dropped idle connection must not terminate the Discord process. A checked-out
// client can also emit an error between statements, before the next query rejects.
export function protectPostgresPool(pool, { logger = console, scope = 'postgres' } = {}) {
  if (guarded.has(pool) || typeof pool.on !== 'function') return pool;
  guarded.add(pool);
  const report = error => logger.error('postgres_connection_error', scope, error.code || error.name);
  pool.on('error', report);
  pool.on('connect', client => client.on('error', report));
  return pool;
}
