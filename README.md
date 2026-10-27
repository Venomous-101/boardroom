# Boardroom

## What it is

Boardroom is a live board of AI advisor simulations for hard business decisions. Bring one decision with options, and eight advisor seats debate it in rounds, vote on a draft resolution, and hand you a scored verdict with conditions, next steps, a cheapest test, kill criteria, and a minority report.

Three modes: Full debate (the whole council), Quick (openings, vote, verdict, no debate rounds and no draft stage), and Consult (one seat answers a single question directly, with no scoring and no saved session).

The app is a static page plus one small server function. There is no database, no account, no analytics, and no tracking. Past debates are stored only in your browser.

## The board

Each seat is an AI simulation inspired by public business frameworks. The seats are not the real people, do not speak for them, and nothing here is affiliated with or endorsed by them. The room shows each seat's portrait; the portraits below are the same illustrations.

| Portrait | Seat | Role | Focus |
| --- | --- | --- | --- |
| <img src="assets/avatars/operator.png" alt="Operator" width="80"> | **Operator** (Bezos mould) | Strategy and decisions | Sorts one-way doors from two-way doors, and bets on the customer over the long term. |
| <img src="assets/avatars/offer.png" alt="Offer" width="80"> | **Offer** (Hormozi mould) | Offers, pricing, and sales | Judges every offer by its value equation, prices for the outcome, and reverses risk with guarantees. |
| <img src="assets/avatars/investor.png" alt="Investor" width="80"> | **Investor** (Buffett mould) | Money and capital | Demands a moat and a margin of safety, and judges every move by what it does to cash. |
| <img src="assets/avatars/marketer.png" alt="Marketer" width="80"> | **Marketer** (Gary Vaynerchuk mould) | Marketing and attention | Finds where attention is underpriced, and earns the right to sell by giving value first. |
| <img src="assets/avatars/philosopher.png" alt="Philosopher" width="80"> | **Philosopher** (Naval Ravikant mould) | Leverage and wealth | Asks whether a move builds leverage and equity you own, or just rents out your time. |
| <img src="assets/avatars/founder.png" alt="Founder" width="80"> | **Founder** (Paul Graham mould) | Product and startups | Tests for real demand from a small group of users, and grows from what they actually do. |
| <img src="assets/avatars/saas.png" alt="SaaS" width="80"> | **SaaS** (Dan Martell mould) | People, hiring, and founder time | Buys back the founder's time, hires for the bottleneck, and watches acquisition cost against lifetime value. |
| <img src="assets/avatars/eos.png" alt="EOS" width="80"> | **EOS** (Gino Wickman mould) | Operations and scaling | Turns vision into traction with quarterly rocks, scorecards, owners, and numbers. |

You can add one custom advisor seat: a name (60 characters max) and the viewpoint it must argue from (500 characters max). It joins the debate like any other seat, shown with its initials.

## How a debate works

1. Describe the decision: a title (200 characters max), context (4,000 characters max), and up to 4 options. "Do nothing" is added automatically when you leave it out, so the board always weighs doing nothing.
2. Pick a mode (Full, Quick, or Consult), debate rounds for Full mode (1 to 3), a focus (balanced, cost, speed, or risk), a provider, and a model. The model field is editable.
3. Optionally add one custom advisor. In Consult mode you pick one seat (or your custom advisor) instead.
4. The Director frames the decision: a brief under 200 words, weights from 1 to 3 per advisor with one-line reasons, 1 to 3 cruxes (the underlying disagreements), and assumptions.
5. Opening votes: every advisor posts a stance, scores for every option, a pillar score, confidence from 1 to 5, ruin risk, a door call (one-way or two-way), and what would change its mind.
6. Debate rounds (Full mode only): each advisor answers the cruxes, rebuts the seat it disagrees with most, concedes the strongest point against it, updates its scores, and lists checkable conditions for yes.
7. Draft resolution (Full mode only): conditions, next steps, cheapest test, kill criteria, hidden risks, trade-offs, and a revisit line. The recommendation itself is computed by the app from scores and overrides, never taken from the model alone. If the draft depends on a prerequisite that is not met yet, the verdict is WAIT with the trigger named.
8. Final vote (ratification): every advisor votes Endorse, Endorse with amendment, or Dissent, with a final score for the resolution, a final pillar score, and amendment or dissent text. Amendments from endorsing seats are carried when the resolution passes; dissenting amendments go to the minority report.
9. Read the verdict sheet: label and call, option bars with weighted maths, why it won (top 3 seat arguments), the pillar scorecard with named fixes for any pillar at 4 or below, conditions, next steps, cheapest test, kill criteria, revisit, overrides, and the minority report, with full detail collapsible. Copy the transcript, download the Markdown summary, or print to PDF. Past debates reload from your browser history.

The room shows the debate live: a progress stepper (Brief, Openings, Fault lines, Debate, Draft, Vote, Verdict), the seats' portraits around the stage with the current speaker lit, risen, and glowing while everyone else dims, the conversation as it happens, and a key-points panel with one line per seat. Avatars animate with pure CSS and JS: the speaking seat bobs and pulses, idle seats breathe and blink, hovering a seat lifts it and shows its name, pillar, and Chair weight, and clicking a seat focuses its latest transcript entries and key points. Debate rounds show a rebuttal arrow from the speaker to the seat it rebuts. Motion honors prefers-reduced-motion.

A full debate costs 26 LLM calls at 1 round, 34 at 2 rounds, and 42 at 3 rounds, plus one call per step if you add a custom advisor. A quick debate costs 17 calls. A consult costs 1 call. Calls run sequentially with live progress, which keeps free-tier rate limits in range. Each call has a 90 second timeout on the page side and a 60 second limit in the server function. If a call fails, the app names the exact advisor and round, offers a retry for that step only without losing the debate, and offers a one-click provider switch. It never switches providers silently. If the other provider has no server key, the error says so plainly.

## How scoring works

- Every advisor scores every option from 0 to 10.
- Each option's score is the weighted average across advisors, shown to one decimal with its math line.
- Verdict bands on the recommended option: GO at 7.5 and above, GO WITH CONDITIONS at 6.0 to 7.4, RESHAPE at 4.5 to 5.9, DON'T DO IT below 4.5. WAIT replaces the band when the recommendation depends on an unmet prerequisite with a named trigger.
- Ruin cap: if any advisor flags likely ruin risk on the recommended option, the verdict is capped at RESHAPE.
- One-way door cap: if a majority calls the recommended option a one-way door and the spread is 4 or more, the verdict is capped at GO WITH CONDITIONS.
- Support for the resolution is the weighted average of final votes. Confidence combines average confidence with the spread (highest minus lowest seat score on the recommended option).
- The pillar scorecard shows every seat's final pillar score, with a named fix for any pillar at 4 or below, sourced from that seat's own line.
- Why it won lists the three strongest arguments for the recommended option, ranked by pillar score, taken from the latest cards.
- Ratification: amendments from endorsing seats are carried when the resolution passes; dissenting amendments go to the minority report. Dissent is reported in full in the minority report, never smoothed over.
- The app computes every number deterministically. It never invents scores.

## Setup and keys

No API key is entered in the page, and no key is stored in the browser. The page calls this deployment's own server function (`api/chat.js`), and that function calls the provider with a key from the server environment.

- Providers: Groq is the primary, Google Gemini is the fallback. Both offer free tiers.
- Defaults: Groq openai/gpt-oss-120b, Gemini gemini-2.0-flash. The model field is editable, so you can use any model the server key can call.
- Environment variables, set in the hosting dashboard (never in the repo): `GROQ_API_KEY` for Groq, `GEMINI_API_KEY` for Gemini. A provider without its variable returns a clear "not configured" error instead of failing silently. `.env.example` lists the names with blank values.
- Your dilemma text goes only to the chosen provider, as part of the debate prompts, via your own server function. Past debates are stored only in your browser. Clearing your browser data removes them.
- The server function is same-origin only: it sends no CORS headers, so other websites cannot call it from a browser. It also caps prompt sizes and rate-limits per address. That rate limit is a tripwire, not authentication: this setup is built for a private single-user deployment. Keep the deployment URL private, and turn on your host's deployment protection if it offers one, so only you can open the app.

## Run it locally

The full app, including the server function, runs with the Vercel CLI:

```bash
cd boardroom
npx vercel dev
```

Then open the local address it prints. A plain static file server (for example `python3 -m http.server 8000`) shows the page, but debates need the server function, so use `vercel dev` for real runs.

## Deploy your own

This repo is meant to be forked and deployed by its owner, not used as a hosted service. There is no live demo link in this repo on purpose.

1. Fork the repository.
2. In Vercel, import the fork, set no build command, and set the output directory to the folder containing `index.html` (the repo root). The `api/` folder is picked up automatically as server functions. There is nothing to build and nothing to install.
3. In the project settings, add the environment variables: `GROQ_API_KEY`, and `GEMINI_API_KEY` if you want the fallback.
4. Redeploy, then open your deployment and run a debate.
5. Keep your deployment URL private. Do not publish it in the repo, a post, or a README.

## Security notes

- No database, no accounts, no analytics, no tracking, and no cookies set by the app. Nothing you type is stored on any server.
- No secrets in this repository: no API keys, tokens, personal data, or deployment URLs.
- Pasted content is never executed. It is parsed as text only: no eval, no new Function, and all dynamic text is escaped before rendering.
- The app loads no external scripts, styles, fonts, or trackers. The only hosts involved are your own deployment and the provider API it calls server-side.
- Input limits protect the server key from runaway usage: title 200 characters, context 4,000 characters, at most 4 user options, rounds capped at 3, and prompt caps in the server function.
- See SECURITY.md for the full threat model.

## Tests

```bash
node tests/harness.js
```

The harness drives the debate state machine with canned provider responses and asserts scoring, verdicts, overrides, dissent, ratification, pillar fixes, top reasons, quick and consult modes, brain fields, exports, and input limits: 76 checks, all passing. It is not loaded by the app, and the production app ships no mock mode.

## Credit

Council protocol and viewer components adapted from Nate Herk's Roast Room (open-source, MIT License, Copyright 2026 AI Automation Society). The adaptation is original expression: Boardroom's seats, portraits, distilled brains, prompts, scoring, and code are its own, and no Roast Room portraits, brain text, or quoted material are included. Built independently, not affiliated with Nate Herk. Advisor brains here are distilled originals: they contain no verbatim quotes from real people.

## License

MIT. See [LICENSE](LICENSE).
