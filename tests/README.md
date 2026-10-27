# Tests

This folder holds the Boardroom test harness. It is test-only code.

- Run: `node tests/harness.js` from the app folder.
- It loads `js/personas.js` and `js/engine.js` in a Node VM sandbox and
  drives the full debate state machine with canned provider responses.
- It asserts scoring math, verdict bands, ruin cap, one-way door cap,
  spread and confidence, support for the resolution, dissent detection,
  Markdown export, transcript output, JSON extraction edge cases, and
  input limits.
- `index.html` never loads anything from this folder. The production app
  ships no mock mode and no canned responses.
- Live provider calls are not tested here because no API key is
  available in this environment. The first live run needs a user key.
