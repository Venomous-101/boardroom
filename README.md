# Boardroom

## What it is

Boardroom is a live board of AI advisor simulations for hard business decisions. Bring one decision with options, and eight advisor seats debate it in rounds, vote on a draft resolution, and hand you a scored verdict with conditions, next steps, a cheapest test, kill criteria, and a minority report. Everything runs in your browser. There is no backend, no database, no account, and no tracking.

## The board

Each seat is an AI simulation inspired by public business frameworks. The seats are not the real people, do not speak for them, and nothing here is affiliated with or endorsed by them. In the app itself, avatars are initials only. The portraits below are illustrations made for this README.

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

You can add one custom advisor seat: a name (60 characters max) and the viewpoint it must argue from (500 characters max). It joins the debate like any other seat.

## How a debate works

1. Describe the decision: a title (200 characters max), context (4,000 characters max), and up to 4 options. "Do nothing" is added automatically when you leave it out, so the board always weighs doing nothing.
2. Pick debate rounds (1 to 3), a focus (balanced, cost, speed, or risk), a provider, and a model. The model field is editable.
3. Optionally add one custom advisor.
4. The Director frames the decision: a brief under 200 words, weights from 1 to 3 per advisor with one-line reasons, 1 to 3 cruxes (the underlying disagreements), and assumptions.
5. Opening votes: every advisor posts a stance, scores for every option, a pillar score, confidence from 1 to 5, ruin risk, a door call (one-way or two-way), and what would change its mind.
6. Debate rounds: each advisor answers the cruxes, rebuts the seat it disagrees with most, concedes the strongest point against it, updates its scores, and lists checkable conditions for yes.
7. Draft resolution: conditions, next steps, cheapest test, kill criteria, hidden risks, and trade-offs. The recommendation itself is computed by the app from scores and overrides, never taken from the model alone. If the draft depends on a prerequisite that is not met yet, the verdict is WAIT with the trigger named.
8. Final vote: every advisor votes Endorse, Endorse with amendment, or Dissent, with a final score for the resolution, a final pillar score, and amendment or dissent text.
9. Read the verdict, copy the transcript, download the Markdown summary, or print to PDF. Past debates reload from your browser history.

A full debate costs 26 LLM calls at 1 round, 34 at 2 rounds, and 42 at 3 rounds, plus one call per step if you add a custom advisor. Calls run sequentially with live progress, which keeps free-tier rate limits in range. Each provider call has a 90 second timeout. If a call fails, the app names the exact advisor and round, offers a retry for that step only without losing the debate, and offers a one-click provider switch when the other key is present. It never switches providers silently.

## How scoring works

- Every advisor scores every option from 0 to 10.
- Each option's score is the weighted average across advisors, shown to one decimal with its math line.
- Verdict bands on the recommended option: GO at 7.5 and above, GO WITH CONDITIONS at 6.0 to 7.4, RESHAPE at 4.5 to 5.9, DON'T DO IT below 4.5. WAIT replaces the band when the recommendation depends on an unmet prerequisite with a named trigger.
- Ruin cap: if any advisor flags likely ruin risk on the recommended option, the verdict is capped at RESHAPE.
- One-way door cap: if a majority calls the recommended option a one-way door and the spread is 4 or more, the verdict is capped at GO WITH CONDITIONS.
- Support for the resolution is the weighted average of final votes. Confidence combines average confidence with the spread (highest minus lowest seat score on the recommended option).
- The pillar scorecard shows every seat's final pillar score. Dissent is reported in full in the minority report, never smoothed over.
- The app computes every number deterministically. It never invents scores.

## Setup and keys

Boardroom uses your own API key (BYOK). Groq is the primary provider and Google Gemini is the fallback. Both offer free tiers.

- Defaults: Groq llama-3.3-70b-versatile, Gemini gemini-2.0-flash. The model field is editable, so you can use any model your key can call.
- Your key is stored only in your browser (localStorage). It is never sent to any Boardroom server, because there is none.
- Calls go directly from your browser to the provider you chose: api.groq.com or generativelanguage.googleapis.com. Gemini keys are sent via the x-goog-api-key header, never in a URL.
- Your dilemma text goes only to that provider, as part of the debate prompts. Past debates are stored only in your browser. Clearing your browser data removes them.

## Run it locally

No build step, no dependencies, no install. Any static file server works:

```bash
cd boardroom
python3 -m http.server 8000
```

Then open http://localhost:8000 in your browser. You can also open `index.html` directly.

## Deploy on Vercel

This is a static site. In Vercel, import the repository, set no build command, and set the output directory to the folder containing `index.html` (the repo root). There is nothing to build, nothing to install, and no environment variables to set.

## Security notes

- No backend, no database, no accounts, no analytics, no tracking, and no cookies set by the app. Nothing you type is stored on any server.
- No secrets in this repository: no API keys, tokens, or personal data.
- Pasted content is never executed. It is parsed as text only: no eval, no new Function, and all dynamic text is escaped before rendering.
- The app contacts no external resources. The only hosts it calls are the two provider APIs listed above.
- Input limits protect your own key from runaway usage: title 200 characters, context 4,000 characters, at most 4 user options, rounds capped at 3.
- See SECURITY.md for the full threat model.

## Tests

```bash
node tests/harness.js
```

The harness drives the debate state machine with canned provider responses and asserts scoring, verdicts, overrides, dissent, exports, and input limits: 51 checks, all passing. It is not loaded by the app, and the production app ships no mock mode.

## Credit

Inspired by Nate Herk's Roast Room (open-source); built independently, not affiliated with Nate Herk.

## License

MIT. See [LICENSE](LICENSE).
