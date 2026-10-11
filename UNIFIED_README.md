# GovCareer AI — Unified Edition

This package combines both supplied projects without intentionally deleting their feature sets:

## 1. GovCareer AI
- real-time government recruitment intelligence
- official-source monitoring
- recruitment search and filters
- eligibility engine
- AI assistant and grounded answers
- answer audit trail and claim verification
- source lineage and document/page evidence
- knowledge graph
- exam/syllabus intelligence
- study plans and mock tests
- career paths
- alerts and application tracking
- citizen account/documents/preferences
- multilingual/voice support
- PostgreSQL persistence with resilient demo mode

## 2. Integrated P1 AI Campus Portal
Available at `/campus/` on the same origin:
- AI assistant and streaming AI
- AI/ML career matching, skill-gap, benchmark, market intelligence, career path and roadmap
- resume AI/ML workflows
- mock interview and teacher voice features
- knowledge graph
- digital twin/adaptive recommendations
- aptitude progress
- authentication and saved results
- gate passes and public verification
- portal/admin authentication and AI configuration
- storage/sync
- face/fingerprint login capabilities
- PPT/PDF and placement/training frontend tools
- bundled frontend data/assets
- FastAPI AI/ML service and Node fallback mechanisms

## One login
The Campus login is the only login screen. GovCareer uses that session (single sign-on) and the header Sign in button goes to it. See RELEASE_NOTES.md (v2.4).

## Bridge
The Bridge tab joins both projects: Campus skill evidence and your resume matched to verified government jobs, with a consented two-sided account link. See `BRIDGE.md`.

## Unified runtime
- GovCareer is the public server on `PORT` (default 3000).
- The Campus backend runs internally on `CAMPUS_PORT` (default 3101).
- `/campus/*` and Campus-only `/api/*` routes are bridged through the GovCareer origin.
- Both applications therefore use one public URL and one browser origin.
- PostgreSQL can be shared through `DATABASE_URL`; the two schemas use different table names.

## Start
1. Copy `.env.example` to `.env` and set real secrets for deployment.
2. Install Node dependencies: `npm install`.
3. Generate the Campus Prisma client: `npm run campus:prisma:generate`.
4. Start PostgreSQL and set `DATABASE_URL`.
5. Run `npm start`.
6. Open `http://localhost:3000/` for GovCareer and `http://localhost:3000/campus/` for the integrated Campus Portal.

The Campus backend may automatically start its FastAPI AI/ML service when configured, preserving the supplied P1 runtime behavior.

## Important
Never commit real API keys, database passwords, JWT secrets, encryption keys or admin passwords. Use environment variables or the application's secure admin configuration facilities.
