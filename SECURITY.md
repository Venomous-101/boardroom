# Security

## What Boardroom is

A static web page plus one small server function (`api/chat.js`). There
is no database, no user accounts, no server-side storage, and no
analytics or tracking of any kind.

## Threat model

### What is protected

- The server API keys.
- Your dilemma text and debate content.
- Your past debates.

### Who the attacker is

- Anyone who can read the public code repository.
- Anyone who can observe network traffic.
- Anyone who learns the deployment URL.
- Any third-party script, of which there are none: the app loads zero
  external scripts, styles, fonts, or trackers.

### What is out of scope

- The security of the LLM provider you choose. Your key and your
  dilemma text go to that provider, under that provider's terms.
  Boardroom cannot protect data once it reaches the provider.
- The security of your own device and browser. If your browser or
  device is compromised, localStorage is readable by that compromise.
- The secrecy of the debate output itself. Debate content is yours;
  treat it like any document you would share carefully.
- URL secrecy. The server function has no user authentication by
  design: it is built for a private single-user deployment. If you
  publish the deployment URL, anyone with it can run debates against
  the server key, within the rate limit. Keep the URL private, and
  use the host's deployment protection if it offers one.

## How keys are handled

- Keys live only in the server environment (`GROQ_API_KEY`,
  `GEMINI_API_KEY`). They are never in the repository, never in the
  page, never in the browser's storage, and never in a URL.
- `.env.example` lists the variable names with blank values. A filled
  copy must never be committed.
- Keys are never logged by the server function, never displayed, and
  never sent to any host except the chosen provider's API host.
- Groq calls use the Authorization header. Gemini calls use the
  `x-goog-api-key` header. The key is never put in a URL query
  parameter.
- A provider without its server key returns a clear "not configured"
  error. It never falls back to a key from anywhere else.
- Switching providers never happens silently. The switch button is
  offered on a failed step, and the switch is recorded in the
  transcript.
- Past debate history stored in localStorage contains no keys.

## How the server function is protected

- Same-origin only. The function sends no CORS headers, so other
  websites cannot call it from a browser.
- Method and shape checks: POST only, provider must be groq or
  gemini, model name capped at 200 characters, system prompt capped
  at 8,000 characters, user prompt capped at 12,000 characters.
- Per-address rate limit: 120 requests per 10 minutes. This is a
  tripwire, not authentication: serverless instances do not share
  the counter, so it cannot stop a determined caller. URL privacy
  and deployment protection are the real controls.
- Provider timeout of 60 seconds per call, matching the function
  limit. The page side times out at 90 seconds.
- Provider error bodies are truncated to 400 characters before they
  reach the page, so provider internals do not leak through.

## How pasted content is handled

- Pasted dilemma text, options, and custom advisor viewpoints are
  treated as text only. They are inserted into debate prompts sent to
  the chosen provider through the server function.
- Pasted content is never executed. The app never uses `eval()` or
  `new Function()` on any input.
- All dynamic text, from the user and from models, is escaped before
  it reaches the page. Model output cannot inject markup.
- Portrait images come from a fixed allowlist of seat ids shipped
  with the app, never from user input. A custom advisor is shown
  with its initials, never with a user-supplied image.
- Input limits apply: title 200 characters, context 4000 characters,
  at most 4 user options, custom advisor name 60 characters, viewpoint
  500 characters, rounds capped at 3. Limits protect the server key
  from runaway usage.

## What is stored, and where

| Data | Stored where | Stored by whom |
|---|---|---|
| API keys | Server environment only | The deployer, via the hosting dashboard |
| Past debates | This browser only (localStorage) | The app, automatically |
| Dilemma text | Sent to the chosen provider per debate, via the server function | The user, by starting a debate |
| Nothing else | Nowhere | Nobody |

## What is not stored

- No key, dilemma, or debate content is stored on any Boardroom
  server beyond the live function call: the function holds no
  database and keeps no logs of request bodies.
- No accounts, no passwords, no emails, no personal data are collected
  by the app.
- No analytics events, no cookies set by the app, no third-party
  requests of any kind.

## Repository hygiene

- The repository contains no API keys, tokens, personal data, emails,
  deployment URLs, or names of real private individuals.
- Before release, the repo is scanned for key patterns (`sk-`,
  `AIza`, `gsk_`, `api_key`) and for deployment URLs. Results are
  reported in the release notes.
- Advisor personas are AI simulations inspired by public frameworks.
  They are labeled as simulations in the room, and no persona claims
  to be, speak for, or be endorsed by a real person.
- Advisor brains are distilled originals written for this app. They
  contain no verbatim quotes from real people and no copied brain
  text from any other project. Simulation labels stay on every
  persona.
