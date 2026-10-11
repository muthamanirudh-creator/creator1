# GovCareer AI — Working Runtime Guide

## Zero-dependency demo (recommended for judging/demo)

Requirements: Node.js 18+

```bash
node standalone.js
```

Open: http://localhost:3000

This mode provides the public intelligence experience without PostgreSQL or an AI API key. It includes a built-in verified demo corpus, live profile catalogs, search, eligibility, grounded assistant, graph, exams/syllabus, mock tests, career paths, application cockpit, privacy and calendar demo endpoints.

## Production runtime

```bash
npm ci
npm start
```

Set PostgreSQL and other environment variables using `.env.example`.

## PostgreSQL

```bash
docker compose up --build
```

## Important

The built-in opportunities are explicitly labelled as demonstration records. They must not be presented as current real government vacancies. Production recruitment facts should enter through the official-source ingestion, verification, review and publication pipeline.

## Browser cache

The service-worker cache is versioned. If an older development build was previously installed, refresh once after deployment. The new service worker is `govcareer-shell-v8`.

## Running the full test suite
`npm test` includes Phase 2, which needs PostgreSQL. One-time setup: `npm run test:db:setup`
(or point `TEST_DATABASE_URL` at any empty database). The Hindi/Telugu OCR check also needs the
Tesseract language packs (`apt install tesseract-ocr-hin tesseract-ocr-tel`).
If `npm ci` complains about the lockfile, use the `package-lock.json` shipped in this release.
