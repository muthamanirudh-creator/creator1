'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const root = path.resolve(__dirname, '..');
const schema = path.join(root, 'campus', 'backend', 'prisma', 'schema.prisma');
const r = spawnSync(process.execPath, [path.join(root, 'node_modules', 'prisma', 'build', 'index.js'), 'generate', '--schema', schema], {stdio:'inherit', cwd:root, env:process.env});
if (r.status !== 0) process.exit(r.status || 1);
console.log('Unified GovCareer + Campus Portal setup complete.');
