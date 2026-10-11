# v2.10.0 - All-India coverage, corrected Punjab domains, instant alerts

## What changed (additive; no earlier feature removed)
1. **Every State and Union Territory is covered.** `lib/nationalSources.js` adds ~75 official recruiters (commissions, subordinate/staff boards, police boards, central forces, banks, PSUs) on top of the earlier 20. All 36 States/UTs have at least one source (`GET /api/national/coverage`).
2. **Punjab corrected.** The zip had no Punjab source and the earlier pipeline could not detect Punjab notices. Added with the right domains: **Punjab PSC `ppsc.gov.in`** and **PSSSB `sssb.punjab.gov.in`** (both checked against live public pages on 2026-10-11), plus Punjab Police, PSPCL and the state portal. Pakistan's look-alike `ppsc.gop.pk` is explicitly blocked. Also corrected Bihar PSC to `bpsc.bihar.gov.in` (old `bpsc.bih.nic.in` is stale).
3. **Domain guard** (`lib/domainGuard.js`): https-only, official-domain-only, no foreign look-alikes, portal must sit inside its domain, state sources cannot sit on another state's sub-domain. Known wrong/stale domains found in an existing database are corrected on startup (audit-logged) and sent back to verification. Portals that fail 8 times in a row are flagged for human review (`GET /api/admin/national/domain-issues`).
4. **Faster detection.** Tier 1 sources (UPSC, SSC, IBPS, state commissions/boards) are checked every **5 min**, tier 2 every 10, tier 3 every 20 (was 30 for all). Admin-set intervals are never overwritten. Pending sources are retried hourly (was 6 h). Crawler also recognises corrigendum / short-notice / regional-language wording.
5. **Instant push alerts** (`lib/pushNotify.js`, `public/national.js`, service worker): phone/browser notifications when a new notice, deadline extension or amendment is published, filtered by State/UT and central recruiters. Once per device, retried with back-off, dead subscriptions removed. Unverified detections are opt-in and always labelled. Dispatch runs every 10 s.
6. **Atom feed** `/api/feed.atom` (verified kinds only) for any reader / bot.

## Honest limits
- Detection is **polling**: government sites offer no push/webhook, so the earliest an alert can arrive is the next check of that source (5-20 min) plus document reading time. It is fast, not instant to the second.
- Only Punjab (PPSC, PSSSB) and Bihar PSC domains were confirmed against live pages. The other new domains come from public knowledge and are **not assumed**: each is auto-verified at run time (reachable, HTML, mentions recruitment). If one is wrong it stays PENDING and shows under domain issues. Check `/api/national/coverage` after first run.
- Pages needing JavaScript rendering, CAPTCHAs or logins are not read.
- Auto-published records are machine-read (labelled AUTO_EXTRACTED). Always confirm on the official notice.
- Push needs HTTPS (or localhost), PostgreSQL, and a browser that supports Web Push (iOS: add to Home Screen first).

## Deploy
```
npm ci
npm run vapid        # optional: put keys in env; otherwise generated once into the database
npm start            # migrates (011), seeds, reconciles, verifies, monitors
```
Open the site > Overview > **Instant alerts** > Turn on alerts. Check `/api/national/coverage` and `/api/autolive/status`.

## Tests
`npm test` (adds `test-national.js`, 35 checks). Run with PostgreSQL via `npm run test:db:setup`.
