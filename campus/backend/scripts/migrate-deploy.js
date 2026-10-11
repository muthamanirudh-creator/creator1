'use strict';
// Applies every Prisma migration to the production PostgreSQL database.
// Without this step the tables (User, PortalKV, ...) never exist on a fresh Render/Vercel/Neon
// database, so sign-up and login fail with "internal error".
//
// Uses DIRECT_URL (a non-pooled connection string) when provided, because `prisma migrate`
// cannot run through a PgBouncer / "transaction pooler" URL (Supabase 6543, Neon -pooler).
//
// v2.6.3: the Prisma CLI is now located dynamically (backend/node_modules, repo-root node_modules,
// or `npx`). Before, it was hard-coded to <repo-root>/node_modules/prisma, which does not exist on
// Render (prisma was a devDependency and NODE_ENV=production skips those) -> MODULE_NOT_FOUND.
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const url = String(process.env.DIRECT_URL || process.env.DATABASE_URL || '').trim();
if (!url) {
  console.warn('[migrate-deploy] DATABASE_URL is not set - skipping migrations. Accounts will NOT be stored until it is configured.');
  process.exit(0);
}

const backendDir = path.join(__dirname, '..');
const schema = path.join(backendDir, 'prisma', 'schema.prisma');

function findPrismaCli() {
  const searchRoots = [backendDir, path.join(backendDir, '..', '..'), process.cwd()];
  for (const root of searchRoots) {
    try {
      const pkg = require.resolve('prisma/package.json', { paths: [root] });
      const cli = path.join(path.dirname(pkg), 'build', 'index.js');
      if (fs.existsSync(cli)) return cli;
    } catch (_) { /* try next */ }
  }
  for (const root of searchRoots) {
    const cli = path.join(root, 'node_modules', 'prisma', 'build', 'index.js');
    if (fs.existsSync(cli)) return cli;
  }
  return null;
}

const env = { ...process.env, DATABASE_URL: url };
const opts = { stdio: 'inherit', env, cwd: backendDir };
const args = ['migrate', 'deploy', '--schema', schema];

const cli = findPrismaCli();
let result;
if (cli) {
  result = spawnSync(process.execPath, [cli, ...args], opts);
} else {
  console.warn('[migrate-deploy] Prisma CLI not found locally - falling back to npx.');
  result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', 'prisma@5', ...args], opts);
}
if (result.status !== 0) {
  console.error('[migrate-deploy] prisma migrate deploy FAILED. Check DATABASE_URL / DIRECT_URL.');
  process.exit(result.status || 1);
}
console.log('[migrate-deploy] Database schema is up to date.');
