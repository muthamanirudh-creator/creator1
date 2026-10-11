# Bridge — Campus skills and resume, matched to verified government jobs

Bridge is the layer that connects the two projects. It takes evidence about what a person can do, compares it
with what each government selection process actually tests, and answers three questions:

1. **Where do I stand?** a ranked list of open posts with an explainable fit and a plausible range.
2. **What do I do next?** the skill gaps that unlock the most posts per study hour, with concrete actions.
3. **What if…?** simulate reaching a skill level and see which posts move.

Nothing in the previous releases was removed or changed in behaviour: the eligibility engine, Exam Lab, document
vault, alerts, Campus portal and all earlier tests are untouched. Bridge only adds files, one migration, new routes
and one new tab.

## Rules Bridge will not break

| Rule | How it is enforced |
|---|---|
| Eligibility is decided only by `lib/eligibility.js` | Matcher calls `evaluate()` and treats it as a hard gate. Skills never turn "not eligible" into a match (test: *eligibility is a hard gate*). |
| Resume and self-declared skills are claims | Evidence carries `verified:false`; only graded Campus answers, tracked mastery, scored interviews and Exam Lab mock answers are `verified`. A strong claim cannot overwrite weak tested evidence. |
| Resume text is not stored | Parsed in memory; only the skills the student keeps (ids and a level hint) are saved, and only if they press *Save*. |
| Resume never feeds eligibility | Education found in a resume is a *suggestion* with a confirm button; DOB, category and domicile are never extracted. |
| Required skills are labelled | Each requirement is **STATED** (verified syllabus, notification subjects, explicit record skills) or **INFERRED** (selection-stage / domain rules) and the UI shows which. |
| Unknown is not zero | Skills with no evidence use a stated prior (25%) with a wide range; the UI shows "No evidence". |
| Time estimates are labelled | Hours per skill are conservative planning numbers; when a notification has no exam date, 60 days after close is assumed and said so. |

## How the two login systems are joined

GovCareer (citizen JWT, `Authorization: Bearer`) and Campus (`cp_access` HttpOnly cookie, Prisma users) keep their
own accounts. Bridge never merges them or shares a password; it creates a **consented, revocable link**:

```
Browser ── GovCareer bearer ──►  GovCareer server  ──(student's own Campus token  +  HMAC signature)──►  Campus
                                  bridge_links row                                                       PortalKV link record
```

* **Two-sided consent.** Linking writes a record on *both* sides. Campus releases data only while its own record is
  active and names the same GovCareer account. Revoking on either side stops the flow immediately; if Campus says
  "not linked", GovCareer revokes locally and deletes the cache.
* **Why the HMAC.** The Campus access token also lives in the student's browser. If Campus trusted the token alone,
  any script on that origin could link an attacker's GovCareer account or pull the profile. Every `link` / `profile`
  call must also carry `HMAC-SHA256(secret, method, path, accountId, userId, timestamp, bodyHash)` from the GovCareer
  server. Mismatched user, account, path, body or a stale timestamp (>2 min) is refused. Unlinking needs no signature
  because it only reduces access.
* **One Campus student ↔ one GovCareer account** (partial unique index on active links; Campus returns 409 if
  another account tries).
* **Minimal export** (`campus/backend/src/services/bridgeSource.js`): per-topic aptitude counts, competency levels,
  *summary* scores of interview / MirrorMentor / quiz / resume-analysis results, and skill names from resume analyses.
  Never passwords, tokens, face or fingerprint data, gate passes, attendance or transcripts (tests assert this).
* **Expired Campus session.** Campus tokens last minutes. GovCareer keeps the last export in `bridge_campus_cache`
  and uses it labelled **"Last export"**; the UI asks the student to open Campus to refresh. Unlinking deletes it.
* **Secret.** Unified mode generates a per-boot `BRIDGE_SERVICE_SECRET` and passes it to the Campus child. Separate
  deployments must set the same ≥32-char value on both services (and `CAMPUS_HOST`).

## How a match is scored

```
bridge score = 55% skill fit  +  20% eligibility  +  15% feasibility  +  10% resume text affinity
```

* **Skill fit** = Σ weight × min(1, your level ÷ target level), with a plausible range from evidence confidence.
* **Feasibility** = study hours needed ÷ hours available before the exam at your daily minutes (85% usable).
* **Text affinity** = TF-IDF cosine between the resume and the post (relative; only when a resume was provided).
* **Action** = deterministic: closed → not eligible → complete profile → prepare ahead → apply now (≥70) →
  apply and prepare (≥45) → build skills / stretch.

## Files

| Path | Purpose |
|---|---|
| `lib/bridge/taxonomy.js` | 24 shared skills; maps Campus topics, resume terms and syllabus sections |
| `lib/bridge/requirements.js` | derives STATED / INFERRED requirements per post |
| `lib/bridge/resumeParser.js` | deterministic resume → claims + unconfirmed education suggestion |
| `lib/bridge/evidence.js` | Campus / resume / self / Exam Lab → one skill profile with provenance |
| `lib/bridge/matcher.js` | match, gap analysis, study blocks, what-if diff, per-post explanation |
| `lib/bridge/service.js` | input sanitising and the analysis pipeline |
| `lib/bridge/api.js` | framework-independent handlers (Express + standalone share them) |
| `lib/bridge/campusClient.js`, `serviceAuth.js`, `store.js` | server-to-server client, HMAC, PostgreSQL |
| `campus/backend/src/{services,routes}/bridgeSource*.js` | Campus side of the link and the evidence export |
| `db/migrations/008_bridge.sql` | `bridge_links`, `bridge_settings`, `bridge_campus_cache`, `bridge_snapshots` (all cascade-delete) |
| `public/bridge.{js,css}` | Bridge tab |

## API

Public (work in every runtime, including the zero-dependency one): `GET /api/bridge/meta`,
`POST /api/bridge/resume/parse`, `POST /api/bridge/analyze`, `POST /api/bridge/jobs/:id/explain`.

Signed-in (PostgreSQL runtime): the same analyze/explain under `/api/account/bridge/…` plus
`GET|POST|DELETE /api/account/bridge/link`, `GET|PUT /api/account/bridge/settings`, `GET /api/account/bridge/history`.
Campus: `/api/bridge-source/link` (GET, DELETE need the student only; POST needs the HMAC) and `/profile` (HMAC).

`/api/account/export` now includes a `bridge` section; consent withdrawal revokes the link; account deletion
revokes the Campus side best-effort and cascades every Bridge table.

## Tests

```
npm run test:bridge           # 58 checks, no DB or browser needed
npm run test:bridge:browser   # real-browser flow (needs: npm i -D playwright && npx playwright install chromium)
```

## Known limits (deliberate, not hidden)

* Skill requirements for posts without a verified syllabus are inferences; the UI says so on each row.
* The taxonomy is a first version (24 skills); Campus topics outside it are ignored rather than guessed.
* Resume parsing is keyword-based and works for text; PDFs/DOCX must be pasted as text for now.
* Exam hours per skill are rough planning figures, not predictions.
* A live Campus refresh needs the student to be signed in to Campus in the same browser (access tokens are short-lived).
