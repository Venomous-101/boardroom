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
for (const file of ["js/personas.js", "js/providers.js", "js/engine.js"]) {
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
   fallback key behind it is capped at 25 seconds. */

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
  return mockResp(true, 200, { model: body.models[0], choices: [{ message: { content: "fallback text" } }] });
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
  const orCall = t1.calls.find(function (c) { return c.url.indexOf("openrouter.ai") !== -1; });
  assert("server: fallback sends the full free chain", !!orCall && eq(orCall.body.models, BR.OPENROUTER_FREE_CHAIN) && orCall.body.model === BR.OPENROUTER_FREE_CHAIN[0], JSON.stringify(orCall && orCall.body));
  assert("server: groq and openrouter auth use their own keys",
    t1.calls.length === 2 && t1.calls[0].auth === "Bearer " + FAKE_GROQ_KEY && orCall.auth === "Bearer " + FAKE_OR_KEY,
    JSON.stringify(t1.calls.map(function (c) { return c.auth; })));
  assert("server: fallback attempt caps are 25s each", eq(t1.timeouts, [25000, 25000]), JSON.stringify(t1.timeouts));

  /* All free fallbacks exhausted: primary failure reported, flagged. */
  const t2 = loadServer(bothKeys, scriptFor([
    { match: "api.groq.com", make: function () { return groqErr(429); } },
    { match: "openrouter.ai", make: function () { return orErr(429); } }
  ]));
  const r2 = await callServer(t2, base, "10.0.0.2");
  assert("server: all fallbacks exhausted reports primary failure flagged",
    r2.body.ok === false && r2.body.status === 429 && r2.body.fallbackExhausted === true, JSON.stringify(r2.body));

  /* Groq 401 fails fast even with a fallback key present. */
  const t3 = loadServer(bothKeys, scriptFor([
    { match: "api.groq.com", make: function () { return groqErr(401); } },
    { match: "openrouter.ai", make: orOk }
  ]));
  const r3 = await callServer(t3, base, "10.0.0.3");
  assert("server: groq 401 fails fast with no fallback",
    r3.body.ok === false && r3.body.status === 401 && !r3.body.fallbackExhausted && !r3.body.fallbackSkipped && t3.calls.length === 1,
    JSON.stringify(r3.body) + " calls=" + t3.calls.length);

  /* OpenRouter direct with a free model: requested model first, then the chain. */
  const t4 = loadServer(bothKeys, scriptFor([{ match: "openrouter.ai", make: orOk }]));
  const r4 = await callServer(t4, { provider: "openrouter", model: BR.OPENROUTER_FREE_CHAIN[2], system: "sys", user: "usr" }, "10.0.0.4");
  const expected4 = [BR.OPENROUTER_FREE_CHAIN[2], BR.OPENROUTER_FREE_CHAIN[0], BR.OPENROUTER_FREE_CHAIN[1], BR.OPENROUTER_FREE_CHAIN[3]];
  assert("server: openrouter direct free model goes first then the chain",
    r4.body.ok === true && eq(t4.calls[0].body.models, expected4) && r4.body.servedBy.model === BR.OPENROUTER_FREE_CHAIN[2],
    JSON.stringify(t4.calls[0] && t4.calls[0].body) + " " + JSON.stringify(r4.body.servedBy));
  /* Full-deadline caps are timing-dependent: the cap is min(55000, remaining time), so the recorded value is 55000 minus elapsed milliseconds. Assert the property (full deadline, not the 25s fallback cap), not the exact millisecond. */
  assert("server: openrouter direct single attempt keeps the full deadline", t4.timeouts.length === 1 && t4.timeouts[0] > 25000 && t4.timeouts[0] <= 55000, JSON.stringify(t4.timeouts));

  /* OpenRouter direct with a paid model: sent alone, never chained. */
  const t5 = loadServer(bothKeys, scriptFor([{ match: "openrouter.ai", make: orOk }]));
  const r5 = await callServer(t5, { provider: "openrouter", model: "anthropic/claude-sonnet-5", system: "sys", user: "usr" }, "10.0.0.5");
  assert("server: openrouter direct paid model stays alone",
    r5.body.ok === true && eq(t5.calls[0].body.models, ["anthropic/claude-sonnet-5"]), JSON.stringify(t5.calls[0] && t5.calls[0].body));

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
  assert("server: chain is free only and matches the page list",
    Array.isArray(chain) && chain.length >= 3 && chain.every(function (m) { return /:free$/.test(m); }) && eq(chain, BR.OPENROUTER_FREE_CHAIN),
    JSON.stringify(chain));
  assert("server: openrouter default model is the chain head",
    BR.PROVIDERS.openrouter.defaultModel === BR.OPENROUTER_FREE_CHAIN[0], BR.PROVIDERS.openrouter.defaultModel);

  /* Unset-key case: the fallback must be completely inert. */
  const groqOnly = { GROQ_API_KEY: FAKE_GROQ_KEY };
  const u1 = loadServer(groqOnly, scriptFor([{ match: "api.groq.com", make: function () { return groqErr(429); } }]));
  const ru1 = await callServer(u1, base, "10.0.1.1");
  assert("unset key: groq 429 returns fallbackSkipped and never calls openrouter",
    ru1.body.ok === false && ru1.body.status === 429 && ru1.body.fallbackSkipped === "no_openrouter_key" && !ru1.body.fallbackExhausted &&
    u1.calls.length === 1 && u1.calls[0].url.indexOf("api.groq.com") !== -1,
    JSON.stringify(ru1.body) + " calls=" + u1.calls.length);
  assert("unset key: failed groq attempt keeps the full deadline, not the 25s fallback cap",
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
