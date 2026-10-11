# Trust & Evidence layer (v2.9.0)

Goal: reliable, evidence-backed decisions, not more AI features. Everything here is additive (migration `010_trust.sql`, `lib/trust/*`, `routes/trust.js`); no earlier feature was removed.

## Policy (enforced in code, `lib/trust/policy.js`)
- **Three independent facts per record:** verification (VERIFIED, PARTIALLY_VERIFIED, UNVERIFIED, DETECTED, CONFLICTED, RETRACTED, SAMPLE), amended (yes/no) and phase (upcoming, open, closing soon, closed, ...). `computeTrust` returns `display_status` plus a `why` list, so the UI can say exactly why a vacancy is shown as verified, detected, amended or ongoing.
- **Newly detected notices are UNVERIFIED/DETECTED.** Nothing is read from a merely detected link; no date, vacancy or qualification is stated for it.
- **Critical fields** (deadline, opening date, vacancies, age, qualification) are confirmed one by one by a named reviewer, at the *current value hash*, with document, page and an exact quote that must really appear on that page and contain the value. An amendment that changes the value makes the earlier confirmation stale.
- A confidence score is **not** accuracy. Human verification is never relaxed unless 200+ real, doubly-adjudicated notices are measured with a Wilson 95% lower bound of at least 0.98 (`humanVerificationRequired`).

## Evidence ledger (`lib/trust/ledger.js`)
Append-only, hash-chained (`evidence_ledger`, DB triggers block UPDATE/DELETE). Records confirmations, rejections, amendments, conflicts, flags, retractions, source checks and preserved documents with actor and time. `GET /api/admin/trust/ledger/verify` re-computes the chain and reports the first broken entry.

## Flags and source monitoring
- `flags.js`: immediate flags for changed deadlines, conflicting amendments and conflicting official documents; open flags push the record to CONFLICTED.
- `sourceMonitor.js`: changed page (normalised fingerprint), expired notice, date mismatch between page and record, broken/soft-404/unsafe links. `POST /api/admin/trust/monitor/run`; the scheduler runs the `trustMonitor` task.

## Eligibility engine
Age is computed in completed years on the notice's cutoff date (leap-day aware), with `max_kind`, category relaxation and ambiguity handling (`CONDITIONAL`). A missing rule gives `INSUFFICIENT_EVIDENCE`, never a guess. Each result lists failed criteria with the official rule, the person's value and the reason. `npm run eval:eligibility` checks 28 hand-calculated cases (28/28).

## AI guard (`lib/trust/aiGuard.js`)
Answers are ANSWERED_VERIFIED, ANSWERED_UNVERIFIED, CONFLICTING_OFFICIAL_SOURCES or INSUFFICIENT_EVIDENCE. The guard abstains when the record is only detected, when official documents disagree, or when the notice is silent. Output is split into official facts (with page citation), derived statements and generated guidance. `guardFreeText` finds invented dates, figures, qualifications and syllabus topics in model text.

## Alerts, Career Fit, Exam Prep, Accounts
- Alerts: per-person preferences (channels, event types, only-verified), dedup, retries, deadline-change and trust-flag alerts, and receipts that claim delivery only when the provider returned an id.
- Career Fit: transparent score parts, skill-gap explanation, recommendation outcomes measured (`/recommendation-outcomes/summary`).
- Exam Prep: syllabus status per version, question-quality checks (duplicates, missing key, unreviewed AI items), progress analytics with intervals, adaptive plans.
- Accounts: per-purpose revocable consents, session list/revoke, export and deletion, private documents.

## Endpoints
Public/user: `/api/trust/jobs`, `/jobs/:id`, `/policy`, `/recruitments/:id/history`, `/eligibility/:id`, `/guard/text`, `/career-fit/explain`, `/prep/*`, `/alert-preferences`, `/alerts/receipts`, `/consents`, `/sessions`.
Reviewer/admin (`/api/admin/trust`): `/recruitments/:id/sheet`, `/recruitments/:id/confirm`, `/recruitments/:id/scan`, `/flags`, `/flags/:id/resolve`, `/ledger/verify`, `/monitor/run`, `/evaluation/extraction`, `/evaluation/extraction/record`, `/evaluation/eligibility`.

## Measuring extraction (`npm run eval:extraction`)
Scores precision and recall per field against adjudicated gold (`eval/extraction/gold.js`). A wrong value counts as both FP and FN; abstaining on a field the notice does not state is a true negative. To add a real notice: set `provenance: 'REAL'`, the official `source_url`, `document_sha256` of the preserved original, `adjudicators >= 2`, the page text, and gold values quoted from it. `validateGold` rejects gold that does not appear in its own document.

## Honest limits
- Current numbers (critical precision 100%, 95% lower bound 96.5%; recall 93.8%) are on **18 synthetic cases**. Evidence grade is `SYNTHETIC_ONLY`: **no accuracy claim exists for real SSC, UPSC, railway, banking or state notices.** Known miss: UPSC prose layout.
- Not run in the build environment: the Express server and `test-account.js` (npm registry unreachable), PostgreSQL stores (migration 010 and pg stores are reviewed but untested against a live DB), jsdom UI test, and live-network monitoring. Run `npm install && npm test` and apply migration 010 before relying on them.
