# Boardroom

A live board of AI advisor simulations for hard business decisions.

Bring a decision. A board of eight advisor simulations debates it in
rounds, votes, argues, and hands you a scored verdict with conditions,
next steps, a cheapest test, kill criteria, and a minority report.

## How it works

1. Add your own API key. Groq is the primary provider, Google Gemini is
   the fallback. Both offer free tiers.
2. Describe a decision: title, context, and options. "Do nothing" is
   added automatically when you leave it out, so the board always weighs
   doing nothing.
3. Pick debate rounds (1 to 3), a focus (balanced, cost, speed, or
   risk), and a model. The model field is editable.
4. Optionally add one custom advisor: a name and the viewpoint it must
   argue from.
5. Start the board. A Director frames the decision and sets weights,
   advisors vote, debate in rounds, and vote finally on a draft
   resolution. The app computes every score deterministically.
6. Read the verdict, copy the transcript, download the Markdown summary,
   or print to PDF.

## The board

Eight seats, each an AI simulation inspired by a public business
thinker's public frameworks:

- Operator (Bezos mould): strategy and decisions.
- Offer (Hormozi mould): offers, pricing, and sales.
- Investor (Buffett mould): money and capital.
- Marketer (Gary Vaynerchuk mould): marketing and attention.
- Philosopher (Naval Ravikant mould): leverage and wealth.
- Founder (Paul Graham mould): product and startups.
- SaaS (Dan Martell mould): people, hiring, and founder time.
- EOS (Gino Wickman mould): operations and scaling.

Every card is labeled "AI simulation". The simulations are inspired by
public frameworks. They are not the real people, they do not speak for
them, and nothing here is affiliated with or endorsed by them. Avatars
are initials only, never faces of real people.

## Your key and your privacy

Boardroom has no backend, no database, no accounts, and no tracking.

- Your API key is stored only in your browser (localStorage). It is
  never sent to any Boardroom server, because there is none.
- Calls go directly from your browser to the provider you chose:
  api.groq.com or generativelanguage.googleapis.com. Gemini keys are
  sent via header, never in a URL.
- Your dilemma text goes only to that provider, as part of the debate
  prompts.
- Past debates are stored only in your browser. Clearing your browser
  data removes them.
- The app never executes pasted content. It is parsed as text only.

See SECURITY.md for the full threat model.

## Scoring, in plain words

- Every advisor scores every option from 0 to 10.
- Each option's score is the weighted average across advisors, shown
  with its math line.
- Verdict bands on the recommended option: GO at 7.5 and above,
  GO WITH CONDITIONS at 6.0 to 7.4, RESHAPE at 4.5 to 5.9,
  DON'T DO IT below 4.5.
- Ruin cap: if any advisor flags likely ruin risk on the recommended
  option, the verdict is capped at RESHAPE.
- One-way door cap: if a majority calls the recommended option a
  one-way door and the spread is 4 or more, the verdict is capped at
  GO WITH CONDITIONS.
- WAIT applies when the draft resolution depends on a prerequisite that
  is not met yet, with the trigger named.
- Support for the resolution is the weighted average of final votes.
  Confidence combines average confidence with the spread. Dissent is
  reported in full, never smoothed over.

## Run it locally

No build step, no dependencies. Any static file server works, or open
`index.html` directly in a browser:

```bash
cd boardroom
python3 -m http.server 8000
```

Then open http://localhost:8000 in your browser.

## Deploy on Vercel

This is a static site. In Vercel, import the repository, set no build
command, and set the output directory to the folder containing
`index.html`. There is nothing to build and nothing to install.

## Tests

```bash
node tests/harness.js
```

The harness drives the debate state machine with canned provider
responses and asserts scoring, verdicts, overrides, dissent, exports,
and input limits. It is not loaded by the app, and the app ships no
mock mode.

## Credit

Inspired by Nate Herk's Roast Room (open-source); built independently,
not affiliated with Nate Herk.

## License

MIT. See LICENSE.
