// Usage: ADMIN_PASSWORD='at-least-10-chars' node scripts/create-admin.js you@example.com "Your Name" [ADMIN|REVIEWER|VIEWER]
const db = require('../lib/db'); const auth = require('../lib/auth');
(async () => {
  const [email, name, role = 'ADMIN'] = process.argv.slice(2);
  if (!email || !name || !process.env.ADMIN_PASSWORD) { console.error('Usage: ADMIN_PASSWORD=... node scripts/create-admin.js email "Name" [ROLE]'); process.exit(1); }
  await db.migrate(); const u = await auth.createUser(email, name, process.env.ADMIN_PASSWORD, role); console.log('Created', u.email, u.role); await db.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
