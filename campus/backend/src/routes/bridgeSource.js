// Campus side of the GovCareer Bridge (see src/services/bridgeSource.js for the rules).
//
//   GET    /api/bridge-source/link      student auth only        – is my Campus account linked to GovCareer?
//   DELETE /api/bridge-source/link      student auth only        – revoke from the Campus side (always allowed)
//   POST   /api/bridge-source/link      student auth + service signature – GovCareer records the link
//   GET    /api/bridge-source/profile   student auth + service signature – minimal skill evidence export
//
// "Service signature" = HMAC from the GovCareer server (see bridgeServiceAuth.js). Revoking needs no signature
// because it only ever reduces access.
const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const core = require('../services/bridgeSource');

const router = express.Router();
router.use(requireAuth);

const secret = () => String(process.env.BRIDGE_SERVICE_SECRET || '');
const pathOf = (req) => String(req.originalUrl || '').split('?')[0];

function requireService(req, res, next) {
  const verdict = core.checkService({
    secret: secret(), method: req.method, path: pathOf(req), accountId: req.get('x-bridge-account') || '', userId: req.user.sub,
    body: req.body && Object.keys(req.body).length ? req.body : null, headers: req.headers,
  });
  if (!verdict.ok) {
    const status = verdict.code === 'BRIDGE_NOT_CONFIGURED' ? 503 : 403;
    return res.status(status).json({ error: verdict.message, code: verdict.code });
  }
  req.bridgeAccountId = req.get('x-bridge-account') || '';
  next();
}

const send = (res, out) => res.status(out.status).json(out.body);
const fail = (res) => res.status(500).json({ error: 'Bridge request failed.' });

router.get('/link', async (req, res) => { try { send(res, await core.status({ prisma, userId: req.user.sub })); } catch (_) { fail(res); } });
router.delete('/link', async (req, res) => { try { send(res, await core.unlink({ prisma, userId: req.user.sub })); } catch (_) { fail(res); } });
router.post('/link', requireService, async (req, res) => {
  try { send(res, await core.link({ prisma, userId: req.user.sub, accountId: req.bridgeAccountId, body: req.body })); } catch (_) { fail(res); }
});
router.get('/profile', requireService, async (req, res) => {
  try { send(res, await core.profile({ prisma, userId: req.user.sub, accountId: req.bridgeAccountId })); } catch (_) { fail(res); }
});

module.exports = router;
