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
