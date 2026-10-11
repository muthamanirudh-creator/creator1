# Advanced Strategy Suite (v2.5)

An additive layer on top of v2.4. **No existing route, screen, table or test was removed or changed in behaviour**
(one bug fix, listed below). Everything here is *stateless*: your profile is sent with each request, used to compute the
answer and not stored on the server. It works signed-out, in `node standalone.js` and in the PostgreSQL runtime.

Open it from the new **Strategy** tab (also in the ⌘K palette).

| Tool | What it does | Grounding |
|---|---|---|
| **Brief** | KPIs, best next moves, closing soon, conflicts, fee total; `.ics` export with 3-day and 1-day alarms; print; opt-in browser deadline reminders | Verified records only |
| **Decision matrix** | Six weighted criteria (eligibility, time to apply, prep time, seats open to *your* category, fee, age headroom). You move the sliders; every row shows raw value, 0-100 score and weight share. Criteria with no verified value are excluded and weights renormalised. "Top-3 stability" re-ranks under 12 perturbed weightings | Same eligibility engine as the rest of the app |
| **Deadlines** | 12-week agenda, exam same-day / close-together clashes, application crunch (3+ closing in 7 days), apply-by nudge, fee table (unknown fee never counted as zero) | Dates from verified records |
| **Age runway** | Per recruitment: age at the notification cutoff, your upper limit with listed relaxation, the date you pass the limit, last eligible cutoff, yearly cycles left, "last chance" flag | Same rule as `lib/eligibility.js` (completed years > limit) |
| **Study planner** | Day-by-day plan from exam date, hours/day, rest day, final-revision window, topic confidence and weight; mock-test slots; SM-2-style spaced revisions; a local spaced-revision deck with 0-5 recall rating | Deterministic; same input gives the same plan |
| **Mock analytics** | Per-topic accuracy with 95% Wilson interval, negative-marking break-even accuracy, attempt/avoid advice, pace vs time budget, trend across tests, marks to your own target | Numbers you enter |
| **What-if** | Re-runs eligibility on altered profiles (next qualification, final year completed, one year older, +2 years experience, or your own patches) and lists what opens or closes | Eligibility engine |
| **Portfolio** | Picks a feasible set of targets for your weekly hours using earliest-deadline feasibility; topics shared with an earlier exam are counted once. Also shows syllabus overlap between verified exams | Verified syllabi; hours are explicit planning assumptions |
| **Photo check** | Checks photo/signature dimensions, size and type against limits *you* enter from the notification, entirely in the browser | Local only |

## API (all `POST`, JSON, body `{ "profile": {...}, ... }`)

`/api/advanced/brief` · `runway` · `planner` · `rank` (`weights`) · `overlap` (`exams`) · `portfolio` (`weekly_hours`, `hours_per_topic`) ·
`study-plan` (`exam_date`, `hours_per_day`, `rest_weekday`, `mock_every_days`, `final_revision_days`, `topics[]`) ·
`analytics` (`attempts[]`, `marks_correct`, `marks_wrong`, `total_time_minutes`, `target_score`, `tests[]`) · `whatif` (`scenarios[]`) · `sm2` (`quality`, `state`).
`GET /api/advanced/meta` lists modules and defaults. Limits: 5,000 attempts, 200 topics, 100 job ids. Invalid input returns `400 {error}`.

## Honest limits

- Scores rank fit and practicality. They are **not** selection probabilities and no cut-offs are invented.
- Syllabus overlap matches topic names through an editable concept lexicon (`lib/advanced/overlap.js`); the same name can hide different depth.
- Only exams with a verified syllabus can have prep hours estimated. Demo links: `ssc-combined-graduate` -> SSC-CGL, `bank-po` -> BANK-PO. In production set `exam_code` on a recruitment or extend `JOB_EXAM`.
- Age runway assumes future notifications keep the same limits and cutoff month/day.
- Alerts/reminders in the Strategy tab run in your browser while it is open; server-side push still needs the existing worker and a provider.
- Demo-corpus recruitments are fictional; real facts must still arrive through the verified ingestion pipeline.

## Bug fixed

The profile form stores `exServiceman`, but the eligibility engine read `exServicemen`, so the ex-servicemen age relaxation was never applied from the main UI. `lib/eligibility.js` now accepts both spellings (the Bridge already did).

## Tests

`npm run test:advanced` runs `test-advanced.js` (17 engine / API / HTTP checks) and `test-advanced-ui.js` (9 DOM checks; needs `jsdom`, skipped if absent).
