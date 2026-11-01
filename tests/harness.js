/* Boardroom test harness (Node only).
   NOT loaded by index.html. The production app ships no mock mode.
   Run: node tests/harness.js
   Loads js/personas.js and js/engine.js in a VM sandbox, then drives the
   full debate state machine with canned provider responses and asserts
   scoring, verdicts, overrides, dissent, exports, and input limits. */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const sandbox = { console: console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const file of ["js/personas.js", "js/providers.js", "js/brains.js", "js/engine.js", "js/ui.js"]) {
  const code = fs.readFileSync(path.join(root, file), "utf8");
  vm.runInContext(code, sandbox, { filename: file });
}
const BR = sandbox.BR;

let passed = 0;
let failed = 0;
const failures = [];

function assert(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log("PASS " + name);
  } else {
    failed += 1;
    failures.push(name);
    console.log("FAIL " + name + (detail ? " :: " + detail : ""));
  }
}

function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

/* ---------- Server function (OpenRouter fallback) ---------- */
/* Loads api/chat.js in a fresh VM sandbox per test, with fake keys
   that carry no real key prefix, a mock fetch routed by URL, and a
   setTimeout wrapper that records each attempt cap. The recorded
   caps prove the inertness rule: a Groq attempt with no OpenRouter
   key keeps the full 55 second deadline, while a Groq attempt with a
   fallback key behind it is capped at 12 seconds and each walk leg
   at 20 seconds. Every OpenRouter request carries exactly one model:
   a long models array in one request was rejected live with
   HTTP 400, so the walk sends one model per request. */

const FAKE_GROQ_KEY = "env-groq-key-for-tests";
const FAKE_OR_KEY = "env-openrouter-key-for-tests";
const FAKE_GEMINI_KEY = "env-gemini-key-for-tests";
const serverBodies = [];

function mockResp(ok, status, jsonData, textData) {
  return {
    ok: ok,
    status: status,
    json: async function () { return jsonData; },
    text: async function () { return textData || ""; }
  };
}

function loadServer(env, script) {
  const calls = [];
  const timeouts = [];
  const serverSandbox = {
    console: console,
    module: { exports: {} },
    process: { env: Object.assign({}, env) },
    AbortController: AbortController,
    clearTimeout: clearTimeout,
    setTimeout: function (fn, ms) { timeouts.push(ms); return setTimeout(fn, ms); },
    fetch: async function (url, options) {
      let body = null;
      try { body = JSON.parse(options.body); } catch (e) { body = null; }
      calls.push({ url: url, auth: options.headers.Authorization, body: body });
      return script(url, options, body);
    }
  };
  serverSandbox.globalThis = serverSandbox;
  vm.createContext(serverSandbox);
  const code = fs.readFileSync(path.join(root, "api/chat.js"), "utf8");
  vm.runInContext(code, serverSandbox, { filename: "api/chat.js" });
  return { handler: serverSandbox.module.exports, calls: calls, timeouts: timeouts };
}

async function callServer(loaded, body, ip) {
  const res = {
    statusCode: 0,
    body: null,
    headers: {},
    status: function (code) { this.statusCode = code; return this; },
    json: function (obj) { this.body = obj; return this; },
    setHeader: function (k, v) { this.headers[k] = v; }
  };
  const req = {
    method: "POST",
    body: body,
    headers: { "x-forwarded-for": ip },
    socket: { remoteAddress: ip }
  };
  await loaded.handler(req, res);
  serverBodies.push(res.body);
  return res;
}

function scriptFor(routes) {
  return function (url, options, body) {
    for (const r of routes) {
      if (url.indexOf(r.match) !== -1) { return r.make(body); }
    }
    throw new Error("unexpected url: " + url);
  };
}

function groqOk(text) {
  return mockResp(true, 200, { choices: [{ message: { content: text } }] });
}

function groqErr(status) {
  return mockResp(false, status, null, "groq error " + status);
}

function orOk(body) {
  return mockResp(true, 200, { model: body.model, choices: [{ message: { content: "fallback text" } }] });
}

function orEmpty() {
  return mockResp(true, 200, { choices: [{ message: { content: "" } }] });
}

function orErr(status) {
  return mockResp(false, status, null, "openrouter error " + status);
}

function geminiOk() {
  return mockResp(true, 200, { candidates: [{ content: { parts: [{ text: "gemini text" }] } }] });
}

async function serverTests() {
  const base = { provider: "groq", model: "openai/gpt-oss-120b", system: "sys", user: "usr" };
  const bothKeys = { GROQ_API_KEY: FAKE_GROQ_KEY, OPENROUTER_API_KEY: FAKE_OR_KEY, GEMINI_API_KEY: FAKE_GEMINI_KEY };

  /* Groq 429 then OpenRouter success, with the full free chain. */
  const t1 = loadServer(bothKeys, scriptFor([
    { match: "api.groq.com", make: function () { return groqErr(429); } },
    { match: "openrouter.ai", make: orOk }
  ]));
  const r1 = await callServer(t1, base, "10.0.0.1");
  assert("server: groq 429 falls back to openrouter", r1.statusCode === 200 && r1.body.ok === true && r1.body.text === "fallback text", JSON.stringify(r1.body));
  assert("server: fallback servedBy is openrouter chain head", eq(r1.body.servedBy, { provider: "openrouter", model: BR.OPENROUTER_FREE_CHAIN[0] }), JSON.stringify(r1.body.servedBy));
  const orCalls1 = t1.calls.filter(function (c) { return c.url.indexOf("openrouter.ai") !== -1; });
  const orCall = orCalls1[0];
  assert("server: fallback sends one model per request, chain head first, never a models array",
    orCalls1.length === 1 && !!orCall && orCall.body.model === BR.OPENROUTER_FREE_CHAIN[0] && !("models" in orCall.body),
    JSON.stringify(orCall && orCall.body));
  assert("server: groq and openrouter auth use their own keys",
    t1.calls.length === 2 && t1.calls[0].auth === "Bearer " + FAKE_GROQ_KEY && orCall.auth === "Bearer " + FAKE_OR_KEY,
    JSON.stringify(t1.calls.map(function (c) { return c.auth; })));
  assert("server: fallback attempt caps are 12s groq and 20s walk leg", eq(t1.timeouts, [12000, 20000]), JSON.stringify(t1.timeouts));

  /* All free fallbacks exhausted: primary failure reported, flagged. */
  const t2 = loadServer(bothKeys, scriptFor([
    { match: "api.groq.com", make: function () { return groqErr(429); } },
    { match: "openrouter.ai", make: function () { return orErr(429); } }
  ]));
  const r2 = await callServer(t2, base, "10.0.0.2");
  assert("server: all fallbacks exhausted reports primary failure flagged",
    r2.body.ok === false && r2.body.status === 429 && r2.body.fallbackExhausted === true, JSON.stringify(r2.body));
  assert("server: exhausted fallback names its own status and detail",
    r2.body.fallbackStatus === 429 && typeof r2.body.fallbackBody === "string" && r2.body.fallbackBody.indexOf("openrouter error 429") !== -1, JSON.stringify(r2.body));
  assert("server: walk is bounded: all four free models tried, one request each, then it stops",
    r2.body.fallbackAttempts === 4 &&
    t2.calls.filter(function (c) { return c.url.indexOf("openrouter.ai") !== -1; }).length === 4 &&
    eq(t2.calls.filter(function (c) { return c.url.indexOf("openrouter.ai") !== -1; }).map(function (c) { return c.body.model; }), BR.OPENROUTER_FREE_CHAIN),
    JSON.stringify(t2.calls.map(function (c) { return c.body.model; })) + " attempts=" + r2.body.fallbackAttempts);

  /* Groq 401 fails fast even with a fallback key present. */
  const t3 = loadServer(bothKeys, scriptFor([
    { match: "api.groq.com", make: function () { return groqErr(401); } },
    { match: "openrouter.ai", make: orOk }
  ]));
  const r3 = await callServer(t3, base, "10.0.0.3");
  assert("server: groq 401 fails fast with no fallback",
    r3.body.ok === false && r3.body.status === 401 && !r3.body.fallbackExhausted && !r3.body.fallbackSkipped && t3.calls.length === 1,
    JSON.stringify(r3.body) + " calls=" + t3.calls.length);

  /* OpenRouter direct with a free model: requested model first, one request. */
  const t4 = loadServer(bothKeys, scriptFor([{ match: "openrouter.ai", make: orOk }]));
  const r4 = await callServer(t4, { provider: "openrouter", model: BR.OPENROUTER_FREE_CHAIN[2], system: "sys", user: "usr" }, "10.0.0.4");
  assert("server: openrouter direct free model goes first, one model per request",
    r4.body.ok === true && t4.calls.length === 1 && t4.calls[0].body.model === BR.OPENROUTER_FREE_CHAIN[2] &&
    !("models" in t4.calls[0].body) && r4.body.servedBy.model === BR.OPENROUTER_FREE_CHAIN[2],
    JSON.stringify(t4.calls[0] && t4.calls[0].body) + " " + JSON.stringify(r4.body.servedBy));
  assert("server: openrouter direct leg uses the 20s walk cap", eq(t4.timeouts, [20000]), JSON.stringify(t4.timeouts));

  /* OpenRouter direct walk: first model 429s, walk moves to the next
     model in order (requested first, then the chain) and succeeds. */
  let t4bCount = 0;
  const t4b = loadServer(bothKeys, scriptFor([{ match: "openrouter.ai", make: function (body) {
    t4bCount += 1;
    return t4bCount === 1 ? orErr(429) : orOk(body);
  } }]));
  const r4b = await callServer(t4b, { provider: "openrouter", model: BR.OPENROUTER_FREE_CHAIN[2], system: "sys", user: "usr" }, "10.0.0.41");
  assert("server: walk moves to next model on 429 then succeeds",
    r4b.body.ok === true && t4b.calls.length === 2 &&
    t4b.calls[0].body.model === BR.OPENROUTER_FREE_CHAIN[2] &&
    t4b.calls[1].body.model === BR.OPENROUTER_FREE_CHAIN[0] &&
    r4b.body.servedBy.model === BR.OPENROUTER_FREE_CHAIN[0],
    JSON.stringify(t4b.calls.map(function (c) { return c.body.model; })) + " " + JSON.stringify(r4b.body.servedBy));

  /* Groq fallback walk: two legs fail, third serves, in chain order. */
  let t4cCount = 0;
  const t4c = loadServer(bothKeys, scriptFor([
    { match: "api.groq.com", make: function () { return groqErr(429); } },
    { match: "openrouter.ai", make: function (body) {
      t4cCount += 1;
      return t4cCount <= 2 ? orErr(500) : orOk(body);
    } }
  ]));
  const r4c = await callServer(t4c, base, "10.0.0.42");
  const orCalls4c = t4c.calls.filter(function (c) { return c.url.indexOf("openrouter.ai") !== -1; });
  assert("server: groq fallback walk tries legs in chain order until one serves",
    r4c.body.ok === true && orCalls4c.length === 3 &&
    eq(orCalls4c.map(function (c) { return c.body.model; }), BR.OPENROUTER_FREE_CHAIN.slice(0, 3)) &&
    r4c.body.servedBy.model === BR.OPENROUTER_FREE_CHAIN[2],
    JSON.stringify(orCalls4c.map(function (c) { return c.body.model; })) + " " + JSON.stringify(r4c.body.servedBy));

  /* Empty 200 reply moves the walk on, like a 429 does. */
  let t4dCount = 0;
  const t4d = loadServer(bothKeys, scriptFor([{ match: "openrouter.ai", make: function (body) {
    t4dCount += 1;
    return t4dCount === 1 ? orEmpty() : orOk(body);
  } }]));
  const r4d = await callServer(t4d, { provider: "openrouter", model: BR.OPENROUTER_FREE_CHAIN[0], system: "sys", user: "usr" }, "10.0.0.43");
  assert("server: walk moves to next model on an empty reply then succeeds",
    r4d.body.ok === true && t4d.calls.length === 2 &&
    t4d.calls[1].body.model === BR.OPENROUTER_FREE_CHAIN[1] &&
    r4d.body.servedBy.model === BR.OPENROUTER_FREE_CHAIN[1],
    JSON.stringify(t4d.calls.map(function (c) { return c.body.model; })));

  /* Non-retryable failure stops the walk after one attempt. */
  const t4e = loadServer(bothKeys, scriptFor([{ match: "openrouter.ai", make: function () { return orErr(401); } }]));
  const r4e = await callServer(t4e, { provider: "openrouter", model: BR.OPENROUTER_FREE_CHAIN[0], system: "sys", user: "usr" }, "10.0.0.44");
  assert("server: walk stops on 401 after one attempt, never exhausted",
    r4e.body.ok === false && t4e.calls.length === 1 &&
    r4e.body.walkAttempts === 1 && r4e.body.walkExhausted === false,
    JSON.stringify(r4e.body) + " calls=" + t4e.calls.length);

  /* OpenRouter direct with a paid model: sent alone, never chained. */
  const t5 = loadServer(bothKeys, scriptFor([{ match: "openrouter.ai", make: orOk }]));
  const r5 = await callServer(t5, { provider: "openrouter", model: "anthropic/claude-sonnet-5", system: "sys", user: "usr" }, "10.0.0.5");
  assert("server: openrouter direct paid model stays alone",
    r5.body.ok === true && t5.calls.length === 1 && t5.calls[0].body.model === "anthropic/claude-sonnet-5" &&
    !("models" in t5.calls[0].body), JSON.stringify(t5.calls[0] && t5.calls[0].body));

  /* Bad provider rejected before any provider call. */
  const t6 = loadServer(bothKeys, scriptFor([]));
  const r6 = await callServer(t6, { provider: "bogus", model: "m", system: "sys", user: "usr" }, "10.0.0.6");
  assert("server: bad provider is rejected with 400", r6.statusCode === 400 && t6.calls.length === 0, String(r6.statusCode));

  /* Gemini path unchanged apart from the servedBy label. */
  const t7 = loadServer(bothKeys, scriptFor([{ match: "generativelanguage.googleapis.com", make: geminiOk }]));
  const r7 = await callServer(t7, { provider: "gemini", model: "gemini-2.0-flash", system: "sys", user: "usr" }, "10.0.0.7");
  assert("server: gemini returns text with gemini servedBy",
    r7.body.ok === true && r7.body.text === "gemini text" && eq(r7.body.servedBy, { provider: "gemini", model: "gemini-2.0-flash" }),
    JSON.stringify(r7.body));
  assert("server: gemini single attempt keeps the full deadline", t7.timeouts.length === 1 && t7.timeouts[0] > 25000 && t7.timeouts[0] <= 55000, JSON.stringify(t7.timeouts));

  /* Missing Groq key: clear not_configured, no provider call. */
  const t8 = loadServer({}, scriptFor([{ match: "api.groq.com", make: function () { return groqOk("x"); } }]));
  const r8 = await callServer(t8, base, "10.0.0.8");
  assert("server: missing groq key is not_configured",
    r8.statusCode === 500 && r8.body.error && r8.body.error.code === "not_configured" && t8.calls.length === 0,
    JSON.stringify(r8.body));

  /* Chain discipline: free only, matches the page list, head is the default. */
  const chain = t1.handler.OPENROUTER_FREE_CHAIN;
  assert("server: chain is free only, four models, and matches the page list",
    Array.isArray(chain) && chain.length === 4 && chain.every(function (m) { return /:free$/.test(m); }) && eq(chain, BR.OPENROUTER_FREE_CHAIN),
    JSON.stringify(chain));
  assert("server: openrouter default model is the chain head",
    BR.PROVIDERS.openrouter.defaultModel === BR.OPENROUTER_FREE_CHAIN[0], BR.PROVIDERS.openrouter.defaultModel);
  /* Chain order is pinned to the verified live catalog (1 Nov 2026):
     inkling first, then nemotron ultra, gemma 31b, dots note. If the
     free roster rotates, update both lists and this test together. */
  assert("server: chain order is inkling, nemotron ultra, gemma 31b, dots note",
    eq(chain, ["thinkingmachines/inkling:free", "nvidia/nemotron-3-ultra-550b-a55b:free", "google/gemma-4-31b-it:free", "dots-studio/dots-3-note-preview:free"]),
    JSON.stringify(chain));

  /* Unset-key case: the fallback must be completely inert. */
  const groqOnly = { GROQ_API_KEY: FAKE_GROQ_KEY };
  const u1 = loadServer(groqOnly, scriptFor([{ match: "api.groq.com", make: function () { return groqErr(429); } }]));
  const ru1 = await callServer(u1, base, "10.0.1.1");
  assert("unset key: groq 429 returns fallbackSkipped and never calls openrouter",
    ru1.body.ok === false && ru1.body.status === 429 && ru1.body.fallbackSkipped === "no_openrouter_key" && !ru1.body.fallbackExhausted &&
    u1.calls.length === 1 && u1.calls[0].url.indexOf("api.groq.com") !== -1,
    JSON.stringify(ru1.body) + " calls=" + u1.calls.length);
  assert("unset key: failed groq attempt keeps the full deadline, not the 12s fallback cap",
    u1.timeouts.length === 1 && u1.timeouts[0] > 25000 && u1.timeouts[0] <= 55000, JSON.stringify(u1.timeouts));
  const u2 = loadServer(groqOnly, scriptFor([{ match: "api.groq.com", make: function () { return groqOk("groq text"); } }]));
  const ru2 = await callServer(u2, base, "10.0.1.2");
  assert("unset key: groq success works with no openrouter call",
    ru2.body.ok === true && ru2.body.text === "groq text" && eq(ru2.body.servedBy, { provider: "groq", model: base.model }) && u2.calls.length === 1,
    JSON.stringify(ru2.body));
  assert("unset key: successful groq attempt keeps the full deadline", u2.timeouts.length === 1 && u2.timeouts[0] > 25000 && u2.timeouts[0] <= 55000, JSON.stringify(u2.timeouts));
  const u3 = loadServer(groqOnly, scriptFor([{ match: "api.groq.com", make: function () { return groqErr(401); } }]));
  const ru3 = await callServer(u3, base, "10.0.1.3");
  assert("unset key: groq 401 fails fast with no fallback fields",
    ru3.body.ok === false && ru3.body.status === 401 && !ru3.body.fallbackSkipped && !ru3.body.fallbackExhausted && u3.calls.length === 1,
    JSON.stringify(ru3.body));

  /* No response anywhere echoes a key value. */
  assert("server: no response echoes a key", serverBodies.every(function (b) {
    const s = JSON.stringify(b);
    return s.indexOf(FAKE_GROQ_KEY) === -1 && s.indexOf(FAKE_OR_KEY) === -1 && s.indexOf(FAKE_GEMINI_KEY) === -1;
  }));
}

/* ---------- Canned provider ---------- */

const WEIGHTS = {
  operator: 3, offer: 2, investor: 2, marketer: 1,
  philosopher: 1, founder: 1, saas: 1, eos: 1
};

const OPENING_SCORES = {
  operator: { A: 8, B: 6, C: 3 },
  offer: { A: 7, B: 8, C: 2 },
  investor: { A: 6, B: 5, C: 4 },
  marketer: { A: 7, B: 6, C: 3 },
  philosopher: { A: 6, B: 7, C: 2 },
  founder: { A: 7, B: 5, C: 4 },
  saas: { A: 6, B: 6, C: 3 },
  eos: { A: 7, B: 5, C: 3 }
};

function cardFor(id, extra) {
  const base = {
    stance: "Yes",
    optionScores: OPENING_SCORES[id],
    pillarScore: 7,
    confidence: 4,
    ruinRisk: "none",
    door: "two-way",
    reason: "Canned reason for " + id + ".",
    changeMind: "A number proving otherwise."
  };
  return Object.assign(base, extra || {});
}

function makeCanned(opts) {
  const calls = {};
  const failOnce = (opts && opts.failOnce) || {};
  const garbageFirst = (opts && opts.garbageFirst) || {};
  const fn = function (state, step) {
    calls[step.key] = (calls[step.key] || 0) + 1;
    if (failOnce[step.key] && calls[step.key] === 1) {
      return Promise.resolve({ ok: false, error: { code: "rate_limit", message: "Rate limit (canned)." } });
    }
    if (garbageFirst[step.key] && calls[step.key] === 1) {
      return Promise.resolve({ ok: true, text: "this is not json at all" });
    }
    if (step.key === "director") {
      return Promise.resolve({ ok: true, text: JSON.stringify({
        brief: "Canned brief: decide whether to raise the price.",
        weights: Object.keys(WEIGHTS).map(function (id) {
          return { advisorId: id, weight: WEIGHTS[id], reason: "Canned weight." };
        }),
        cruxes: [
          { question: "Will existing clients stay at the higher price?", sides: [] },
          { question: "Does the higher price need a stronger offer?", sides: [] }
        ],
        assumptions: ["Close rate holds (assumed)."]
      }) });
    }
    if (step.key.indexOf("opening:") === 0) {
      return Promise.resolve({ ok: true, text: JSON.stringify(cardFor(step.advisorId)) });
    }
    if (step.key.indexOf("debate:") === 0) {
      return Promise.resolve({ ok: true, text: JSON.stringify(Object.assign(cardFor(step.advisorId), {
        disagreeWith: "Offer",
        rebuttal: "Canned rebuttal.",
        concede: "Canned concession.",
        cruxAnswers: ["Canned crux answer."],
        moved: "no",
        conditions: ["Canned condition."]
      })) });
    }
    if (step.key.indexOf("discussion:") === 0) {
      return Promise.resolve({ ok: true, text: JSON.stringify({
        answerTo: "Offer",
        agree: "disagree",
        pointAnswered: "Canned point from Offer.",
        steelman: "Canned steelman: Offer's point at its strongest, fairly stated.",
        weakPoint: "Canned weak premise.",
        reply: "Canned discussion reply.",
        concede: "Nothing conceded: the attack fails because the premise holds.",
        costOfBeingWrong: "Canned cost if wrong.",
        evidenceDemanded: "Canned settling number.",
        reason: "Canned discussion reason."
      }) });
    }
    if (step.key === "draft") {
      return Promise.resolve({ ok: true, text: JSON.stringify({
        conditions: [{ text: "Test the new price with five new leads first.", gating: true }],
        nextSteps: ["Announce the change on Monday.", "Track close rate for two weeks."],
        cheapestTest: "Offer the new price to five new leads.",
        killCriteria: "Close rate drops below 30 percent for two weeks.",
        risks: ["Existing clients churn."],
        tradeoffs: ["Higher margin versus fewer clients."],
        revisit: "Revisit in two weeks with close rate data.",
        waitFor: null
      }) });
    }
    if (step.key.indexOf("final:") === 0) {
      const dissent = step.advisorId === "investor";
      return Promise.resolve({ ok: true, text: JSON.stringify({
        vote: dissent ? "Dissent" : "Endorse",
        finalScore: dissent ? 3 : 8,
        finalPillarScore: 7,
        amendment: dissent ? "Cash risk is unaddressed." : "",
        line: "Canned line for " + step.advisorId + "."
      }) });
    }
    return Promise.resolve({ ok: false, error: { code: "unknown_step", message: "Unknown step." } });
  };
  return { fn: fn, calls: calls };
}

function makeDebate(rounds) {
  return BR.createDebate({
    title: "Should I raise my coaching price to $3,500?",
    context: "Coaching business at $30k a month, 15 clients at $2,000 each, close rate 50 percent, $40k in the bank.",
    options: ["Raise to $3,500 for everyone now", "Raise for new clients only"],
    focus: "balanced",
    rounds: rounds || 2,
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    advisors: BR.PERSONAS.slice()
  });
}

async function main() {
  /* ---------- Full run ---------- */
  const state = makeDebate(2);
  const canned = makeCanned({});
  const res = await BR.runDebate(state, canned.fn, function () {});
  assert("full run completes", res.ok === true, JSON.stringify(res));
  assert("verdict exists", !!state.verdict);
  assert("recommended option is A", state.verdict.recommendedId === "A", state.verdict.recommendedId);
  assert("option A score is 6.9", state.verdict.optionScores.A.score === 6.9, JSON.stringify(state.verdict.optionScores.A));
  assert("option B score is 6.1", state.verdict.optionScores.B.score === 6.1, JSON.stringify(state.verdict.optionScores.B));
  assert("option C score is 3.0", state.verdict.optionScores.C.score === 3.0, JSON.stringify(state.verdict.optionScores.C));
  assert("verdict label is GO WITH CONDITIONS", state.verdict.label === "GO WITH CONDITIONS", state.verdict.label);
  assert("support is 7.2", state.verdict.support === 7.2, String(state.verdict.support));
  assert("confidence is 8", state.verdict.confidence === 8, String(state.verdict.confidence));
  assert("spread is 2", state.verdict.spread === 2, String(state.verdict.spread));
  assert("votes are 7 endorse 0 amend 1 dissent",
    eq(state.verdict.votes, { endorse: 7, amend: 0, dissent: 1 }), JSON.stringify(state.verdict.votes));
  assert("dissent list has exactly the investor",
    state.verdict.dissentList.length === 1 && state.verdict.dissentList[0].advisorId === "investor",
    JSON.stringify(state.verdict.dissentList));
  assert("minority is the investor", state.verdict.minority && state.verdict.minority.advisorId === "investor");
  assert("preferred-otherwise lists offer and philosopher",
    state.verdict.preferredOtherwise.length === 2 &&
    state.verdict.preferredOtherwise[0].advisorId === "offer" &&
    state.verdict.preferredOtherwise[1].advisorId === "philosopher" &&
    state.verdict.preferredOtherwise.every(function (d) { return d.topId === "B"; }),
    JSON.stringify(state.verdict.preferredOtherwise));
  const noDissentState = JSON.parse(JSON.stringify(state));
  Object.keys(noDissentState.final).forEach(function (id) { noDissentState.final[id].vote = "Endorse with amendment"; });
  const noDissentVerdict = BR.computeVerdict(noDissentState);
  noDissentState.verdict = noDissentVerdict;
  assert("zero dissent means no minority dissent line",
    noDissentVerdict.votes.dissent === 0 && noDissentVerdict.minority === null &&
    noDissentVerdict.preferredOtherwise.length === 2 &&
    BR.buildMarkdown(noDissentState).indexOf("dissented:") === -1,
    JSON.stringify(noDissentVerdict.votes) + " minority=" + JSON.stringify(noDissentVerdict.minority));
  assert("math line for A present", state.verdict.optionScores.A.math.indexOf("3x8") !== -1 && state.verdict.optionScores.A.math.indexOf("/ 12") !== -1 && state.verdict.optionScores.A.math.indexOf("= 6.9") !== -1, state.verdict.optionScores.A.math);

  const md = BR.buildMarkdown(state);
  assert("markdown has verdict label", md.indexOf("GO WITH CONDITIONS") !== -1);
  assert("markdown has math lines", md.indexOf("Math:") !== -1);
  assert("markdown has dissent notes", md.indexOf("Dissent notes") !== -1);
  assert("markdown has simulation disclaimer", md.indexOf("AI simulations") !== -1);
  const tx = BR.buildTranscriptText(state);
  assert("transcript has director and verdict", tx.indexOf("Director") !== -1 && tx.indexOf("VERDICT") !== -1);

  /* ---------- Auto-retry on garbage output ---------- */
  const state2 = makeDebate(1);
  const canned2 = makeCanned({ garbageFirst: { director: true } });
  const res2 = await BR.runDebate(state2, canned2.fn, function () {});
  assert("garbage first output is retried and run completes", res2.ok === true, JSON.stringify(res2));
  assert("director was called twice after garbage", canned2.calls.director === 2, String(canned2.calls.director));

  /* ---------- Failed step resumes without losing state ---------- */
  const state3 = makeDebate(1);
  const canned3 = makeCanned({ failOnce: { "opening:offer": true } });
  const res3a = await BR.runDebate(state3, canned3.fn, function () {});
  assert("failed step stops the run", res3a.ok === false && !!state3.failedStep, JSON.stringify(res3a));
  assert("failed step is opening:offer", state3.failedStep.key === "opening:offer", state3.failedStep.key);
  assert("earlier steps kept (director done)", !!state3.director);
  const res3b = await BR.resumeDebate(state3, canned3.fn, function () {});
  assert("resume completes after retry", res3b.ok === true, JSON.stringify(res3b));
  assert("offer opening vote exists after resume", !!state3.opening.offer);

  /* ---------- Merge: brains, quick mode, consult, verdict extras ---------- */
  assert("draft revisit recorded", state.draft.revisit === "Revisit in two weeks with close rate data.", String(state.draft.revisit));
  assert("every persona has distilled brain fields",
    BR.PERSONAS.every(function (p) {
      return p.frameworks && p.frameworks.length >= 3 && p.principles && p.principles.length >= 3 &&
        p.positions && p.positions.length >= 2 && p.stories && p.stories.length >= 1 &&
        typeof p.weightWhen === "string" && p.weightWhen.length > 0;
    }));
  assert("persona prompt carries frameworks and a hypothetical illustration",
    BR.PERSONAS.every(function (p) {
      var prompt = BR.personaPromptFor(p);
      return prompt.indexOf("Your frameworks:") !== -1 && prompt.indexOf("Illustration (hypothetical") !== -1 && prompt.indexOf("Never quote the person verbatim") !== -1;
    }));
  assert("director prompt carries weight guidance",
    BR.directorUser(makeDebate(1)).indexOf("Weight guidance") !== -1 &&
    BR.directorUser(makeDebate(1)).indexOf("Weight 3 when") !== -1);

  /* Quick mode: openings, vote, verdict. No debate rounds, no draft. */
  const quickState = BR.createDebate({
    title: "Quick test?", context: "C.", options: ["Do A", "Do B"],
    focus: "balanced", rounds: 3, mode: "quick", provider: "groq", model: "m",
    advisors: BR.PERSONAS.slice()
  });
  assert("quick mode forces 1 round", quickState.rounds === 1, String(quickState.rounds));
  const quickSteps = BR.buildStepList(quickState).map(function (s) { return s.key; });
  assert("quick step list has no debate or draft steps",
    quickSteps.every(function (k) { return k.indexOf("debate:") !== 0 && k !== "draft"; }),
    quickSteps.join(","));
  assert("quick step list is director plus openings plus finals plus verdict",
    quickSteps.length === 18 && quickSteps[0] === "director" && quickSteps[quickSteps.length - 1] === "verdict",
    quickSteps.join(","));
  const quickCanned = makeCanned({});
  const quickRes = await BR.runDebate(quickState, quickCanned.fn, function () {});
  assert("quick run completes", quickRes.ok === true, JSON.stringify(quickRes));
  assert("quick verdict exists and draft stays null", !!quickState.verdict && quickState.draft === null);
  assert("quick verdict label is GO WITH CONDITIONS", quickState.verdict.label === "GO WITH CONDITIONS", quickState.verdict.label);
  assert("quick markdown notes the skipped draft stage",
    BR.buildMarkdown(quickState).indexOf("Quick mode skips the draft resolution stage") !== -1);

  /* Consult: one seat, one prose prompt, no scoring state. */
  const consult = BR.createConsult({
    title: "Should I raise the price?", context: "Coaching at $2,000.",
    options: ["Raise to $3,500", "Keep $2,000"], focus: "balanced",
    provider: "groq", model: "m", advisor: BR.PERSONAS[1]
  });
  assert("consult state is consult mode with the picked seat",
    consult.mode === "consult" && consult.advisor.id === "offer", consult.mode + "/" + (consult.advisor && consult.advisor.id));
  const consultPrompt = BR.consultUser(consult, consult.advisor);
  assert("consult prompt carries the decision and the seat pillar",
    consultPrompt.indexOf("Should I raise the price?") !== -1 && consultPrompt.indexOf("Offers, pricing, and sales") !== -1);

  /* Verdict extras on the canned full run. */
  assert("verdict carries top reasons", Array.isArray(state.verdict.topReasons) && state.verdict.topReasons.length === 3,
    JSON.stringify(state.verdict.topReasons));
  assert("top reason is the operator", state.verdict.topReasons[0].advisorId === "operator",
    JSON.stringify(state.verdict.topReasons));
  assert("pillar fixes are empty when every pillar is above 4",
    Array.isArray(state.verdict.pillarFixes) && state.verdict.pillarFixes.length === 0,
    JSON.stringify(state.verdict.pillarFixes));
  const lowPillar = JSON.parse(JSON.stringify(state.verdict.pillarScores));
  lowPillar.investor = 3;
  const fixes = BR.pillarFixes(state, lowPillar);
  assert("pillar at 3 produces a named fix",
    fixes.length === 1 && fixes[0].advisorId === "investor" &&
    fixes[0].dimension === "Downside and capital efficiency" &&
    fixes[0].line === "Canned line for investor.",
    JSON.stringify(fixes));
  assert("verdict carries ratified amendments",
    Array.isArray(state.verdict.amendments) && state.verdict.amendments.length === 1,
    JSON.stringify(state.verdict.amendments));
  assert("dissent amendment is not adopted and goes to the minority report",
    state.verdict.amendments[0].adopted === false &&
    state.verdict.amendments[0].reason.indexOf("minority report") !== -1,
    JSON.stringify(state.verdict.amendments));
  const amendState = JSON.parse(JSON.stringify(state));
  amendState.final.investor = { vote: "Endorse with amendment", finalScore: 8, finalPillarScore: 7, amendment: "Add a cash test.", line: "L." };
  const amendVerdict = BR.computeVerdict(amendState);
  assert("amendment is carried when the resolution passes",
    amendVerdict.amendments.some(function (a) { return a.advisorId === "investor" && a.adopted === true; }),
    JSON.stringify(amendVerdict.amendments));
  assert("markdown carries ratification and pillar fixes",
    BR.buildMarkdown(state).indexOf("Ratification") !== -1 &&
    BR.buildMarkdown(state).indexOf("Pillar scorecard") !== -1);

  /* Live-test fixes: debate reason field, fallbacks, draft date anchor. */
  const debateState = makeDebate(1);
  debateState.director = { brief: "B.", weights: {}, cruxes: [{ question: "Q?", sides: [] }], assumptions: [] };
  assert("debate prompt requests a reason field",
    BR.debateUser(debateState, BR.PERSONAS[0], {}, 1).indexOf('"reason"') !== -1);
  assert("draft prompt anchors next-step dates to today",
    BR.draftUser(state, { A: { score: 6.9 }, B: { score: 4 }, C: { score: 2 } }, "A").indexOf("on or after today") !== -1);
  const blankState = JSON.parse(JSON.stringify(state));
  blankState.debateRounds.forEach(function (r) {
    Object.keys(r.cards).forEach(function (id) { r.cards[id].reason = ""; });
  });
  const blankVerdict = BR.computeVerdict(blankState);
  assert("top reasons fall back to final lines when debate reasons are empty",
    blankVerdict.topReasons.length === 3 &&
    blankVerdict.topReasons.every(function (r) { return r.reason.length > 0; }) &&
    blankVerdict.topReasons[0].reason === "Canned line for operator.",
    JSON.stringify(blankVerdict.topReasons));
  assert("preferred otherwise falls back to final lines",
    blankVerdict.preferredOtherwise.length === 2 &&
    blankVerdict.preferredOtherwise[0].advisorId === "offer" &&
    blankVerdict.preferredOtherwise[0].reason === "Canned line for offer.",
    JSON.stringify(blankVerdict.preferredOtherwise));

  /* ---------- Verdict bands ---------- */
  assert("band 7.5 is GO", BR.verdictBand(7.5) === "GO");
  assert("band 7.4 is GO WITH CONDITIONS", BR.verdictBand(7.4) === "GO WITH CONDITIONS");
  assert("band 6.0 is GO WITH CONDITIONS", BR.verdictBand(6.0) === "GO WITH CONDITIONS");
  assert("band 5.9 is RESHAPE", BR.verdictBand(5.9) === "RESHAPE");
  assert("band 4.5 is RESHAPE", BR.verdictBand(4.5) === "RESHAPE");
  assert("band 4.4 is DON'T DO IT", BR.verdictBand(4.4) === "DON'T DO IT");

  /* ---------- Ruin cap ---------- */
  const ruinState = makeDebate(1);
  ruinState.director = { weights: {}, cruxes: [{ question: "Q?", sides: [] }], brief: "B.", assumptions: [] };
  BR.PERSONAS.forEach(function (p) { ruinState.director.weights[p.id] = { weight: 1, reason: "R." }; });
  const highCards = {};
  BR.PERSONAS.forEach(function (p) {
    highCards[p.id] = { stance: "Yes", recommendedId: "A", optionScores: { A: 9, B: 2, C: 1 }, pillarScore: 9, confidence: 5, ruinRisk: p.id === "investor" ? "likely" : "none", door: "two-way", reason: "R.", changeMind: "N." };
  });
  ruinState.opening = highCards;
  ruinState.draft = { conditions: [], nextSteps: [], cheapestTest: "T.", killCriteria: "K.", risks: [], tradeoffs: [], waitFor: null };
  ruinState.final = {};
  BR.PERSONAS.forEach(function (p) {
    ruinState.final[p.id] = { vote: "Endorse", finalScore: 9, finalPillarScore: 9, amendment: "", line: "L." };
  });
  const ruinVerdict = BR.computeVerdict(ruinState);
  assert("ruin cap forces RESHAPE", ruinVerdict.label === "RESHAPE", ruinVerdict.label);
  assert("ruin override is recorded", ruinVerdict.overrides.length === 1);

  /* ---------- One-way door cap ---------- */
  const doorState = makeDebate(1);
  doorState.director = { weights: {}, cruxes: [{ question: "Q?", sides: [] }], brief: "B.", assumptions: [] };
  BR.PERSONAS.forEach(function (p) { doorState.director.weights[p.id] = { weight: 1, reason: "R." }; });
  const doorCards = {};
  const doorScores = { operator: 9, offer: 9, investor: 9, marketer: 9, philosopher: 4, founder: 4, saas: 9, eos: 9 };
  BR.PERSONAS.forEach(function (p) {
    doorCards[p.id] = { stance: "Yes", recommendedId: "A", optionScores: { A: doorScores[p.id], B: 2, C: 1 }, pillarScore: 8, confidence: 4, ruinRisk: "none", door: "one-way", reason: "R.", changeMind: "N." };
  });
  doorState.opening = doorCards;
  doorState.draft = { conditions: [], nextSteps: [], cheapestTest: "T.", killCriteria: "K.", risks: [], tradeoffs: [], waitFor: null };
  doorState.final = {};
  BR.PERSONAS.forEach(function (p) {
    doorState.final[p.id] = { vote: "Endorse", finalScore: 8, finalPillarScore: 8, amendment: "", line: "L." };
  });
  const doorVerdict = BR.computeVerdict(doorState);
  assert("one-way door cap forces GO WITH CONDITIONS", doorVerdict.label === "GO WITH CONDITIONS", doorVerdict.label);
  assert("one-way spread is 5", doorVerdict.spread === 5, String(doorVerdict.spread));

  /* ---------- JSON extraction edge cases ---------- */
  assert("extract fenced json", !!BR.extractJSON("```json\n{\"a\": 1}\n```") && BR.extractJSON("```json\n{\"a\": 1}\n```").a === 1);
  assert("extract json with lead-in text", !!BR.extractJSON("Here is the result:\n{\"a\": 2}") && BR.extractJSON("Here is the result:\n{\"a\": 2}").a === 2);
  assert("extract rejects non-json", BR.extractJSON("no json here") === null);
  assert("extract rejects array", BR.extractJSON("[1, 2]") === null);
  const strNum = BR.validateOpening({ stance: "Yes", optionScores: { A: "7", B: "5", C: "3" }, pillarScore: "8", confidence: "4", ruinRisk: "none", door: "two-way", reason: "R.", changeMind: "N." }, ["A", "B", "C"]);
  assert("string numbers coerce", !!strNum && strNum.optionScores.A === 7 && strNum.pillarScore === 8);
  const missingNum = BR.validateOpening({ stance: "Yes", optionScores: { A: 7, C: 3 }, pillarScore: 8, confidence: 4, ruinRisk: "none", door: "two-way", reason: "R.", changeMind: "N." }, ["A", "B", "C"]);
  assert("missing option score fails validation", missingNum === null);
  const missingStance = BR.validateOpening({ optionScores: { A: 9, B: 2, C: 1 }, pillarScore: 8, confidence: 4, ruinRisk: "none", door: "two-way", reason: "R.", changeMind: "N." }, ["A", "B", "C"]);
  assert("missing stance derives from top score", !!missingStance && missingStance.stance === "Strong yes");

  /* ---------- Input limits ---------- */
  const longTitle = new Array(300).join("x");
  const lim = BR.createDebate({ title: longTitle, context: "c", options: ["O1", "O2", "O3", "O4", "O5", "O6"], rounds: 9, provider: "groq", model: "m", advisors: BR.PERSONAS.slice() });
  assert("title capped at 200", lim.title.length === 200, String(lim.title.length));
  assert("options capped at 4 user options plus do nothing", lim.options.length === 5, JSON.stringify(lim.options));
  assert("rounds capped at 3", lim.rounds === 3, String(lim.rounds));
  const emptyOpts = BR.createDebate({ title: "T", context: "C", options: [], rounds: 1, provider: "groq", model: "m", advisors: BR.PERSONAS.slice() });
  assert("empty options fall back to do-it plus do-nothing", emptyOpts.options.length === 2, JSON.stringify(emptyOpts.options));

  /* ---------- Option marker stripping (no doubled "Option B B:") ---------- */
  const stripState = BR.createDebate({ title: "T", context: "C", options: ["B: Paid pilot at full price", "2. Keep the price", "Option C: Free audit", "Plain label"], rounds: 1, provider: "groq", model: "m", advisors: BR.PERSONAS.slice() });
  assert("option markers are stripped before storage",
    eq(stripState.options.map(function (o) { return o.label; }),
      ["Paid pilot at full price", "Keep the price", "Free audit", "Plain label", "Do nothing"]),
    JSON.stringify(stripState.options));
  const plainState = BR.createDebate({ title: "T", context: "C", options: ["Build the thing", "Email setup", "2024 roadmap", "B Paid pilot"], rounds: 1, provider: "groq", model: "m", advisors: BR.PERSONAS.slice() });
  assert("labels without a marker are untouched",
    eq(plainState.options.map(function (o) { return o.label; }),
      ["Build the thing", "Email setup", "2024 roadmap", "B Paid pilot", "Do nothing"]),
    JSON.stringify(plainState.options));
  const dupeState = BR.createDebate({ title: "T", context: "C", options: ["B: Paid pilot", "Paid pilot"], rounds: 1, provider: "groq", model: "m", advisors: BR.PERSONAS.slice() });
  assert("dedupe runs after stripping, so a marked and plain twin collapse",
    eq(dupeState.options.map(function (o) { return o.label; }), ["Paid pilot", "Do nothing"]),
    JSON.stringify(dupeState.options));

  /* ---------- Personas ---------- */
  assert("eight personas shipped", BR.PERSONAS.length === 8, String(BR.PERSONAS.length));
  assert("every persona has a prompt", BR.PERSONAS.every(function (p) { return BR.personaPromptFor(p).length > 200; }));
  assert("custom persona builds", (function () {
    const c = BR.buildCustomPersona("The Skeptic", "Demand proof of distribution.");
    return c.id === "custom" && c.initials === "TS" && BR.personaPromptFor(c).indexOf("Demand proof of distribution.") !== -1;
  })());

  /* ---------- Provider badge on served steps ---------- */
  const badgeState = makeDebate(1);
  const badgeCanned = makeCanned({});
  const badgeFn = function (s, step) {
    return badgeCanned.fn(s, step).then(function (res) {
      if (step.key === "opening:operator" && res.ok) {
        res.servedBy = { provider: "openrouter", model: BR.OPENROUTER_FREE_CHAIN[0] };
      }
      return res;
    });
  };
  const badgeRes = await BR.runDebate(badgeState, badgeFn, function () {});
  assert("badge: run with a served step completes", badgeRes.ok === true, JSON.stringify(badgeRes));
  assert("badge: state records the serving provider and model",
    eq(badgeState.servedBy["opening:operator"], { provider: "openrouter", model: BR.OPENROUTER_FREE_CHAIN[0] }),
    JSON.stringify(badgeState.servedBy));
  const badgeEntry = badgeState.transcript.find(function (t) { return t.stepKey === "opening:operator"; });
  assert("badge: operator opening entry carries its step key", !!badgeEntry,
    JSON.stringify(badgeState.transcript.map(function (t) { return t.stepKey; })));
  const badgeTx = BR.buildTranscriptText(badgeState);
  assert("badge: transcript flags only the fallback-served step",
    badgeTx.indexOf("[via openrouter · " + BR.OPENROUTER_FREE_CHAIN[0] + "]") !== -1 &&
    badgeTx.split("[via ").length === 2, badgeTx);
  const freshState = makeDebate(1);
  assert("badge: new debate starts with an empty served map", eq(freshState.servedBy, {}), JSON.stringify(freshState.servedBy));

  /* ---------- Integration: brain slices, discussion, playback ---------- */
  assert("slices exist for all eight seats",
    BR.PERSONAS.every(function (p) { return !!BR.BRAIN_SLICES[p.id]; }));
  assert("slice prompts stay lean (150 to 530 words) for every seat and step",
    BR.PERSONAS.every(function (p) {
      return ["opening", "debate", "discussion", "final", "consult"].every(function (s) {
        var n = BR.sliceWordCount(p, s, BR.PERSONAS[1]);
        return n >= 150 && n <= 530;
      });
    }));
  assert("debate slices carry an edge and final slices carry a steelman",
    BR.PERSONAS.every(function (p) {
      return BR.slicePrompt(p, "debate").indexOf("Edge:") !== -1 &&
        BR.slicePrompt(p, "final").indexOf("Strongest counter to your own lens:") !== -1 &&
        BR.slicePrompt(p, "discussion", BR.PERSONAS[1]).indexOf("concede only when beaten") !== -1;
    }));
  assert("slice prompts carry the simulation disclaimer and voice, never a source id",
    BR.PERSONAS.every(function (p) {
      var t = BR.slicePrompt(p, "opening");
      return t.indexOf("You are NOT") !== -1 && t.indexOf("Your voice:") !== -1 &&
        t.indexOf("Never quote the person verbatim") !== -1 && t.indexOf("[S") === -1;
    }));
  assert("discussion slice names the target seat difference",
    BR.slicePrompt(BR.PERSONAS[0], "discussion", BR.PERSONAS[1]).indexOf("flywheel") !== -1 &&
    BR.slicePrompt(BR.PERSONAS[0], "discussion", BR.PERSONAS[1]).indexOf("Answer Offer directly") !== -1);
  assert("consult slice carries a modern application line",
    BR.slicePrompt(BR.PERSONAS[0], "consult").indexOf("Modern application") !== -1);
  assert("custom persona slice falls back to the custom prompt",
    BR.slicePrompt(BR.buildCustomPersona("The Skeptic", "Demand proof."), "opening").indexOf("Demand proof.") !== -1);
  assert("discussion validation passes a complete adversarial card",
    !!BR.validateDiscussion({ answerTo: "Offer", agree: "disagree", pointAnswered: "P.", steelman: "Offer's point at its strongest, fairly stated.", weakPoint: "W.", reply: "R.", concede: "Nothing conceded: the attack fails because the premise holds.", costOfBeingWrong: "C.", evidenceDemanded: "E.", reason: "X." }));
  assert("discussion validation requires a labelled steelman",
    BR.validateDiscussion({ answerTo: "Offer", agree: "disagree", pointAnswered: "P.", weakPoint: "W.", reply: "R.", concede: "Nothing conceded: the attack fails because the premise holds.", costOfBeingWrong: "C.", evidenceDemanded: "E." }) === null &&
    BR.validateDiscussion({ answerTo: "Offer", agree: "disagree", pointAnswered: "P.", steelman: "Too short.", weakPoint: "W.", reply: "R.", concede: "Nothing conceded: the attack fails because the premise holds.", costOfBeingWrong: "C.", evidenceDemanded: "E." }) === null);
  assert("discussion validation rejects a bare nothing concession",
    BR.concessionIsReasoned("Nothing.") === false &&
    BR.concessionIsReasoned("None") === false &&
    BR.concessionIsReasoned("No concession") === false &&
    BR.validateDiscussion({ answerTo: "Offer", agree: "disagree", pointAnswered: "P.", steelman: "Offer's point at its strongest, fairly stated.", weakPoint: "W.", reply: "R.", concede: "Nothing.", costOfBeingWrong: "C.", evidenceDemanded: "E." }) === null);
  assert("discussion validation accepts a reasoned nothing concession",
    BR.concessionIsReasoned("Nothing conceded: the attack fails because the premise holds.") === true &&
    BR.concessionIsReasoned("I concede the timing point because the cash data beats my case.") === true);
  assert("discussion validation rejects a missing agree, point, weak point, concede, cost, or evidence",
    BR.validateDiscussion({ answerTo: "Offer", pointAnswered: "P.", weakPoint: "W.", reply: "R.", concede: "N.", costOfBeingWrong: "C.", evidenceDemanded: "E." }) === null &&
    BR.validateDiscussion({ answerTo: "Offer", agree: "agree", reply: "R.", concede: "N.", costOfBeingWrong: "C.", evidenceDemanded: "E." }) === null &&
    BR.validateDiscussion({ answerTo: "Offer", agree: "agree", pointAnswered: "P.", reply: "R.", concede: "N.", costOfBeingWrong: "C.", evidenceDemanded: "E." }) === null &&
    BR.validateDiscussion({ answerTo: "Offer", agree: "agree", pointAnswered: "P.", weakPoint: "W.", reply: "R.", costOfBeingWrong: "C.", evidenceDemanded: "E." }) === null &&
    BR.validateDiscussion({ answerTo: "Offer", agree: "agree", pointAnswered: "P.", weakPoint: "W.", reply: "R.", concede: "N.", evidenceDemanded: "E." }) === null &&
    BR.validateDiscussion({ answerTo: "Offer", agree: "agree", pointAnswered: "P.", weakPoint: "W.", reply: "R.", concede: "N.", costOfBeingWrong: "C." }) === null);
  assert("discussion validation accepts concession and weak premise aliases",
    (function () {
      var v = BR.validateDiscussion({ answerTo: "Offer", agree: "disagree", pointAnswered: "P.", steelman: "Offer's point at its strongest, fairly stated.", weakestPremise: "W.", reply: "R.", concession: "I concede the timing point because the cash data beats my case.", costOfBeingWrong: "C.", evidenceDemanded: "E." });
      return !!v && v.weakPoint === "W." && v.concede.indexOf("timing point") !== -1;
    })());
  assert("discussion target resolution turns topic labels into their owning seats",
    (function () {
      var s = makeDebate(1);
      s.discussionTargets = { operator: "offer", philosopher: "offer", founder: "offer" };
      var lev = BR.resolveDiscussionTarget(s, "operator", "Leverage");
      var ops = BR.resolveDiscussionTarget(s, "founder", "Operations");
      var real = BR.resolveDiscussionTarget(s, "operator", "Offer");
      var unknown = BR.resolveDiscussionTarget(s, "operator", "Zebra");
      var self = BR.resolveDiscussionTarget(s, "philosopher", "Leverage");
      return lev && lev.id === "philosopher" && ops && ops.id === "eos" &&
        real && real.id === "offer" && unknown && unknown.id === "offer" &&
        self && self.id === "offer" && self.id !== "philosopher";
    })());
  assert("discussion step stores a resolved seat target, never a topic label",
    (function () {
      var s = makeDebate(1);
      s.opening = {};
      BR.PERSONAS.forEach(function (p) {
        s.opening[p.id] = { stance: "Yes", recommendedId: p.id === "offer" ? "B" : "A", optionScores: { A: 7, B: 6, C: 3 }, pillarScore: p.id === "offer" ? 9 : 5, confidence: 4, ruinRisk: "none", door: "two-way", reason: "R.", changeMind: "N." };
      });
      var parsed = { answerTo: "Leverage", agree: "disagree", pointAnswered: "P.", steelman: "The point at its strongest, fairly stated here.", weakPoint: "W.", reply: "R.", concede: "Nothing conceded: the attack fails because the premise holds.", costOfBeingWrong: "C.", evidenceDemanded: "E." };
      var applied = BR.applyStepResult(s, { key: "discussion:operator", advisorId: "operator" }, parsed);
      var entry = s.transcript[s.transcript.length - 1];
      return applied.ok === true && entry.answerTo === "Philosopher" && entry.targetId === "philosopher";
    })());
  assert("invented links are caught: brief links pass, foreign links fail, plain text passes",
    (function () {
      var brief = "See our pricing page at https://example.com/pricing for the numbers.";
      return BR.containsInventedLink("Read https://example.com/pricing for detail.", brief) === false &&
        BR.containsInventedLink("See https://fake-source.example/report for proof.", brief) === true &&
        BR.containsInventedLink("Visit www.not-in-brief.example for more.", brief) === true &&
        BR.containsInventedLink("No links here, just a plain argument.", brief) === false &&
        BR.containsInventedLink("Any https://link.example is invented with no brief.", "") === true &&
        BR.containsInventedLink("", brief) === false;
    })());
  assert("applyStepResult rejects a card carrying an invented link and stores a clean card",
    (function () {
      var s = makeDebate(1);
      s.opening = {};
      var bad = { stance: "Yes", optionScores: { A: 8, B: 5, C: 3 }, pillarScore: 7, confidence: 4, ruinRisk: "none", door: "two-way", reason: "See https://invented.example for the data.", changeMind: "N." };
      var good = { stance: "Yes", optionScores: { A: 8, B: 5, C: 3 }, pillarScore: 7, confidence: 4, ruinRisk: "none", door: "two-way", reason: "Clean reason.", changeMind: "N." };
      var rejected = BR.applyStepResult(s, { key: "opening:operator", advisorId: "operator" }, bad);
      var stored = BR.applyStepResult(s, { key: "opening:operator", advisorId: "operator" }, good);
      return rejected.ok === false && stored.ok === true && !!s.opening.operator && s.opening.operator.reason === "Clean reason.";
    })());
  assert("discussion prompt attacks the shared case when everyone agrees",
    (function () {
      const sU = makeDebate(1);
      sU.opening = {};
      BR.PERSONAS.forEach(function (p) {
        sU.opening[p.id] = { stance: "Yes", recommendedId: "A", optionScores: { A: 7, B: 6, C: 3 }, pillarScore: 7, confidence: 4, ruinRisk: "none", door: "two-way", reason: "Shared reason.", changeMind: "N." };
      });
      const u = BR.discussionUser(sU, BR.PERSONAS[0], BR.PERSONAS[1], sU.opening.offer);
      return u.indexOf("Do not agree politely") !== -1 && u.indexOf("weakPoint") !== -1 && u.indexOf("evidenceDemanded") !== -1;
    })());
  assert("discussion prompt requires the steelman field and a reasoned concession",
    (function () {
      const sP = makeDebate(1);
      sP.opening = {};
      BR.PERSONAS.forEach(function (p) {
        sP.opening[p.id] = { stance: "Yes", recommendedId: "A", optionScores: { A: 7, B: 6, C: 3 }, pillarScore: 7, confidence: 4, ruinRisk: "none", door: "two-way", reason: "R.", changeMind: "N." };
      });
      const u = BR.discussionUser(sP, BR.PERSONAS[0], BR.PERSONAS[1], sP.opening.offer);
      return u.indexOf('"steelman"') !== -1 && u.indexOf("at least 20 characters") !== -1 && u.indexOf("bare word like nothing") !== -1;
    })());
  assert("discussion targets are assigned distinctly, never self, and used targets stay taken on resume",
    (function () {
      var sA = makeDebate(1);
      sA.opening = {};
      BR.PERSONAS.forEach(function (p) {
        sA.opening[p.id] = { stance: "Yes", recommendedId: p.id === "offer" ? "B" : "A", optionScores: { A: 7, B: 6, C: 3 }, pillarScore: p.id === "offer" ? 9 : 5, confidence: 4, ruinRisk: "none", door: "two-way", reason: "R.", changeMind: "N." };
      });
      var assigned = BR.assignDiscussionTargets(sA);
      var values = Object.keys(assigned).map(function (k) { return assigned[k]; });
      var distinct = values.filter(function (v, i) { return values.indexOf(v) === i; }).length;
      var selfTarget = Object.keys(assigned).some(function (k) { return assigned[k] === k; });
      var resumed = BR.assignDiscussionTargets(sA);
      return distinct === values.length && !selfTarget && BR.discussionTargetFor(sA, "operator").id === assigned.operator;
    })());
  assert("round table geometry places seats on an ellipse and leans by real angle",
    (function () {
      var top = BR.seatPointFor(0, 8);
      var right = BR.seatPointFor(2, 8);
      var vec = BR.leanVectorFor(0, 2, 8);
      return Math.abs(top.x - 50) < 0.01 && top.y < 14 && right.x > 90 && vec && vec.dx > 0 && vec.dy > 0;
    })());
  assert("round table geometry: no seat overlaps another seat or the centre table, at 8 or 9 seats, at any round-layout width",
    (function () {
      /* Full seat rectangles, not centres: seats are 144px wide and
         up to 261px tall (120px full-body figure plus name, state,
         two-line role, and status). The stage height is read
         from the live CSS, so a height regression fails here instead
         of silently reintroducing overlap. Widths are stage content
         widths: 661px is the narrowest round layout (701px viewport
         minus main padding, just above the 700px grid fallback) and
         1040px is the widest (1080px main minus padding). The centre
         table is min(46 percent, 420px) wide above the 900px
         breakpoint and min(48 percent, 420px) at or below it, with
         aspect ratio 1.6. The top seat may rise at most 26px above
         the stage (the h2 plus stage margins above it) and the
         bottom seat may extend at most 120px below it (the stage
         bottom margin). The tightest pair is the 9-seat side pair
         with a 1.4px horizontal gap at 661px, inside seat padding,
         never over text. The pair check runs twice: once static, and
         once with the lower seat lifted 22px, the speaking peak, so
         a speaking seat never rises into its upper neighbour. */
      var css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
      var m = /\.stage-round\s*\{[^}]*min-height:\s*(\d+)px/.exec(css);
      if (!m) { return false; }
      var stageH = parseInt(m[1], 10);
      if (css.indexOf("margin: 12px 0 120px") === -1) { return false; }
      var seatW = 144, seatH = 261;
      function overlaps(a, b) {
        return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      }
      var widths = [661, 701, 760, 850, 900, 901, 1000, 1040];
      var totals = [8, 9];
      for (var wi = 0; wi < widths.length; wi++) {
        var stageW = widths[wi];
        var tableW = stageW <= 900 ? Math.min(0.48 * stageW, 420) : Math.min(0.46 * stageW, 420);
        var tableH = tableW / 1.6;
        var table = { left: stageW / 2 - tableW / 2, right: stageW / 2 + tableW / 2,
          top: stageH / 2 - tableH / 2, bottom: stageH / 2 + tableH / 2 };
        for (var ti = 0; ti < totals.length; ti++) {
          var rects = [];
          for (var i = 0; i < totals[ti]; i++) {
            var pt = BR.seatPointFor(i, totals[ti]);
            var r = { left: pt.x / 100 * stageW - seatW / 2, right: pt.x / 100 * stageW + seatW / 2,
              top: pt.y / 100 * stageH - seatH / 2, bottom: pt.y / 100 * stageH + seatH / 2 };
            if (r.top < -26 || r.bottom > stageH + 120) { return false; }
            if (overlaps(r, table)) { return false; }
            rects.push(r);
          }
          for (var a = 0; a < rects.length; a++) {
            for (var b = a + 1; b < rects.length; b++) {
              if (overlaps(rects[a], rects[b])) { return false; }
              /* Speaking lift: the lower seat rises 22px toward the
                 upper seat at the animation peak. */
              var lower = rects[a].top > rects[b].top ? rects[a] : rects[b];
              var upper = lower === rects[a] ? rects[b] : rects[a];
              var lifted = { left: lower.left, right: lower.right, top: lower.top - 22, bottom: lower.bottom - 22 };
              if (overlaps(lifted, upper)) { return false; }
            }
          }
        }
      }
      return true;
    })());
  assert("resume skips completed steps and reports a completed debate as done",
    (function () {
      var resumed = makeDebate(1);
      resumed.director = { weights: {} };
      resumed.opening = {};
      BR.PERSONAS.forEach(function (p) {
        resumed.opening[p.id] = { stance: "Yes", recommendedId: "A", optionScores: { A: 7, B: 6, C: 3 }, pillarScore: 7, confidence: 4, ruinRisk: "none", door: "two-way", reason: "R.", changeMind: "N." };
      });
      var steps = BR.buildStepList(resumed);
      var done = steps.filter(function (s) { return BR.stepAlreadyDone(resumed, s); });
      return done.length === 9 && BR.stepAlreadyDone(resumed, { key: "discussion:operator" }) === false;
    })());
  assert("debate prompt requires a steelman before the attack",
    BR.debateUser(state, BR.PERSONAS[0], state.opening, 1).indexOf("Steelman it in one sentence") !== -1);
  assert("final prompt requires cost of being wrong and a kill signal in the line",
    BR.finalUser(state, BR.PERSONAS[0]).indexOf("cost of being wrong and the kill signal") !== -1);
  const discState = makeDebate(1);
  discState.opening = {};
  BR.PERSONAS.forEach(function (p) {
    discState.opening[p.id] = { stance: "Yes", recommendedId: p.id === "offer" ? "B" : "A", optionScores: { A: 7, B: 6, C: 3 }, pillarScore: p.id === "offer" ? 9 : 5, confidence: 4, ruinRisk: "none", door: "two-way", reason: "R.", changeMind: "N." };
  });
  assert("discussion target is the strongest opposing seat, never self",
    (function () {
      var t = BR.strongestDiscussionTarget(discState, "operator");
      return t && t.id === "offer" && t.id !== "operator";
    })());
  const fullSteps = BR.buildStepList(makeDebate(2)).map(function (s) { return s.key; });
  assert("full step list runs discussion after debate and before draft",
    fullSteps.indexOf("discussion:operator") !== -1 &&
    fullSteps.indexOf("discussion:operator") > fullSteps.indexOf("debate:2:eos") &&
    fullSteps.indexOf("discussion:operator") < fullSteps.indexOf("draft"));
  assert("quick step list has no discussion steps",
    BR.buildStepList(quickState).every(function (s) { return s.key.indexOf("discussion:") !== 0; }));
  assert("full run recorded all eight discussion cards",
    Object.keys(state.discussion).length === 8, JSON.stringify(Object.keys(state.discussion)));
  assert("full run transcript has eight discussion entries",
    state.transcript.filter(function (t) { return t.kind === "discussion"; }).length === 8);
  assert("discussion does not change verdict maths (still GO WITH CONDITIONS, A 6.9)",
    state.verdict.label === "GO WITH CONDITIONS" && state.verdict.optionScores.A.score === 6.9);
  assert("markdown carries an adversarial discussion section",
    BR.buildMarkdown(state).indexOf("## Discussion") !== -1 &&
    BR.buildMarkdown(state).indexOf("Canned discussion reply.") !== -1 &&
    BR.buildMarkdown(state).indexOf("Steelman: Canned steelman") !== -1 &&
    BR.buildMarkdown(state).indexOf("Weak point: Canned weak premise.") !== -1 &&
    BR.buildMarkdown(state).indexOf("Concedes: Nothing conceded") !== -1 &&
    BR.buildMarkdown(state).indexOf("Cost if wrong: Canned cost if wrong.") !== -1 &&
    BR.buildMarkdown(state).indexOf("Settles it: Canned settling number.") !== -1);
  assert("transcript text annotates discussion answers with weak point, concede, cost, and evidence",
    BR.buildTranscriptText(state).indexOf("steelman: Canned steelman") !== -1 &&
    BR.buildTranscriptText(state).indexOf("weak point: Canned weak premise.") !== -1 &&
    BR.buildTranscriptText(state).indexOf("concedes: Nothing conceded") !== -1 &&
    BR.buildTranscriptText(state).indexOf("cost if wrong: Canned cost if wrong.") !== -1 &&
    BR.buildTranscriptText(state).indexOf("settles it: Canned settling number.") !== -1);
  assert("stepper has eight labels in full mode and discussion is phase 4",
    BR.stepperLabelsFor(state).length === 8 && BR.stepperLabelsFor(state)[4] === "Discussion" &&
    (function () {
      const s2 = makeDebate(1);
      s2.director = { weights: {}, cruxes: [], brief: "B.", assumptions: [] };
      s2.debateRounds = [{ round: 1, cards: {} }];
      s2.discussion = { operator: { answerTo: "Offer", agree: "agree", pointAnswered: "P.", reply: "R.", reason: "" } };
      return BR.phaseOf(s2) === 4;
    })());
  assert("current rebuttal picks up discussion pairs as answers",
    (function () {
      const s3 = makeDebate(1);
      s3.transcript = [{ kind: "discussion", speaker: "Operator", title: "Discussion", body: "R.", answerTo: "Offer", agree: "agree", pointAnswered: "P." }];
      const r = BR.currentRebuttal(s3);
      return !!r && r.kind === "discussion" && r.from.id === "operator" && r.to.id === "offer";
    })());
  assert("stage leans toward the addressed seat and labels discussion as answers",
    (function () {
      const s4 = makeDebate(1);
      s4.director = { weights: {}, cruxes: [], brief: "B.", assumptions: [] };
      BR.PERSONAS.forEach(function (p) { s4.director.weights[p.id] = { weight: 1, reason: "R." }; });
      s4.final = {};
      const c = { innerHTML: "" };
      BR.renderStage(c, s4, "operator", { from: BR.PERSONAS[0], to: BR.PERSONAS[1], kind: "discussion" });
      return c.innerHTML.indexOf("lean-toward") !== -1 && c.innerHTML.indexOf("--lean-dx:") !== -1 &&
        c.innerHTML.indexOf("stage-round") !== -1 && c.innerHTML.indexOf("round-table") !== -1 &&
        c.innerHTML.indexOf("answers Offer") !== -1;
    })());
  assert("transcript renders discussion answers lines",
    (function () {
      const s5 = makeDebate(1);
      s5.transcript = [{ kind: "discussion", speaker: "Operator", title: "Discussion", body: "R.", answerTo: "Offer", agree: "disagree", pointAnswered: "P.", steelman: "S.", weakPoint: "W.", concede: "Nothing.", costOfBeingWrong: "C.", evidenceDemanded: "E." }];
      s5.servedBy = {};
      const c = { innerHTML: "" };
      BR.renderTranscript(c, s5, null);
      return c.innerHTML.indexOf("Answers Offer") !== -1 && c.innerHTML.indexOf("Steelman: S.") !== -1 && c.innerHTML.indexOf("Weak point: W.") !== -1 &&
        c.innerHTML.indexOf("Concedes: Nothing.") !== -1 && c.innerHTML.indexOf("Cost if wrong: C.") !== -1;
    })());
  assert("old saved debates render without discussion or served data",
    (function () {
      const old = makeDebate(1);
      old.director = { weights: {}, cruxes: [{ question: "Q?", sides: [] }], brief: "Old brief.", assumptions: [] };
      BR.PERSONAS.forEach(function (p) { old.director.weights[p.id] = { weight: 1, reason: "R." }; });
      old.opening = { operator: { stance: "Yes", recommendedId: "A", optionScores: { A: 8, B: 6, C: 3 }, pillarScore: 7, confidence: 4, ruinRisk: "none", door: "two-way", reason: "Old reason.", changeMind: "N." } };
      old.transcript = [{ kind: "vote", speaker: "Operator", title: "Opening vote", body: "Yes on option A. Old reason." }];
      old.final = {};
      delete old.discussion;
      const c1 = { innerHTML: "" };
      const c2 = { innerHTML: "" };
      BR.renderTranscript(c1, old, null);
      BR.renderStage(c2, old, null, null);
      return c1.innerHTML.indexOf("Old reason.") !== -1 && c1.innerHTML.indexOf("Answers") === -1 &&
        c2.innerHTML.indexOf("Operator") !== -1;
    })());
  assert("playback helpers split words and cycle mouth states",
    eq(BR.splitWords("  hello   world  "), ["hello", "world"]) &&
    BR.mouthClassFor(0) === "mouth-closed" && BR.mouthClassFor(1) === "mouth-mid" &&
    BR.mouthClassFor(2) === "mouth-open" && BR.mouthClassFor(3) === "mouth-mid" &&
    BR.mouthClassFor(4) === "mouth-closed");
  assert("mouth rule varies by word and falls back to the cycle without one",
    BR.mouthClassFor(0, "apple") === "mouth-open" && BR.mouthClassFor(0, "mom") === "mouth-closed" &&
    BR.mouthClassFor(0, "sun") === "mouth-mid" && BR.mouthClassFor(0, "") === "mouth-closed" &&
    BR.mouthClassFor(2) === "mouth-open");
  assert("look direction follows table geometry and stays neutral straight ahead",
    BR.lookDirectionFor(0, 2, 8) === "right" && BR.lookDirectionFor(0, 6, 8) === "left" &&
    BR.lookDirectionFor(0, 0, 8) === "" && BR.lookDirectionFor(0, 4, 8) === "");
  assert("reactions land on the addressed seat from its own vote or card, never from tone",
    BR.targetReactionFor("A", "A", "") === "nod" && BR.targetReactionFor("A", "B", "") === "" &&
    BR.targetReactionFor("A", "B", "Endorse") === "nod" && BR.targetReactionFor("A", "B", "Endorse with amendment") === "nod" &&
    BR.targetReactionFor("A", "A", "Dissent") === "shake" && BR.targetReactionFor("A", "B", "Something else") === "");
  assert("interaction arc stops at seat edges, not centres, and rejects identical seats",
    (function () {
      var d = BR.arcPathFor(0, 2, 8, 800, 560);
      var m = d ? d.match(/M (\d+) (\d+) Q (\d+) (\d+) (\d+) (\d+)/) : null;
      return !!m && !(m[1] === "400" && m[2] === "73") && !(m[5] === "736" && m[6] === "280") &&
        BR.arcPathFor(0, 0, 8, 800, 560) === null && BR.arcPathFor(0, 2, 8, 0, 560) === null;
    })());
  assert("history dates render in readable local form without an invented timezone",
    (function () {
      var f = BR.formatHistoryDate("2026-10-29T14:09:00.000Z");
      return f !== "2026-10-29T14:09:00.000Z" && f.indexOf("2026") !== -1 &&
        BR.formatHistoryDate("not-a-date") === "not-a-date";
    })());
  assert("concessions render as their own line only when the card carries one",
    (function () {
      var s = makeDebate(1);
      s.transcript = [{
        kind: "discussion", speaker: "Operator", title: "Discussion", body: "Reply.",
        answerTo: "Offer", agree: "disagree", pointAnswered: "P.",
        steelman: "Offer's point at its strongest, fairly stated.", weakPoint: "W.",
        concede: "I concede the timing point because the cash data beats my case.",
        costOfBeingWrong: "C.", evidenceDemanded: "E."
      }];
      var c1 = { innerHTML: "" };
      BR.renderTranscript(c1, s, null);
      var s2 = makeDebate(1);
      s2.transcript = [{
        kind: "discussion", speaker: "Operator", title: "Discussion", body: "Reply.",
        answerTo: "Offer", agree: "disagree", pointAnswered: "P.",
        steelman: "Offer's point at its strongest, fairly stated.", weakPoint: "W.",
        concede: "", costOfBeingWrong: "C.", evidenceDemanded: "E."
      }];
      var c2 = { innerHTML: "" };
      BR.renderTranscript(c2, s2, null);
      var s3 = makeDebate(1);
      s3.transcript = [{
        kind: "argument", speaker: "Operator", title: "Debate round 1", body: "Rebuttal.",
        disagreeWith: "Offer", concede: "I concede the timing point because the cash data beats my case."
      }];
      var c3 = { innerHTML: "" };
      BR.renderTranscript(c3, s3, null);
      return c1.innerHTML.indexOf("Concedes: I concede the timing point") !== -1 &&
        c2.innerHTML.indexOf("Concedes:") === -1 &&
        c3.innerHTML.indexOf("Concedes: I concede the timing point") !== -1;
    })());
  assert("legacy discussion entries with a topic label render as the owning seat",
    (function () {
      var s = makeDebate(1);
      s.transcript = [{
        kind: "discussion", speaker: "Operator", title: "Discussion", body: "Reply.",
        answerTo: "Leverage", agree: "disagree", pointAnswered: "P.",
        steelman: "The point at its strongest, fairly stated.", weakPoint: "W.",
        concede: "Nothing conceded: the attack fails because the premise holds.",
        costOfBeingWrong: "C.", evidenceDemanded: "E."
      }];
      var c = { innerHTML: "" };
      BR.renderTranscript(c, s, null);
      var tx = BR.buildTranscriptText(s);
      return c.innerHTML.indexOf("Answers Philosopher") !== -1 &&
        c.innerHTML.indexOf("Answers Leverage") === -1 &&
        tx.indexOf("answers Philosopher") !== -1;
    })());
  assert("stage renders look direction and an addressed target seat",
    (function () {
      var s = makeDebate(1);
      var c = { innerHTML: "" };
      BR.renderStage(c, s, "operator", { from: BR.PERSONAS[0], to: BR.PERSONAS[1], kind: "argument" });
      return c.innerHTML.indexOf("look-right") !== -1 && c.innerHTML.indexOf("addressed") !== -1 &&
        c.innerHTML.indexOf("look-left") !== -1 && c.innerHTML.indexOf("char-eyes") !== -1 &&
        c.innerHTML.indexOf('data-from-idx="0"') !== -1;
    })());
  assert("character CSS has blinking eyes, head look, reaction, and sharp view rules, and no transition all",
    (function () {
      const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
      return css.indexOf(".char-eyes") !== -1 && css.indexOf(".stage-seat.look-left .char-head") !== -1 &&
        css.indexOf(".thumb-wrap.react-nod") !== -1 && css.indexOf(".tx-expand") !== -1 &&
        css.indexOf("transition: all") === -1;
    })());
  assert("page has counters, form errors, collapsed explanation, and a div stepper holder",
    (function () {
      const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
      return html.indexOf('id="count-title"') !== -1 && html.indexOf('id="count-context"') !== -1 &&
        html.indexOf('id="form-errors"') !== -1 && html.indexOf("How a debate works") !== -1 &&
        html.indexOf('<div id="stepper">') !== -1;
    })());
  assert("voice is off by default", BR.VOICE_ENABLED_DEFAULT === false);
  assert("stage CSS has mouth, lean, and voice toggle rules",
    (function () {
      const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
      return css.indexOf(".char-mouth") !== -1 && css.indexOf(".char-figure.char-mouth-open") !== -1 &&
        css.indexOf(".stage-seat.playing-lean") !== -1 &&
        css.indexOf(".stage-seat.lean-toward") !== -1 && css.indexOf(".stage-round") !== -1 &&
        css.indexOf(".round-table") !== -1 && css.indexOf(".voice-toggle-label") !== -1 && css.indexOf("prefers-reduced-motion") !== -1;
    })());
  assert("page has a voice toggle, off by default, and no key input",
    (function () {
      const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
      return html.indexOf('id="voice-toggle"') !== -1 && html.indexOf('id="voice-toggle" checked') === -1 &&
        html.toLowerCase().indexOf("api key") !== -1 && html.indexOf('type="password"') === -1 &&
        html.indexOf("d-api-key") === -1;
    })());
  assert("page has a resume panel with resume and discard controls",
    (function () {
      const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
      return html.indexOf('id="resume-panel"') !== -1 && html.indexOf('id="resume-debate"') !== -1 &&
        html.indexOf('id="resume-discard"') !== -1;
    })());

  /* ---------- Room rules, distinct brains, honesty labels, hard constraints ---------- */
  assert("room rules reach every live system prompt",
    (function () {
      var rules = BR.ROOM_RULES || "";
      if (rules.indexOf("never invent facts") === -1 || rules.indexOf("roast weak ideas plainly") === -1) { return false; }
      var slicesOk = BR.PERSONAS.every(function (p) {
        return ["opening", "debate", "discussion", "final", "consult"].every(function (s) {
          return BR.slicePrompt(p, s, BR.PERSONAS[1]).indexOf(rules) !== -1;
        });
      });
      var personaOk = BR.PERSONAS.every(function (p) { return BR.buildPersonaPrompt(p).indexOf(rules) !== -1; });
      var customOk = BR.buildCustomPrompt(BR.buildCustomPersona("Test", "View.")).indexOf(rules) !== -1;
      return slicesOk && personaOk && customOk &&
        BR.directorSystem.indexOf(rules) !== -1 && BR.consultSystem.indexOf(rules) !== -1;
    })());
  assert("room rules demand a trade-off, a counter to the own lens, same-sentence assumption labels, and unknown stated as unknown",
    BR.ROOM_RULES.indexOf("trade-off") !== -1 &&
    BR.ROOM_RULES.indexOf("counter to your own lens") !== -1 &&
    BR.ROOM_RULES.indexOf("as an assumption in the same sentence") !== -1 &&
    BR.ROOM_RULES.indexOf("say unknown") !== -1,
    BR.ROOM_RULES);
  assert("page loads the brain module and carries the exact footer credit and simulation labels",
    (function () {
      const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
      return html.indexOf('<script src="js/brains.js"></script>') !== -1 &&
        html.indexOf("Inspired by Nate Herk's Roast Room (open-source); built independently, not affiliated with Nate Herk.") !== -1 &&
        html.indexOf("AI simulation") !== -1;
    })());
  assert("council is exactly 8 seats with distinct voices, distinct lenses, and full disagreement coverage",
    (function () {
      if (BR.PERSONAS.length !== 8) { return false; }
      function distinct(values) {
        var seen = {};
        for (var i = 0; i < values.length; i++) {
          if (!values[i] || seen[values[i]]) { return false; }
          seen[values[i]] = true;
        }
        return true;
      }
      if (!distinct(BR.PERSONAS.map(function (p) { return p.voice; }))) { return false; }
      if (!distinct(BR.PERSONAS.map(function (p) { return BR.BRAIN_SLICES[p.id] && BR.BRAIN_SLICES[p.id].hot; }))) { return false; }
      return BR.PERSONAS.every(function (p) {
        var slice = BR.BRAIN_SLICES[p.id];
        if (!slice || !slice.disagreements) { return false; }
        return BR.PERSONAS.every(function (q) {
          return q.id === p.id || (typeof slice.disagreements[q.id] === "string" && slice.disagreements[q.id].length > 0);
        });
      });
    })());
  assert("slice prompts differ between seats on every step, so no two seats sound the same",
    (function () {
      var steps = ["opening", "debate", "discussion", "final", "consult"];
      return steps.every(function (s) {
        var seen = {};
        return BR.PERSONAS.every(function (p) {
          var text = BR.slicePrompt(p, s, BR.PERSONAS[1]);
          if (seen[text]) { return false; }
          seen[text] = true;
          return true;
        });
      });
    })());
  assert("stance labels that grossly contradict their top score are corrected to the score-derived stance",
    (function () {
      var yes = BR.validateOpening({ stance: "Strong yes", optionScores: { A: 4, B: 3, C: 2 }, pillarScore: 5, confidence: 4, ruinRisk: "none", door: "two-way", reason: "R.", changeMind: "N." }, ["A", "B", "C"]);
      var no = BR.validateOpening({ stance: "Strong no", optionScores: { A: 8, B: 6, C: 3 }, pillarScore: 5, confidence: 4, ruinRisk: "none", door: "two-way", reason: "R.", changeMind: "N." }, ["A", "B", "C"]);
      var mild = BR.validateOpening({ stance: "Yes, if", optionScores: { A: 6, B: 5, C: 3 }, pillarScore: 5, confidence: 4, ruinRisk: "none", door: "two-way", reason: "R.", changeMind: "N." }, ["A", "B", "C"]);
      return yes && yes.stance !== "Strong yes" && no && no.stance !== "Strong no" && mild && mild.stance === "Yes, if";
    })());
  assert("palette, edge seat cards, and grid card rules are present in CSS",
    (function () {
      const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
      return css.indexOf("#0f1419") !== -1 && css.indexOf("#171e26") !== -1 && css.indexOf("#e8a33d") !== -1 &&
        css.indexOf(".stage-seat.card-left .seat-card") !== -1 && css.indexOf(".stage-seat.card-right .seat-card") !== -1 &&
        css.indexOf("@media (max-width: 700px)") !== -1;
    })());
  assert("rendered stage marks edge seats for inner-edge cards",
    (function () {
      var s = makeDebate(1);
      var c = { innerHTML: "" };
      BR.renderStage(c, s, null, null);
      return c.innerHTML.indexOf("card-left") !== -1 && c.innerHTML.indexOf("card-right") !== -1;
    })());
  assert("no em dashes anywhere in the shipped app files",
    (function () {
      var files = ["index.html", "styles.css", "js/personas.js", "js/providers.js", "js/brains.js", "js/engine.js", "js/ui.js", "js/main.js", "api/chat.js", "README.md"];
      return files.every(function (f) {
        return fs.readFileSync(path.join(root, f), "utf8").indexOf("\u2014") === -1;
      });
    })());
  assert("every CSS class is used by the page or the renderers, so no dead rules ship",
    (function () {
      var css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
      var html = fs.readFileSync(path.join(root, "index.html"), "utf8");
      var js = ["js/personas.js", "js/providers.js", "js/brains.js", "js/engine.js", "js/ui.js", "js/main.js"]
        .map(function (f) { return fs.readFileSync(path.join(root, f), "utf8"); }).join("\n");
      var hay = html + "\n" + js;
      var classes = {};
      css.replace(/\.([A-Za-z][A-Za-z0-9_-]*)/g, function (m, name) { classes[name] = true; return m; });
      /* Classes built dynamically in JS: state-<state>, react-<nod|shake>,
         look-<left|right>. Everything else must appear literally. */
      var unused = Object.keys(classes).filter(function (name) {
        if (name.indexOf("state-") === 0 || name.indexOf("react-") === 0 || name.indexOf("look-") === 0) { return false; }
        var re = new RegExp("(^|[\\s\"'`])" + name.replace(/-/g, "\\-") + "(?![-\\w])");
        return !re.test(hay);
      });
      return unused.length === 0;
    })());
  assert("body text, muted text, and white-on-badge pairs meet WCAG AA contrast",
    (function () {
      function lum(hex) {
        var r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
        function f(c) { return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      }
      function ratio(fg, bg) {
        var l1 = lum(fg), l2 = lum(bg);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      }
      var pairs = [["#e8ecf1", "#0f1419"], ["#e8ecf1", "#171e26"], ["#9aa7b4", "#171e26"], ["#14100a", "#e8a33d"]];
      var css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
      var badgeRe = /\.vote-badge\.([A-Za-z-]+)\s*\{[^}]*background:\s*(#[0-9a-f]{6})/g;
      var badgeMatch = badgeRe.exec(css);
      while (badgeMatch) {
        pairs.push(["#ffffff", badgeMatch[2]]);
        badgeMatch = badgeRe.exec(css);
      }
      return pairs.every(function (p) { return ratio(p[0], p[1]) >= 4.5; });
    })());

  /* ---------- Key points verdict branch shows the final vote ---------- */
  assert("key points verdict branch shows final vote and score, not the debate stance",
    (function () {
      const kp = makeDebate(1);
      kp.director = { weights: {}, cruxes: [], brief: "B.", assumptions: [] };
      BR.PERSONAS.forEach(function (p) { kp.director.weights[p.id] = { weight: 1, reason: "R." }; });
      kp.debateRounds = [{ round: 1, cards: {} }];
      BR.PERSONAS.forEach(function (p) {
        kp.debateRounds[0].cards[p.id] = { stance: "Strong no", recommendedId: "A", optionScores: { A: 2, B: 8, C: 3 }, pillarScore: 5, confidence: 4, ruinRisk: "none", door: "two-way", reason: "R.", changeMind: "N." };
      });
      kp.final = {};
      BR.PERSONAS.forEach(function (p) { kp.final[p.id] = { vote: "Endorse with amendment", finalScore: 8, line: "L." }; });
      kp.verdict = { pillarScores: {} };
      BR.PERSONAS.forEach(function (p) { kp.verdict.pillarScores[p.id] = 5; });
      const c = { innerHTML: "" };
      BR.renderKeyPoints(c, kp);
      return c.innerHTML.indexOf("Endorse with amendment (8/10)") !== -1 && c.innerHTML.indexOf("Strong no") === -1;
    })());
  assert("key points verdict branch falls back to the latest stance only with no final vote",
    (function () {
      const kp = makeDebate(1);
      kp.director = { weights: {}, cruxes: [], brief: "B.", assumptions: [] };
      BR.PERSONAS.forEach(function (p) { kp.director.weights[p.id] = { weight: 1, reason: "R." }; });
      kp.debateRounds = [{ round: 1, cards: {} }];
      BR.PERSONAS.forEach(function (p) {
        kp.debateRounds[0].cards[p.id] = { stance: "Strong no", recommendedId: "A", optionScores: { A: 2, B: 8, C: 3 }, pillarScore: 5, confidence: 4, ruinRisk: "none", door: "two-way", reason: "R.", changeMind: "N." };
      });
      kp.final = {};
      kp.verdict = { pillarScores: {} };
      BR.PERSONAS.forEach(function (p) { kp.verdict.pillarScores[p.id] = 5; });
      const c = { innerHTML: "" };
      BR.renderKeyPoints(c, kp);
      return c.innerHTML.indexOf("Strong no") !== -1;
    })());

  /* ---------- Empty fallback reply reads plainly ---------- */
  await (async function () {
    const oldFetch = sandbox.fetch;
    sandbox.fetch = async function () {
      return { ok: true, status: 200, json: async function () { return { ok: false, status: 200, body: "", fallbackExhausted: true, fallbackStatus: 200, fallbackBody: "" }; } };
    };
    try {
      const res = await BR.callLLM("groq", "openai/gpt-oss-120b", "sys", "usr");
      assert("empty fallback reply says the fallback returned no usable reply",
        !res.ok && res.error && res.error.message.indexOf("fallback returned no usable reply") !== -1,
        JSON.stringify(res));
    } finally {
      if (oldFetch === undefined) { delete sandbox.fetch; } else { sandbox.fetch = oldFetch; }
    }
  })();

  /* ---------- Live reactive character states (30 Oct rebuild) ---------- */
  assert("character state machine gives exactly one state per seat, thinking during a wait",
    (function () {
      const states = BR.charStatesFor(BR.PERSONAS, "offer", null);
      const ids = Object.keys(states);
      return ids.length === BR.PERSONAS.length && states.offer === "thinking" &&
        BR.PERSONAS.every(function (p) { return BR.CHAR_STATES.indexOf(states[p.id]) !== -1; }) &&
        BR.PERSONAS.filter(function (p) { return p.id !== "offer"; }).every(function (p) { return states[p.id] === "listening"; });
    })());
  assert("character state machine switches thinking to speaking when the line lands",
    (function () {
      const states = BR.charStatesFor(BR.PERSONAS, null, "offer");
      const idle = BR.charStatesFor(BR.PERSONAS, null, null);
      return states.offer === "speaking" && BR.charStateFor({ offer: "reacting" }, "offer") === "reacting" &&
        BR.charStateFor({ offer: "not-a-state" }, "offer") === "idle" &&
        BR.PERSONAS.every(function (p) { return idle[p.id] === "idle"; });
    })());
  assert("character figures exist for all 8 seats, each distinct, as full bodies with legs, torso, two arms, head, eyes, and mouth",
    (function () {
      const known = ["operator", "offer", "investor", "marketer", "philosopher", "founder", "saas", "eos"];
      const seen = {};
      const ok = known.every(function (id) {
        const fig = BR.characterFigure({ id: id, color: "#111111", initials: "X" }, "large");
        if (seen[fig]) { return false; }
        seen[fig] = true;
        return fig.indexOf("char-figure large") !== -1 && fig.indexOf("char-svg") !== -1 &&
          fig.indexOf('viewBox="0 0 120 200"') !== -1 &&
          fig.indexOf("char-legs") !== -1 && fig.indexOf("char-torso") !== -1 &&
          fig.indexOf("char-arm") !== -1 && fig.indexOf("char-arm-g") !== -1 &&
          fig.indexOf("char-head") !== -1 && fig.indexOf("char-eyes") !== -1 &&
          fig.indexOf("char-mouth") !== -1 && fig.indexOf("--blink-delay:") !== -1;
      });
      const custom = BR.characterFigure({ id: "custom", color: "#111111", initials: "C" }, "large");
      return ok && custom.indexOf("char-initials") !== -1 && custom.indexOf("char-mouth") === -1;
    })());
  assert("stage seats render full-body figures with a gesture arm",
    (function () {
      const s = makeDebate(1);
      s.director = { weights: {}, cruxes: [], brief: "B.", assumptions: [] };
      BR.PERSONAS.forEach(function (p) { s.director.weights[p.id] = { weight: 1, reason: "R." }; });
      s.final = {};
      const c = { innerHTML: "" };
      BR.renderStage(c, s, null, null, BR.charStatesFor(BR.PERSONAS, null, null));
      return c.innerHTML.indexOf('viewBox="0 0 120 200"') !== -1 &&
        c.innerHTML.indexOf("char-arm-g") !== -1 && c.innerHTML.indexOf("char-torso") !== -1;
    })());
  assert("character mouth driver maps word states to figure classes and resets cleanly",
    (function () {
      const fig = { classList: { list: [], add: function (c) { if (this.list.indexOf(c) === -1) { this.list.push(c); } }, remove: function () { var args = Array.prototype.slice.call(arguments); var self = this; args.forEach(function (c) { var i = self.list.indexOf(c); if (i !== -1) { self.list.splice(i, 1); } }); } }, querySelector: function () { return null; } };
      BR.charMouth(fig, "mouth-open");
      const opened = fig.classList.list.indexOf("char-mouth-open") !== -1;
      BR.charMouth(fig, "mouth-mid");
      const moved = fig.classList.list.indexOf("char-mouth-open") === -1 && fig.classList.list.indexOf("char-mouth-mid") !== -1;
      BR.charMouth(fig, null);
      const cleared = fig.classList.list.length === 0;
      return opened && moved && cleared && typeof BR.charGesture === "function";
    })());
  assert("character blink delays are deterministic per seat and inside one blink cycle",
    (function () {
      return BR.PERSONAS.every(function (p) {
        var d = BR.blinkDelayFor(p.id);
        return d === BR.blinkDelayFor(p.id) && d >= 0 && d < 4.6;
      });
    })());
  assert("thinking stage renders a think bubble, a Thinking label, and a ponder state, never a speaking seat",
    (function () {
      const s = makeDebate(1);
      s.director = { weights: {}, cruxes: [], brief: "B.", assumptions: [] };
      BR.PERSONAS.forEach(function (p) { s.director.weights[p.id] = { weight: 1, reason: "R." }; });
      s.final = {};
      const c = { innerHTML: "" };
      BR.renderStage(c, s, null, null, BR.charStatesFor(BR.PERSONAS, "offer", null));
      return c.innerHTML.indexOf("state-thinking") !== -1 && c.innerHTML.indexOf("think-bubble") !== -1 &&
        c.innerHTML.indexOf(">Thinking<") !== -1 && c.innerHTML.indexOf("speaking") === -1 &&
        c.innerHTML.indexOf("round-arrow-line") === -1;
    })());
  assert("interaction arc is drawn on answer and rebuttal lines and removed when no line is live",
    (function () {
      const s = makeDebate(1);
      s.director = { weights: {}, cruxes: [], brief: "B.", assumptions: [] };
      BR.PERSONAS.forEach(function (p) { s.director.weights[p.id] = { weight: 1, reason: "R." }; });
      s.final = {};
      const c = { innerHTML: "" };
      BR.renderStage(c, s, "operator", { from: BR.PERSONAS[0], to: BR.PERSONAS[1], kind: "discussion" },
        BR.charStatesFor(BR.PERSONAS, null, "operator"));
      const d = BR.arcPathFor(0, 1, 8, 800, 560);
      const c2 = { innerHTML: "" };
      BR.renderStage(c2, s, null, { from: BR.PERSONAS[0], to: BR.PERSONAS[1], kind: "discussion" },
        BR.charStatesFor(BR.PERSONAS, null, null));
      return c.innerHTML.indexOf("round-arrow-line") !== -1 && c.innerHTML.indexOf("<path") !== -1 &&
        c.innerHTML.indexOf("state-speaking") !== -1 && c.innerHTML.indexOf("addressed") !== -1 &&
        !!d && d.indexOf("M ") === 0 && d.indexOf(" Q ") !== -1 && BR.arcPathFor(0, 0, 8, 800, 560) === null &&
        c2.innerHTML.indexOf("round-arrow-line") === -1;
    })());
  assert("reduced motion shuts down every new character animation in CSS",
    (function () {
      const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
      const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
      return block.indexOf(".stage-seat.playing") !== -1 && block.indexOf(".char-figure.talking") !== -1 &&
        block.indexOf(".char-head") !== -1 && block.indexOf(".char-eyes") !== -1 &&
        block.indexOf(".char-mouth") !== -1 && block.indexOf(".char-arm") !== -1 &&
        block.indexOf(".stage-seat.state-thinking") !== -1 && block.indexOf(".round-arrow-line") !== -1 &&
        block.indexOf("think-bubble") !== -1;
    })());
  assert("speaking lift and stage clearance stay bounded: no layout size animation, 120px desktop margin kept",
    (function () {
      const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
      const speak = css.slice(css.indexOf(".stage-seat.speaking"), css.indexOf(".stage-seat.speaking") + 600);
      return css.indexOf("margin: 12px 0 120px") !== -1 && speak.indexOf("translateY(-22px)") !== -1 &&
        speak.indexOf("width:") === -1 && speak.indexOf("height:") === -1 && speak.indexOf("font-size:") === -1;
    })());
  assert("character CSS has no duplicate animation rules for the new states",
    (function () {
      const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
      const count = function (name) { return (css.match(new RegExp(name, "g")) || []).length; };
      return count("stage\\.spotlight \\.stage-seat\\.dim") === 0 && count("\\.rebuttal-arrow") === 0 &&
        count("\\.tx-rebuts \\{") === 1;
    })());

  /* ---------- Refiner fixes: awaited playback, live-pair gating, thinking spotlight ---------- */
  await (async function () {
    const s = makeDebate(1);
    const seen = [];
    let flag = false;
    s.onStepDone = function () {
      return new Promise(function (res) { setTimeout(function () { flag = true; res(); }, 5); });
    };
    const canned = makeCanned({});
    const wrapped = function (state, step) { seen.push(flag); return canned.fn(state, step); };
    const res = await BR.runDebate(s, wrapped, function () {});
    assert("debate loop awaits the step-done handler before the next step starts",
      res.ok && seen.length > 2 && seen.slice(1).every(function (v) { return v === true; }),
      "seen=" + JSON.stringify(seen.slice(0, 5)));
  })();
  assert("arc, addressed highlight, and strip show only for the live speaker's own pair",
    (function () {
      const s = makeDebate(1);
      s.director = { weights: {}, cruxes: [], brief: "B.", assumptions: [] };
      BR.PERSONAS.forEach(function (p) { s.director.weights[p.id] = { weight: 1, reason: "R." }; });
      s.final = {};
      const stale = { innerHTML: "" };
      BR.renderStage(stale, s, "offer", { from: BR.PERSONAS[0], to: BR.PERSONAS[1], kind: "argument" },
        BR.charStatesFor(BR.PERSONAS, null, "offer"));
      const live = { innerHTML: "" };
      BR.renderStage(live, s, "operator", { from: BR.PERSONAS[0], to: BR.PERSONAS[1], kind: "argument" },
        BR.charStatesFor(BR.PERSONAS, null, "operator"));
      return stale.innerHTML.indexOf("round-arrow-line") === -1 && stale.innerHTML.indexOf("addressed") === -1 &&
        stale.innerHTML.indexOf("rebuttal-strip") === -1 && live.innerHTML.indexOf("round-arrow-line") !== -1 &&
        live.innerHTML.indexOf("rebuttal-strip") !== -1;
    })());
  assert("thinking spotlights the room and dims listeners, not just the speaking phase",
    (function () {
      const s = makeDebate(1);
      s.director = { weights: {}, cruxes: [], brief: "B.", assumptions: [] };
      BR.PERSONAS.forEach(function (p) { s.director.weights[p.id] = { weight: 1, reason: "R." }; });
      s.final = {};
      const c = { innerHTML: "" };
      BR.renderStage(c, s, null, null, BR.charStatesFor(BR.PERSONAS, "offer", null));
      return c.innerHTML.indexOf("spotlight") !== -1 && c.innerHTML.indexOf("state-thinking") !== -1 &&
        c.innerHTML.indexOf(" dim") !== -1;
    })());
  assert("director and draft waits render a Director working row instead of an idle room",
    (function () {
      const s = makeDebate(1);
      s.transcript = [{ kind: "director", speaker: "Director", title: "Director brief", body: "B." }];
      const c = { innerHTML: "" };
      BR.renderTranscript(c, s, null, "The Director");
      return c.innerHTML.indexOf("The Director") !== -1 && c.innerHTML.indexOf("is thinking") !== -1;
    })());

  /* ---------- Overnight rebuild: readable motion, type system, backend hardening ---------- */
  assert("readable motion amplitudes beat the old small motions",
    (function () {
      const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
      const has = function (s) { return css.indexOf(s) !== -1; };
      return has("translateY(-22px)") && has("rotate(8deg)") && has("rotate(9deg)") &&
        has("translateX(3px)") && has("rotate(14deg)") &&
        has("translateY(8px)") && has("translateX(10px)") && has("rotate(10deg)") &&
        has("scaleY(1)") && has("scaleY(0.6)") &&
        has("width: 10px") && has("stroke-dasharray: 10 6") &&
        has(".stage-seat.state-thinking {") && has("gap: 48px 12px");
    })());
  assert("thinking seat carries a visible amber ring in CSS",
    (function () {
      const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
      const start = css.indexOf(".stage-seat.state-thinking {");
      const block = css.slice(start, start + 200);
      return start !== -1 && block.indexOf("border-color: #e8a33d") !== -1 && block.indexOf("box-shadow") !== -1;
    })());
  assert("arc stroke is 3px in the rendered SVG and in the pixel repositioning",
    (function () {
      const s = makeDebate(1);
      s.director = { weights: {}, cruxes: [], brief: "B.", assumptions: [] };
      BR.PERSONAS.forEach(function (p) { s.director.weights[p.id] = { weight: 1, reason: "R." }; });
      s.final = {};
      const c = { innerHTML: "" };
      BR.renderStage(c, s, "operator", { from: BR.PERSONAS[0], to: BR.PERSONAS[1], kind: "discussion" },
        BR.charStatesFor(BR.PERSONAS, null, "operator"));
      const mainCode = fs.readFileSync(path.join(root, "js/main.js"), "utf8");
      return c.innerHTML.indexOf('stroke-width="3"') !== -1 &&
        mainCode.indexOf('setAttribute("stroke-width", "3")') !== -1;
    })());
  assert("lean toward the target is 20px, not the old 14px",
    (function () {
      const v = BR.leanVectorFor(0, 1, 8);
      const len = Math.sqrt(v.dx * v.dx + v.dy * v.dy);
      return !!v && len >= 19 && len <= 21;
    })());
  assert("typography system is one heading stack, one body stack, 16px body",
    (function () {
      const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
      return css.indexOf("--font-head") !== -1 && css.indexOf("--font-body") !== -1 &&
        css.indexOf("line-height: 1.6") !== -1 && css.indexOf("h2 { font-size: 24px") !== -1 &&
        css.indexOf(".tx-body { font-size: 16px") !== -1;
    })());
  assert("server rate bucket fails open at the 5000 entry cap",
    (function () {
      const loaded = loadServer({ GROQ_API_KEY: FAKE_GROQ_KEY }, scriptFor([]));
      const fn = loaded.handler._rateLimitedForTest;
      if (typeof fn !== "function") { return false; }
      for (let i = 0; i < 5000; i += 1) { fn("10.9." + (i >> 8) + "." + (i & 255)); }
      let limited = false;
      for (let i = 0; i < 121; i += 1) { limited = fn("10.9.0.0"); }
      const capped = fn("10.8.0.1");
      return limited === true && capped === false;
    })());
  await (async function () {
    const prevFetch = sandbox.fetch;
    const prevAbort = sandbox.AbortController;
    const prevSetTimeout = sandbox.setTimeout;
    const prevClearTimeout = sandbox.clearTimeout;
    sandbox.AbortController = AbortController;
    sandbox.setTimeout = setTimeout;
    sandbox.clearTimeout = clearTimeout;
    sandbox.fetch = async function () {
      return { ok: true, status: 200, json: async function () { throw new Error("bad json"); } };
    };
    const bad = await BR.callLLM("groq", "openai/gpt-oss-120b", "sys", "usr");
    sandbox.fetch = async function () {
      return { ok: true, status: 200, json: async function () { return { ok: true, text: "hello", servedBy: { provider: "groq", model: "openai/gpt-oss-120b" } }; } };
    };
    const good = await BR.callLLM("groq", "openai/gpt-oss-120b", "sys", "usr");
    sandbox.fetch = prevFetch;
    sandbox.AbortController = prevAbort;
    sandbox.setTimeout = prevSetTimeout;
    sandbox.clearTimeout = prevClearTimeout;
    assert("client: non-JSON server reply is a plain bad response, not a network error",
      bad.ok === false && bad.error && bad.error.code === "bad_response", JSON.stringify(bad));
    assert("client: JSON server reply still parses after the parse-guard change",
      good.ok === true && good.text === "hello" && good.servedBy.provider === "groq", JSON.stringify(good));
  })();

  /* ---------- Live-test fixes: key points cards, glass, GSAP, widths ---------- */
  assert("key points verdict renders stacked cards, never a table, with every line in full",
    (function () {
      var s = makeDebate(1);
      s.director = { weights: {}, cruxes: [], brief: "B.", assumptions: [] };
      s.final = {};
      s.verdict = { pillarScores: {} };
      var longLine = "The full final line must print word for word with nothing cut off, even when it runs long across the whole card width.";
      BR.PERSONAS.forEach(function (p) {
        s.director.weights[p.id] = { weight: 2, reason: "R." };
        s.final[p.id] = { vote: "Endorse", finalScore: 8, line: longLine };
        s.verdict.pillarScores[p.id] = 7;
      });
      var c = { innerHTML: "" };
      BR.renderKeyPoints(c, s);
      var cards = (c.innerHTML.match(/class="kp-item"/g) || []).length;
      return c.innerHTML.indexOf("<table") === -1 && cards === BR.PERSONAS.length &&
        c.innerHTML.indexOf(longLine) !== -1 && c.innerHTML.indexOf("Weight 2 / 3") !== -1 &&
        c.innerHTML.indexOf("Pillar 7/10") !== -1 && c.innerHTML.indexOf("Endorse (8/10)") !== -1;
    })());
  assert("verdict sheet and fault lines carry no tables: seat lines hold vote, weight, and pillar, weights fold into the sheet",
    (function () {
      const s = makeDebate(1);
      s.director = { weights: {}, cruxes: [{ question: "Q?", sides: [] }], brief: "B.", assumptions: [] };
      BR.PERSONAS.forEach(function (p) { s.director.weights[p.id] = { weight: 2, reason: "R." }; });
      s.final = {};
      BR.PERSONAS.forEach(function (p) { s.final[p.id] = { vote: "Endorse", finalScore: 8, line: "L." }; });
      const c1 = { innerHTML: "" };
      BR.renderCruxes(c1, s);
      const cruxOk = c1.innerHTML.indexOf("<table") === -1 && c1.innerHTML.indexOf("Chair weights:") !== -1 &&
        c1.innerHTML.indexOf("Operator 2") !== -1;
      const v = makeDebate(1);
      v.director = { weights: {}, cruxes: [], brief: "B.", assumptions: [] };
      v.final = {};
      BR.PERSONAS.forEach(function (p) {
        v.director.weights[p.id] = { weight: 2, reason: "R." };
        v.final[p.id] = { vote: "Endorse", finalScore: 8, line: "L." };
      });
      v.verdict = {
        label: "GO", recommendedId: "A", recommendedScore: 7,
        optionScores: { A: { score: 7, math: "A math" }, B: { score: 5, math: "B math" }, C: { score: 3, math: "C math" } },
        support: 7, confidence: 8, spread: 2, votes: { endorse: 8, amend: 0, dissent: 0 },
        topReasons: [{ short: "Operator", pillarScore: 8, reason: "Top reason." }],
        pillarScores: {}, pillarFixes: [], overrides: [], minority: null,
        amendments: [], dissentList: [], preferredOtherwise: []
      };
      BR.PERSONAS.forEach(function (p) { v.verdict.pillarScores[p.id] = 7; });
      v.draft = null;
      const c2 = { innerHTML: "" };
      BR.renderVerdict(c2, v);
      const verdictOk = c2.innerHTML.indexOf("<table") === -1 &&
        c2.innerHTML.indexOf("Why it won") !== -1 && c2.innerHTML.indexOf("Every seat, one line") !== -1 &&
        c2.innerHTML.indexOf("Weight 2") !== -1 && c2.innerHTML.indexOf("Pillar 7/10") !== -1 &&
        c2.innerHTML.indexOf("option-bars") > c2.innerHTML.indexOf("<details");
      const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
      const cssOk = css.indexOf(".weights-table") === -1 && css.indexOf(".score-table") === -1 &&
        css.indexOf(".table-scroll") === -1 && css.indexOf(".verdict-seat {") !== -1;
      return cruxOk && verdictOk && cssOk;
    })());
  assert("glass panels use translucent backgrounds with blur and keep AA contrast over the blend",
    (function () {
      const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
      function lum(rgb) {
        function f(c) { c = c / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
        return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
      }
      function ratio(fg, bg) {
        var l1 = lum(fg), l2 = lum(bg);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      }
      /* Glass rgba(23,30,38,0.72) over canvas #0f1419 blends to
         about rgb(21,27,34); body and muted text must still pass AA. */
      var a = 0.72;
      var blend = [Math.round(a * 23 + (1 - a) * 15), Math.round(a * 30 + (1 - a) * 20), Math.round(a * 38 + (1 - a) * 25)];
      return css.indexOf("--glass-bg: rgba(23, 30, 38, 0.72)") !== -1 &&
        css.indexOf(".panel {") !== -1 && css.indexOf("backdrop-filter: blur(14px)") !== -1 &&
        css.indexOf(".tx-entry {") !== -1 && css.indexOf(".kp-item {") !== -1 &&
        ratio([232, 236, 241], blend) >= 4.5 && ratio([154, 167, 180], blend) >= 4.5;
    })());
  assert("GSAP loads from CDN and main.js only enables GSAP motion when it exists",
    (function () {
      const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
      const main = fs.readFileSync(path.join(root, "js/main.js"), "utf8");
      return html.indexOf("cdnjs.cloudflare.com/ajax/libs/gsap/") !== -1 &&
        main.indexOf('document.body.classList.add("gsap-on")') !== -1 &&
        main.indexOf("window.gsap") !== -1 &&
        main.indexOf("BR.charGesture") !== -1;
    })());
  assert("layout audit: no panel overflows the viewport at desktop, tablet, phone, or narrow widths",
    (function () {
      const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
      if (css.indexOf(".room-layout {") === -1 || css.indexOf("grid-template-columns: minmax(0, 1fr) 340px") === -1) { return false; }
      if (css.indexOf("@media (max-width: 850px)") === -1 || css.indexOf("@media (max-width: 700px)") === -1) { return false; }
      /* Aside is 340px beside the stage above 850px, stacked below
         it at or below 850px. Stage content width is the viewport
         minus main padding (20px each side), capped at 1080px. */
      var viewports = [1440, 1080, 900, 851, 850, 700, 600, 390, 360];
      for (var i = 0; i < viewports.length; i++) {
        var vp = viewports[i];
        var content = Math.min(vp - 40, 1080);
        var stage = vp > 850 ? content - 340 - 20 : content;
        if (stage <= 0) { return false; }
        if (vp > 850 && 340 > content) { return false; }
        /* Round layout above 700px: the centre table is at most
           420px and at most 48 percent of the stage, so it always
           fits inside the stage. Grid layout at or below 700px:
           two columns with a 12px gap, seat cards static at full
           width, so nothing can escape the viewport edge. */
        if (vp > 700) {
          var table = Math.min(0.48 * stage, 420);
          if (table > stage) { return false; }
        } else {
          if (css.indexOf(".stage-seat .seat-card, .stage-seat.card-below .seat-card") === -1) { return false; }
        }
        /* Form grid: 220px minimum column, so at the narrowest
           viewport (360px, 320px content) it collapses to one
           column instead of squeezing. */
        if (content < 220) { return false; }
      }
      /* Key points cards and transcript entries are full-width flex
         rows with a shrinkable content column, so their text wraps
         instead of overflowing. */
      return css.indexOf(".kp-content { min-width: 0; flex: 1; }") !== -1 &&
        css.indexOf(".kp-item {") !== -1 && css.indexOf(".tx-entry {") !== -1;
    })());

  /* ---------- Sharp output and prompt caps (round 3) ---------- */
  assert("sharp view leads with a headline, then at most two supporting sentences, rest behind a control",
    (function () {
      const a = BR.splitSharp("First sentence here. Second sentence here. Third sentence here. Fourth sentence here.", "");
      const b = BR.splitSharp("First sentence here. Second sentence here. Third sentence here.", "Model headline.");
      const c = BR.splitSharp("Only one line.", "");
      const d = BR.splitSharp("", "");
      return a.headline === "First sentence here." && a.excerpt === "Second sentence here. Third sentence here." &&
        a.rest === "Fourth sentence here." && a.hasMore === true &&
        b.headline === "Model headline." && b.excerpt.indexOf("First sentence") !== -1 && b.hasMore === true &&
        c.hasMore === false && c.excerpt === "" && d.headline === "" && d.hasMore === false;
    })());
  assert("long transcript entries render sharp by default with full text behind an expand control",
    (function () {
      const s = makeDebate(1);
      s.transcript = [{
        kind: "argument", speaker: "Operator", title: "Debate round 1",
        headline: "Price beats volume here.",
        body: "First sentence here. Second sentence here. Third sentence here. Fourth sentence here.",
        disagreeWith: "Offer", concede: "", stepKey: "debate:1:operator"
      }];
      s.servedBy = { "debate:1:operator": { provider: "groq", model: "gpt-oss-120b" } };
      const c = { innerHTML: "" };
      BR.renderTranscript(c, s, null);
      const fullIdx = c.innerHTML.indexOf('class="tx-full"');
      return c.innerHTML.indexOf("tx-sharp") !== -1 && c.innerHTML.indexOf("Price beats volume here.") !== -1 &&
        c.innerHTML.indexOf("tx-expand") !== -1 && c.innerHTML.indexOf("Show full text") !== -1 &&
        fullIdx !== -1 && c.innerHTML.indexOf("Fourth sentence here.") > fullIdx &&
        c.innerHTML.indexOf("provider-badge") > fullIdx &&
        c.innerHTML.indexOf("tx-head") < fullIdx &&
        c.innerHTML.split("provider-badge").length - 1 === 1;
    })());
  assert("short transcript entries render plainly with no expand control and no hidden block",
    (function () {
      const s = makeDebate(1);
      s.transcript = [{ kind: "vote", speaker: "Operator", title: "Opening vote", body: "Yes on option A. Short reason." }];
      s.servedBy = {};
      const c = { innerHTML: "" };
      BR.renderTranscript(c, s, null);
      return c.innerHTML.indexOf("tx-expand") === -1 && c.innerHTML.indexOf("tx-full") === -1 &&
        c.innerHTML.indexOf("Short reason.") !== -1;
    })());
  assert("discussion extras live inside the full text, never in the sharp view",
    (function () {
      const s = makeDebate(1);
      s.transcript = [{
        kind: "discussion", speaker: "Operator", title: "Discussion", body: "Reply.",
        answerTo: "Offer", agree: "disagree", pointAnswered: "P.",
        steelman: "Offer's point at its strongest, fairly stated.", weakPoint: "W.",
        concede: "I concede the timing point because the cash data beats my case.",
        costOfBeingWrong: "C.", evidenceDemanded: "E."
      }];
      const c = { innerHTML: "" };
      BR.renderTranscript(c, s, null);
      const fullIdx = c.innerHTML.indexOf('class="tx-full"');
      const sharpEnd = c.innerHTML.indexOf("tx-full");
      return fullIdx !== -1 && c.innerHTML.indexOf("Steelman:") > fullIdx &&
        c.innerHTML.indexOf("Show detail") !== -1 &&
        c.innerHTML.slice(0, sharpEnd).indexOf("Steelman:") === -1;
    })());
  assert("prompt caps are explicit: opening 60 words, debate and discussion 80, final line 25, brief 120, headline one line",
    (function () {
      const s = makeDebate(1);
      s.director = { weights: {}, cruxes: [], brief: "B.", assumptions: [] };
      const adv = BR.PERSONAS[0];
      const opening = BR.openingUser(s, adv, 2);
      const debate = BR.debateUser(s, adv, {}, 1);
      const discussion = BR.discussionUser(s, adv, BR.PERSONAS[1], null);
      const final = BR.finalUser(s, adv);
      const director = BR.directorUser(s);
      return opening.indexOf('"headline"') !== -1 && opening.indexOf("under 60 words") !== -1 &&
        debate.indexOf('"headline"') !== -1 && debate.indexOf("under 80 words") !== -1 &&
        discussion.indexOf('"headline"') !== -1 && discussion.indexOf("under 80 words") !== -1 &&
        final.indexOf("under 25 words") !== -1 && director.indexOf("under 120 words") !== -1 &&
        BR.ROOM_RULES.indexOf("one-line headline") !== -1 &&
        BR.ROOM_RULES.indexOf("Never repeat a seat") !== -1;
    })());
  assert("debate and discussion prompts demand a named trade-off, and the director brief names the riskiest assumption",
    (function () {
      const s = makeDebate(1);
      s.director = { weights: {}, cruxes: [], brief: "B.", assumptions: [] };
      const adv = BR.PERSONAS[0];
      const debate = BR.debateUser(s, adv, {}, 1);
      const discussion = BR.discussionUser(s, adv, BR.PERSONAS[1], null);
      const director = BR.directorUser(s);
      return debate.indexOf("trade-off") !== -1 && discussion.indexOf("trade-off") !== -1 &&
        director.indexOf("riskiest assumption") !== -1 && director.indexOf("ranked riskiest first") !== -1;
    })());
  assert("validators enforce the caps even when a model ignores them",
    (function () {
      const long = new Array(120).join("word ");
      const ids = ["A", "B", "C"];
      const debate = BR.validateDebate({ stance: "Yes", optionScores: { A: 8, B: 5, C: 3 }, rebuttal: long, reason: "R." }, ids);
      const discussion = BR.validateDiscussion({ answerTo: "Offer", agree: "disagree", pointAnswered: "P.", steelman: "A fair steelman of the point here.", weakPoint: "W.", reply: long, concede: "Nothing conceded: the attack fails because the premise holds.", costOfBeingWrong: "C.", evidenceDemanded: "E.", headline: long });
      const final = BR.validateFinal({ vote: "Endorse", finalScore: 8, line: long });
      const opening = BR.validateOpening({ stance: "Yes", optionScores: { A: 8, B: 5, C: 3 }, reason: "R.", headline: long }, ids);
      return debate && debate.rebuttal.length <= 500 &&
        discussion && discussion.reply.length <= 500 && discussion.headline.length <= 160 &&
        final && final.line.length <= 160 && opening && opening.headline.length <= 160;
    })());
  assert("key points cards stay to stance plus score, with no confidence, ruin, or door clutter",
    (function () {
      const kp = makeDebate(1);
      kp.director = { weights: {}, cruxes: [], brief: "B.", assumptions: [] };
      kp.debateRounds = [{ round: 1, cards: {} }];
      BR.PERSONAS.forEach(function (p) {
        kp.director.weights[p.id] = { weight: 1, reason: "R." };
        kp.debateRounds[0].cards[p.id] = { stance: "Yes", recommendedId: "A", optionScores: { A: 8, B: 5, C: 3 }, pillarScore: 7, confidence: 4, ruinRisk: "likely", door: "one-way", reason: "R.", changeMind: "N." };
      });
      kp.final = {};
      const c = { innerHTML: "" };
      BR.renderKeyPoints(c, kp);
      return c.innerHTML.indexOf("Confidence") === -1 && c.innerHTML.indexOf("Ruin:") === -1 &&
        c.innerHTML.indexOf("Door:") === -1 && c.innerHTML.indexOf("Option A: 8/10") !== -1;
    })());
  assert("verdict sheet order is verdict, reasons, seat lines, then full detail",
    (function () {
      const v = makeDebate(1);
      v.director = { weights: {}, cruxes: [], brief: "B.", assumptions: [] };
      v.final = {};
      BR.PERSONAS.forEach(function (p) {
        v.director.weights[p.id] = { weight: 2, reason: "R." };
        v.final[p.id] = { vote: "Endorse", finalScore: 8, line: "L." };
      });
      v.verdict = {
        label: "GO", recommendedId: "A", recommendedScore: 7,
        optionScores: { A: { score: 7, math: "A math" }, B: { score: 5, math: "B math" }, C: { score: 3, math: "C math" } },
        support: 7, confidence: 8, spread: 2, votes: { endorse: 8, amend: 0, dissent: 0 },
        topReasons: [{ short: "Operator", pillarScore: 8, reason: "Top reason." }],
        pillarScores: {}, pillarFixes: [], overrides: [], minority: null,
        amendments: [], dissentList: [], preferredOtherwise: []
      };
      BR.PERSONAS.forEach(function (p) { v.verdict.pillarScores[p.id] = 7; });
      v.draft = null;
      const c = { innerHTML: "" };
      BR.renderVerdict(c, v);
      const call = c.innerHTML.indexOf("verdict-call");
      const reasons = c.innerHTML.indexOf("Why it won");
      const seats = c.innerHTML.indexOf("Every seat, one line");
      const detail = c.innerHTML.indexOf("<details");
      return call !== -1 && reasons > call && seats > reasons && detail > seats;
    })());
  assert("main.js wires the transcript expand control and unhides full text during playback",
    (function () {
      const main = fs.readFileSync(path.join(root, "js/main.js"), "utf8");
      return main.indexOf('".tx-expand"') !== -1 && main.indexOf('".tx-full"') !== -1 &&
        main.indexOf("Hide full text") !== -1;
    })());
  assert("consult cap is 250 words in both the page text and the engine prompt",
    (function () {
      const main = fs.readFileSync(path.join(root, "js/main.js"), "utf8");
      const consult = BR.consultUser({ title: "T", context: "C", options: [], focus: "balanced" }, BR.PERSONAS[0]);
      return main.indexOf("under 400 words") === -1 && main.indexOf("under 250 words") !== -1 &&
        consult.indexOf("under 250 words") !== -1;
    })());

  /* ---------- Server function: OpenRouter fallback ---------- */
  await serverTests();

  console.log("\n" + passed + " passed, " + failed + " failed.");
  if (failed > 0) {
    console.log("Failed tests: " + failures.join(", "));
    process.exit(1);
  }
}

main().catch(function (err) {
  console.log("HARNESS CRASH: " + (err && err.stack ? err.stack : err));
  process.exit(1);
});
