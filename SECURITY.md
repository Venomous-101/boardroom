# Security

## What Boardroom is

A static web app. HTML, CSS, and JavaScript files served as-is. There
is no backend, no database, no user accounts, no server-side code, and
no analytics or tracking of any kind.

## Threat model

### What is protected

- Your API keys.
- Your dilemma text and debate content.
- Your past debates.

### Who the attacker is

- Anyone who can read the public code repository.
- Anyone who can observe network traffic.
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

## How keys are handled

- Keys are stored only in the browser's localStorage, under keys the
  user can clear with the "Clear saved keys" button.
- Keys are never displayed after saving, never logged to the console,
  never placed in URLs, and never sent to any host except the chosen
  provider's API host.
- Groq calls use the Authorization header.
- Gemini calls use the `x-goog-api-key` header. The key is never put
  in a URL query parameter.
- Switching providers never happens silently. The switch button only
  appears when the other provider's key is present, and the switch is
  recorded in the transcript.
- Past debate history stored in localStorage contains no keys.

## How pasted content is handled

- Pasted dilemma text, options, and custom advisor viewpoints are
  treated as text only. They are inserted into debate prompts sent to
  the chosen provider.
- Pasted content is never executed. The app never uses `eval()` or
  `new Function()` on any input.
- All dynamic text, from the user and from models, is escaped before
  it reaches the page. Model output cannot inject markup.
- Input limits apply: title 200 characters, context 4000 characters,
  at most 4 user options, custom advisor name 60 characters, viewpoint
  500 characters, rounds capped at 3. Limits protect the user's own
  key from runaway usage.

## What is stored, and where

| Data | Stored where | Stored by whom |
|---|---|---|
| API keys | This browser only (localStorage) | The user, via the key panel |
| Past debates | This browser only (localStorage) | The app, automatically |
| Dilemma text | Sent to the chosen provider per debate | The user, by starting a debate |
| Nothing else | Nowhere | Nobody |

## What is not stored

- No key, dilemma, or debate content is stored on any Boardroom
  server, because no such server exists.
- No accounts, no passwords, no emails, no personal data are collected
  by the app.
- No analytics events, no cookies set by the app, no third-party
  requests of any kind.

## Repository hygiene

- The repository contains no API keys, tokens, personal data, emails,
  or names of real private individuals.
- Before release, the repo is scanned for key patterns (`sk-`,
  `AIza`, `gsk_`, `api_key`) and for personal details. Results are
  reported in the release notes.
- Advisor personas are AI simulations inspired by public frameworks.
  They are labeled as simulations on every card, and no persona claims
  to be, speak for, or be endorsed by a real person.
