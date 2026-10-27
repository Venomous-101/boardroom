/* Boardroom debate engine.
   UI-agnostic: no DOM access here, so the test harness can run it in Node.
   The Chair computes every number deterministically and never invents scores.
   Verdict math follows the documented protocol: weighted averages to one
   decimal, verdict bands, ruin cap, one-way door cap, spread, confidence. */

var BR = (function () {
  if (typeof window !== "undefined") { window.BR = window.BR || {}; return window.BR; }
  globalThis.BR = globalThis.BR || {}; return globalThis.BR;
})();

BR.LIMITS = {
  title: 200,
  context: 4000,
  options: 4,
  customName: 60,
  viewpoint: 500,
  rounds: 3
};

BR.FOCUS_LINES = {
  balanced: "Focus: balanced across cost, speed, and risk.",
  cost: "Focus: weigh cost and cash impact above speed.",
  speed: "Focus: weigh speed and momentum above cost.",
  risk: "Focus: weigh downside and reversibility above speed."
};

BR.clampText = function (value, max) {
  var s = (value === null || value === undefined) ? "" : String(value);
  if (s.length > max) { return s.slice(0, max); }
  return s;
};

BR.deriveStance = function (topScore) {
  if (topScore >= 8) { return "Strong yes"; }
  if (topScore >= 6.5) { return "Yes"; }
  if (topScore >= 5) { return "Yes, if"; }
  if (topScore >= 3) { return "No"; }
  return "Strong no";
};

BR.deriveVote = function (finalScore) {
  if (finalScore >= 7) { return "Endorse"; }
  if (finalScore >= 5) { return "Endorse with amendment"; }
  return "Dissent";
};

BR.topOptionOf = function (card, optionIds) {
  var best = null;
  var bestScore = -1;
  optionIds.forEach(function (id) {
    var s = card.optionScores ? card.optionScores[id] : undefined;
    if (typeof s === "number" && s > bestScore) { bestScore = s; best = id; }
  });
  return best;
};

/* ---------- Input ---------- */

BR.createDebate = function (input) {
  var options = [];
  var seen = {};
  (input.options || []).forEach(function (label) {
    var clean = BR.clampText((label || "").trim(), 120);
    if (clean && options.length < BR.LIMITS.options && !seen[clean]) {
      seen[clean] = true;
      options.push(clean);
    }
  });
  var hasDoNothing = options.some(function (o) { return /do nothing|keep (doing )?what|status quo/i.test(o); });
  if (!hasDoNothing) { options.push("Do nothing"); }
  if (options.length < 2) { options = ["Do it as proposed", "Do nothing"]; }
  var letters = ["A", "B", "C", "D", "E"];
  var optionObjs = options.map(function (label, i) {
    return { id: letters[i], label: label };
  });
  var advisors = (input.advisors || []).slice();
  var now = new Date().toISOString();
  return {
    id: "debate-" + Date.now(),
    createdAt: now,
    title: BR.clampText((input.title || "").trim(), BR.LIMITS.title),
    context: BR.clampText(input.context || "", BR.LIMITS.context),
    options: optionObjs,
    focus: input.focus || "balanced",
    rounds: Math.min(Math.max(parseInt(input.rounds, 10) || 2, 1), BR.LIMITS.rounds),
    provider: input.provider || "groq",
    model: (input.model || "").trim(),
    advisors: advisors,
    director: null,
    opening: {},
    debateRounds: [],
    draft: null,
    final: {},
    verdict: null,
    transcript: [],
    providerSwitches: [],
    failedStep: null,
    completed: false
  };
};

BR.optionIdsOf = function (state) {
  return state.options.map(function (o) { return o.id; });
};

BR.optionLabelOf = function (state, id) {
  var found = null;
  state.options.forEach(function (o) { if (o.id === id) { found = o.label; } });
  return found || id;
};

/* ---------- Validation: numbers are required, labels derive from them ---------- */

BR.validateDirector = function (obj, advisorIds) {
  if (!obj || typeof obj !== "object") { return null; }
  if (typeof obj.brief !== "string" || obj.brief.trim().length === 0) { return null; }
  if (!Array.isArray(obj.weights) || obj.weights.length === 0) { return null; }
  var weights = {};
  var threes = 0;
  var valid = true;
  obj.weights.forEach(function (w) {
    if (!w || advisorIds.indexOf(w.advisorId) === -1) { valid = false; return; }
    var weight = parseInt(w.weight, 10);
    if (!(weight >= 1 && weight <= 3)) { valid = false; return; }
    if (weight === 3) { threes += 1; }
    weights[w.advisorId] = { weight: weight, reason: BR.clampText(w.reason || "", 160) };
  });
  if (!valid) { return null; }
  advisorIds.forEach(function (id) {
    if (!weights[id]) { weights[id] = { weight: 1, reason: "General relevance." }; }
  });
  if (threes === 0) {
    var first = advisorIds[0];
    weights[first] = { weight: 3, reason: weights[first].reason };
    threes = 1;
  }
  if (threes > 2) {
    var sorted = advisorIds.slice().sort(function (a, b) { return weights[b].weight - weights[a].weight; });
    sorted.slice(2).forEach(function (id) { weights[id].weight = 2; });
  }
  var cruxes = [];
  if (Array.isArray(obj.cruxes)) {
    obj.cruxes.slice(0, 3).forEach(function (c) {
      if (c && typeof c.question === "string" && c.question.trim()) {
        cruxes.push({ question: BR.clampText(c.question.trim(), 140), sides: Array.isArray(c.sides) ? c.sides.slice(0, 2) : [] });
      }
    });
  }
  if (cruxes.length === 0) { return null; }
  return {
    brief: BR.clampText(obj.brief.trim(), 1200),
    weights: weights,
    cruxes: cruxes,
    assumptions: Array.isArray(obj.assumptions) ? obj.assumptions.slice(0, 5).map(function (a) { return BR.clampText(String(a), 160); }) : []
  };
};

BR.validateOpening = function (obj, optionIds) {
  if (!obj || typeof obj !== "object") { return null; }
  var scores = {};
  var ok = true;
  optionIds.forEach(function (id) {
    var raw = obj.optionScores ? obj.optionScores[id] : undefined;
    var n = BR.toScore(raw, NaN);
    if (!isFinite(n)) { ok = false; return; }
    scores[id] = n;
  });
  if (!ok) { return null; }
  var topId = BR.topOptionOf({ optionScores: scores }, optionIds);
  var stance = (typeof obj.stance === "string" && obj.stance.trim()) ? BR.clampText(obj.stance.trim(), 40) : BR.deriveStance(scores[topId]);
  var ruin = (obj.ruinRisk === "likely" || obj.ruinRisk === "possible") ? obj.ruinRisk : "none";
  if (obj.ruinRisk && obj.ruinRisk !== "none" && obj.ruinRisk !== "possible" && obj.ruinRisk !== "likely") { ruin = "possible"; }
  var door = (obj.door === "one-way") ? "one-way" : "two-way";
  return {
    stance: stance,
    recommendedId: topId,
    optionScores: scores,
    pillarScore: BR.toScore(obj.pillarScore, 5),
    confidence: BR.toConfidence(obj.confidence, 3),
    ruinRisk: ruin,
    door: door,
    reason: BR.clampText(typeof obj.reason === "string" ? obj.reason : "", 300),
    changeMind: BR.clampText(typeof obj.changeMind === "string" ? obj.changeMind : "", 200)
  };
};

BR.validateDebate = function (obj, optionIds) {
  if (!obj || typeof obj !== "object") { return null; }
  var base = BR.validateOpening(obj, optionIds);
  if (!base) { return null; }
  base.disagreeWith = BR.clampText(typeof obj.disagreeWith === "string" ? obj.disagreeWith : "", 60);
  base.rebuttal = BR.clampText(typeof obj.rebuttal === "string" ? obj.rebuttal : "", 600);
  base.concede = BR.clampText(typeof obj.concede === "string" ? obj.concede : "", 300);
  base.cruxAnswers = Array.isArray(obj.cruxAnswers) ? obj.cruxAnswers.slice(0, 3).map(function (a) { return BR.clampText(String(a), 300); }) : [];
  base.moved = BR.clampText(typeof obj.moved === "string" ? obj.moved : "no", 120);
  base.conditions = Array.isArray(obj.conditions) ? obj.conditions.slice(0, 3).map(function (a) { return BR.clampText(String(a), 200); }) : [];
  return base;
};

BR.validateDraft = function (obj) {
  if (!obj || typeof obj !== "object") { return null; }
  var conditions = [];
  if (Array.isArray(obj.conditions)) {
    obj.conditions.slice(0, 6).forEach(function (c) {
      if (typeof c === "string" && c.trim()) { conditions.push({ text: BR.clampText(c.trim(), 220), gating: false }); }
      else if (c && typeof c.text === "string" && c.text.trim()) {
        conditions.push({ text: BR.clampText(c.text.trim(), 220), gating: c.gating === true });
      }
    });
  }
  return {
    conditions: conditions,
    nextSteps: Array.isArray(obj.nextSteps) ? obj.nextSteps.slice(0, 5).map(function (a) { return BR.clampText(String(a), 220); }) : [],
    cheapestTest: BR.clampText(typeof obj.cheapestTest === "string" ? obj.cheapestTest : "", 220),
    killCriteria: BR.clampText(typeof obj.killCriteria === "string" ? obj.killCriteria : "", 220),
    risks: Array.isArray(obj.risks) ? obj.risks.slice(0, 5).map(function (a) { return BR.clampText(String(a), 220); }) : [],
    tradeoffs: Array.isArray(obj.tradeoffs) ? obj.tradeoffs.slice(0, 5).map(function (a) { return BR.clampText(String(a), 220); }) : [],
    waitFor: (typeof obj.waitFor === "string" && obj.waitFor.trim()) ? BR.clampText(obj.waitFor.trim(), 220) : null
  };
};

BR.validateFinal = function (obj) {
  if (!obj || typeof obj !== "object") { return null; }
  var finalScore = BR.toScore(obj.finalScore, NaN);
  if (!isFinite(finalScore)) { return null; }
  var vote = obj.vote;
  if (vote !== "Endorse" && vote !== "Endorse with amendment" && vote !== "Dissent") {
    vote = BR.deriveVote(finalScore);
  }
  return {
    vote: vote,
    finalScore: finalScore,
    finalPillarScore: BR.toScore(obj.finalPillarScore, 5),
    amendment: BR.clampText(typeof obj.amendment === "string" ? obj.amendment : "", 300),
    line: BR.clampText(typeof obj.line === "string" ? obj.line : "", 220)
  };
};

/* ---------- Scoring ---------- */

BR.computeOptionScores = function (state, cards) {
  var weights = state.director.weights;
  var totalWeight = 0;
  state.advisors.forEach(function (a) { totalWeight += (weights[a.id] ? weights[a.id].weight : 1); });
  var out = {};
  state.options.forEach(function (opt) {
    var parts = [];
    var sum = 0;
    state.advisors.forEach(function (a) {
      var w = weights[a.id] ? weights[a.id].weight : 1;
      var card = cards[a.id];
      var s = card && card.optionScores ? card.optionScores[opt.id] : 0;
      parts.push(w + "x" + s);
      sum += w * s;
    });
    var score = totalWeight > 0 ? Math.round((sum / totalWeight) * 10) / 10 : 0;
    out[opt.id] = { score: score, math: opt.id + " (" + parts.join(" + ") + ") / " + totalWeight + " = " + score };
  });
  return out;
};

BR.verdictBand = function (score) {
  if (score >= 7.5) { return "GO"; }
  if (score >= 6.0) { return "GO WITH CONDITIONS"; }
  if (score >= 4.5) { return "RESHAPE"; }
  return "DON'T DO IT";
};

BR.pickRecommended = function (state, optionScores) {
  var best = null;
  var bestScore = -1;
  state.options.forEach(function (opt) {
    var s = optionScores[opt.id].score;
    if (s > bestScore) {
      bestScore = s;
      best = opt.id;
    }
  });
  return best;
};

BR.computeVerdict = function (state) {
  var latest = state.debateRounds.length > 0
    ? state.debateRounds[state.debateRounds.length - 1].cards
    : state.opening;
  var optionScores = BR.computeOptionScores(state, latest);
  var recommendedId = BR.pickRecommended(state, optionScores);
  var recommendedScore = optionScores[recommendedId].score;
  var label = BR.verdictBand(recommendedScore);
  var overrides = [];
  var ruinSeats = [];
  state.advisors.forEach(function (a) {
    var card = latest[a.id];
    if (card && card.ruinRisk === "likely" && card.recommendedId === recommendedId) {
      ruinSeats.push(a.short);
    }
  });
  if (ruinSeats.length > 0 && label !== "DON'T DO IT") {
    label = "RESHAPE";
    overrides.push("Ruin cap applied: " + ruinSeats.join(", ") + " flagged likely ruin risk on the recommended option.");
  }
  var scoresOnRec = state.advisors.map(function (a) {
    var card = latest[a.id];
    return card && card.optionScores ? card.optionScores[recommendedId] : 0;
  });
  var spread = Math.round((Math.max.apply(null, scoresOnRec) - Math.min.apply(null, scoresOnRec)) * 10) / 10;
  var oneWayCount = 0;
  state.advisors.forEach(function (a) {
    var card = latest[a.id];
    if (card && card.door === "one-way" && card.recommendedId === recommendedId) { oneWayCount += 1; }
  });
  if (oneWayCount > state.advisors.length / 2 && spread >= 4 && (label === "GO" || label === "GO WITH CONDITIONS")) {
    label = "GO WITH CONDITIONS";
    overrides.push("One-way door cap applied: a majority called the recommended option one-way and the spread is " + spread + ".");
  }
  if (state.draft && state.draft.waitFor && (label === "GO" || label === "GO WITH CONDITIONS")) {
    label = "WAIT";
    overrides.push("WAIT applied: the recommendation depends on an unmet prerequisite.");
  }
  var confSum = 0;
  state.advisors.forEach(function (a) {
    var card = latest[a.id];
    confSum += card && card.confidence ? card.confidence : 3;
  });
  var confidence = Math.round((confSum / state.advisors.length) * 2);
  if (spread >= 5) { confidence -= 1; }
  if (confidence < 1) { confidence = 1; }
  if (confidence > 10) { confidence = 10; }
  var totalWeight = 0;
  var supportSum = 0;
  var endorse = 0, amend = 0, dissent = 0;
  state.advisors.forEach(function (a) {
    var w = state.director.weights[a.id] ? state.director.weights[a.id].weight : 1;
    var f = state.final[a.id];
    if (f) {
      totalWeight += w;
      supportSum += w * f.finalScore;
      if (f.vote === "Endorse") { endorse += 1; }
      else if (f.vote === "Endorse with amendment") { amend += 1; }
      else { dissent += 1; }
    }
  });
  var support = totalWeight > 0 ? Math.round((supportSum / totalWeight) * 10) / 10 : 0;
  var pillarCard = {};
  state.advisors.forEach(function (a) {
    var f = state.final[a.id];
    var l = latest[a.id];
    pillarCard[a.id] = f ? f.finalPillarScore : (l ? l.pillarScore : 0);
  });
  var dissentList = BR.dissenters(state);
  var otherwiseList = BR.preferredOtherwise(state, recommendedId);
  var minority = null;
  var pickStrongest = function (list) {
    var best = null;
    var bestPillar = -1;
    list.forEach(function (d) {
      if (d.pillarScore > bestPillar) { bestPillar = d.pillarScore; best = d; }
    });
    return best;
  };
  minority = pickStrongest(dissentList) || pickStrongest(otherwiseList);
  return {
    recommendedId: recommendedId,
    recommendedScore: recommendedScore,
    label: label,
    optionScores: optionScores,
    support: support,
    confidence: confidence,
    spread: spread,
    votes: { endorse: endorse, amend: amend, dissent: dissent },
    pillarScores: pillarCard,
    overrides: overrides,
    dissentList: dissentList,
    preferredOtherwise: otherwiseList,
    minority: minority
  };
};

BR.dissenters = function (state) {
  var list = [];
  state.advisors.forEach(function (a) {
    var f = state.final[a.id];
    if (f && f.vote === "Dissent") {
      list.push({
        advisorId: a.id,
        short: a.short,
        vote: f.vote,
        reason: f.amendment || "",
        pillarScore: f.finalPillarScore
      });
    }
  });
  return list;
};

/* Advisors who endorsed (or amended) the resolution but whose own top
   option differs from the recommended one. Reported separately from true
   dissent so the verdict never reads as false consensus. */
BR.preferredOtherwise = function (state, recommendedId) {
  var list = [];
  state.advisors.forEach(function (a) {
    var f = state.final[a.id];
    var latest = state.debateRounds.length > 0
      ? state.debateRounds[state.debateRounds.length - 1].cards[a.id]
      : state.opening[a.id];
    var topId = latest ? latest.recommendedId : null;
    if (f && f.vote !== "Dissent" && topId && topId !== recommendedId) {
      list.push({
        advisorId: a.id,
        short: a.short,
        vote: f.vote,
        reason: latest ? latest.reason : "",
        pillarScore: f.finalPillarScore,
        topId: topId
      });
    }
  });
  return list;
};

BR.strongestOpposingPoint = function (state, advisorId, prevCards) {
  var mine = prevCards[advisorId];
  if (!mine) { return null; }
  var best = null;
  var bestScore = -1;
  state.advisors.forEach(function (a) {
    if (a.id === advisorId) { return; }
    var card = prevCards[a.id];
    if (!card) { return; }
    if (card.recommendedId && card.recommendedId !== mine.recommendedId && card.pillarScore > bestScore) {
      bestScore = card.pillarScore;
      best = { short: a.short, reason: card.reason, topId: card.recommendedId };
    }
  });
  return best;
};

/* ---------- Step prompts ---------- */

BR.directorSystem = "You are the Director (Chair) of a business advisory board. You never argue a side. You frame decisions, set weights, and structure verdicts. Plain English, short sentences. Return ONLY the JSON object requested, with no surrounding text.";

BR.directorUser = function (state) {
  var lines = [];
  lines.push("Decision: " + state.title);
  lines.push("Context: " + state.context);
  lines.push("Options:");
  state.options.forEach(function (o) { lines.push(o.id + ". " + o.label); });
  lines.push("Advisors at the table:");
  state.advisors.forEach(function (a) { lines.push("- " + a.id + ": " + a.short + " (" + a.pillar + ")"); });
  lines.push(BR.FOCUS_LINES[state.focus] || BR.FOCUS_LINES.balanced);
  lines.push("Return ONLY this JSON object, nothing else:");
  lines.push('{"brief": "under 200 words framing the decision, options, and what is at stake",');
  lines.push('"weights": [{"advisorId": "id", "weight": 1-3, "reason": "one line"}],');
  lines.push('"cruxes": [{"question": "one underlying disagreement, under 140 chars", "sides": [{"position": "short", "seats": ["Short names"]}]}],');
  lines.push('"assumptions": ["anything you assumed, or empty"]}');
  lines.push("Rules: give exactly one or two advisors weight 3, the rest 1 or 2. List 1 to 3 cruxes. Every advisor id above must appear in weights exactly once.");
  return lines.join("\n");
};

BR.openingUser = function (state, advisor, weight) {
  var lines = [];
  lines.push("Decision: " + state.title);
  lines.push("Context: " + state.context);
  lines.push("Options:");
  state.options.forEach(function (o) { lines.push(o.id + ". " + o.label); });
  lines.push("Your weight on this decision: " + weight + "/3.");
  lines.push(BR.FOCUS_LINES[state.focus] || BR.FOCUS_LINES.balanced);
  lines.push("This is Round 1, your opening position. Return ONLY this JSON object, nothing else:");
  lines.push('{"stance": "Strong yes | Yes | Yes, if | No | Strong no, on the option you recommend",');
  lines.push('"optionScores": {' + state.options.map(function (o) { return '"' + o.id + '": 0-10'; }).join(", ") + '},');
  lines.push('"pillarScore": 0-10, "confidence": 1-5, "ruinRisk": "none | possible | likely", "door": "one-way | two-way",');
  lines.push('"reason": "one line, your core argument", "changeMind": "one concrete fact or number that would change your mind"}');
  return lines.join("\n");
};

BR.debateUser = function (state, advisor, prevCards, roundNumber) {
  var lines = [];
  lines.push("Decision: " + state.title);
  lines.push("Context: " + state.context);
  lines.push("Options:");
  state.options.forEach(function (o) { lines.push(o.id + ". " + o.label); });
  lines.push("Cruxes the Chair sees:");
  state.director.cruxes.forEach(function (c, i) { lines.push((i + 1) + ". " + c.question); });
  lines.push("Previous round cards (short name, stance, recommended option, reason):");
  state.advisors.forEach(function (a) {
    var card = prevCards[a.id];
    if (card) { lines.push("- " + a.short + ": " + card.stance + " on option " + card.recommendedId + ". " + card.reason); }
  });
  var opp = BR.strongestOpposingPoint(state, advisor.id, prevCards);
  if (opp) {
    lines.push("Strongest opposing point: " + opp.short + " backs option " + opp.topId + ": " + opp.reason + ". Answer it directly.");
  } else {
    lines.push("Everyone agreed with you last round. Treat that as a warning: find the weakest part of your own case and say it.");
  }
  lines.push(BR.FOCUS_LINES[state.focus] || BR.FOCUS_LINES.balanced);
  lines.push("This is debate round " + roundNumber + ". Return ONLY this JSON object, nothing else:");
  lines.push('{"disagreeWith": "short name of the seat you disagree with most", "rebuttal": "your rebuttal, under 600 chars",');
  lines.push('"concede": "the strongest point against you and what it changes", "cruxAnswers": ["one or two lines per crux"],');
  lines.push('"stance": "Strong yes | Yes | Yes, if | No | Strong no",');
  lines.push('"optionScores": {' + state.options.map(function (o) { return '"' + o.id + '": 0-10'; }).join(", ") + '},');
  lines.push('"pillarScore": 0-10, "confidence": 1-5, "ruinRisk": "none | possible | likely",');
  lines.push('"moved": "no, or yes, from X to Y, because ...", "conditions": ["up to three concrete checkable conditions for yes"]}');
  return lines.join("\n");
};

BR.draftUser = function (state, optionScores, recommendedId) {
  var lines = [];
  lines.push("Decision: " + state.title);
  lines.push("Context: " + state.context);
  lines.push("Options and weighted scores:");
  state.options.forEach(function (o) { lines.push(o.id + ". " + o.label + ": " + optionScores[o.id].score + "/10"); });
  lines.push("Recommended option (computed by the Chair from scores): " + recommendedId + " " + BR.optionLabelOf(state, recommendedId));
  lines.push(BR.FOCUS_LINES[state.focus] || BR.FOCUS_LINES.balanced);
  lines.push("Write the draft resolution for that recommendation. Return ONLY this JSON object, nothing else:");
  lines.push('{"conditions": [{"text": "checkable condition", "gating": true if it must clear before any irreversible step, else false}],');
  lines.push('"nextSteps": ["concrete steps with owners or dates"], "cheapestTest": "the smallest test of the riskiest assumption",');
  lines.push('"killCriteria": "the signal that means stop", "risks": ["hidden risks"], "tradeoffs": ["explicit trade-offs"],');
  lines.push('"waitFor": "a prerequisite that is not met yet, or null if none"}');
  return lines.join("\n");
};

BR.finalUser = function (state, advisor) {
  var lines = [];
  lines.push("Decision: " + state.title);
  lines.push("Draft resolution: recommend option " + state.verdictDraftId + " " + BR.optionLabelOf(state, state.verdictDraftId) + ".");
  if (state.draft) {
    lines.push("Conditions:");
    state.draft.conditions.forEach(function (c) { lines.push("- " + c.text + (c.gating ? " (gating)" : "")); });
    lines.push("Next steps: " + state.draft.nextSteps.join("; "));
    lines.push("Cheapest test: " + state.draft.cheapestTest);
  }
  lines.push("Vote on the draft resolution as written. Return ONLY this JSON object, nothing else:");
  lines.push('{"vote": "Endorse | Endorse with amendment | Dissent", "finalScore": 0-10 support for the resolution,');
  lines.push('"finalPillarScore": 0-10, "amendment": "what to change, or why you dissent (blank if you endorse)",');
  lines.push('"line": "the one thing from your pillar the founder must not forget"}');
  return lines.join("\n");
};

/* ---------- Runner: sequential steps, per-step retry, resumable ---------- */

BR.buildStepList = function (state) {
  var steps = [{ key: "director", label: "Director brief" }];
  state.advisors.forEach(function (a) {
    steps.push({ key: "opening:" + a.id, label: "Opening vote: " + a.short, advisorId: a.id });
  });
  for (var r = 1; r <= state.rounds; r++) {
    state.advisors.forEach(function (a) {
      steps.push({ key: "debate:" + r + ":" + a.id, label: "Debate round " + r + ": " + a.short, advisorId: a.id, round: r });
    });
  }
  steps.push({ key: "draft", label: "Draft resolution" });
  state.advisors.forEach(function (a) {
    steps.push({ key: "final:" + a.id, label: "Final vote: " + a.short, advisorId: a.id });
  });
  steps.push({ key: "verdict", label: "Verdict" });
  return steps;
};

BR.stepExecutor = function (state, step, callFn, onProgress) {
  var attempts = 0;
  var runAttempt = function () {
    attempts += 1;
    if (onProgress) { onProgress(step, attempts); }
    return callFn(state, step).then(function (res) {
      if (!res.ok) { return { ok: false, error: res.error, attempts: attempts }; }
      var parsed = BR.extractJSON(res.text);
      if (!parsed) {
        if (attempts < 3) { return runAttempt(); }
        return { ok: false, error: { code: "bad_output", message: "The model returned unusable output 3 times for this step. Retry this step." }, attempts: attempts };
      }
      var applied = BR.applyStepResult(state, step, parsed);
      if (!applied.ok) {
        if (attempts < 3) { return runAttempt(); }
        return { ok: false, error: { code: "bad_output", message: "The model output was missing required scores 3 times for this step. Retry this step." }, attempts: attempts };
      }
      return { ok: true, attempts: attempts };
    });
  };
  return runAttempt();
};

BR.applyStepResult = function (state, step, parsed) {
  var advisorIds = state.advisors.map(function (a) { return a.id; });
  var optionIds = BR.optionIdsOf(state);
  if (step.key === "director") {
    var d = BR.validateDirector(parsed, advisorIds);
    if (!d) { return { ok: false }; }
    state.director = d;
    state.transcript.push({ kind: "director", speaker: "Director", title: "Brief", body: d.brief });
    return { ok: true };
  }
  if (step.key.indexOf("opening:") === 0) {
    var o = BR.validateOpening(parsed, optionIds);
    if (!o) { return { ok: false }; }
    state.opening[step.advisorId] = o;
    var adv = BR.advisorById(state, step.advisorId);
    state.transcript.push({ kind: "vote", speaker: adv ? adv.short : step.advisorId, title: "Opening vote", body: o.stance + " on option " + o.recommendedId + ". " + o.reason });
    return { ok: true };
  }
  if (step.key.indexOf("debate:") === 0) {
    var db = BR.validateDebate(parsed, optionIds);
    if (!db) { return { ok: false }; }
    var round = state.debateRounds[step.round - 1];
    if (!round) { round = { round: step.round, cards: {} }; state.debateRounds[step.round - 1] = round; }
    round.cards[step.advisorId] = db;
    var adv2 = BR.advisorById(state, step.advisorId);
    state.transcript.push({ kind: "argument", speaker: adv2 ? adv2.short : step.advisorId, title: "Debate round " + step.round, body: db.rebuttal || db.reason });
    return { ok: true };
  }
  if (step.key === "draft") {
    var latest = state.debateRounds.length > 0
      ? state.debateRounds[state.debateRounds.length - 1].cards
      : state.opening;
    var scores = BR.computeOptionScores(state, latest);
    var rec = BR.pickRecommended(state, scores);
    var dr = BR.validateDraft(parsed);
    if (!dr) { return { ok: false }; }
    state.draft = dr;
    state.verdictDraftId = rec;
    state.transcript.push({ kind: "draft", speaker: "Director", title: "Draft resolution", body: "Recommend option " + rec + " " + BR.optionLabelOf(state, rec) + ". Cheapest test: " + dr.cheapestTest });
    return { ok: true };
  }
  if (step.key.indexOf("final:") === 0) {
    var f = BR.validateFinal(parsed);
    if (!f) { return { ok: false }; }
    state.final[step.advisorId] = f;
    var adv3 = BR.advisorById(state, step.advisorId);
    state.transcript.push({ kind: "final", speaker: adv3 ? adv3.short : step.advisorId, title: "Final vote", body: f.vote + " (" + f.finalScore + "/10). " + (f.amendment || f.line) });
    return { ok: true };
  }
  if (step.key === "verdict") {
    state.verdict = BR.computeVerdict(state);
    state.completed = true;
    state.transcript.push({ kind: "verdict", speaker: "Director", title: "Verdict", body: state.verdict.label + ": option " + state.verdict.recommendedId + " " + BR.optionLabelOf(state, state.verdict.recommendedId) });
    return { ok: true };
  }
  return { ok: false };
};

BR.advisorById = function (state, id) {
  var found = null;
  state.advisors.forEach(function (a) { if (a.id === id) { found = a; } });
  return found;
};

/* Run the full debate. callFn(state, step) must return a promise of
   {ok:true, text} or {ok:false, error}. Returns a promise of
   {ok:true} or {ok:false, failedStep}. On failure, state.failedStep is
   set and the run can resume from that step with BR.resumeDebate. */
BR.runDebate = function (state, callFn, onProgress) {
  var steps = BR.buildStepList(state);
  var startIndex = 0;
  if (state.failedStep) {
    steps.forEach(function (s, i) { if (s.key === state.failedStep.key) { startIndex = i; } });
    state.failedStep = null;
  }
  var index = startIndex;
  var next = function () {
    if (index >= steps.length) { return Promise.resolve({ ok: true }); }
    var step = steps[index];
    if (step.key === "verdict") {
      var applied = BR.applyStepResult(state, step, {});
      index += 1;
      return next();
    }
    return BR.stepExecutor(state, step, callFn, onProgress).then(function (res) {
      if (!res.ok) {
        state.failedStep = { key: step.key, label: step.label, error: res.error };
        return { ok: false, failedStep: state.failedStep };
      }
      if (typeof state.onStepDone === "function") { state.onStepDone(step); }
      index += 1;
      return next();
    });
  };
  return next();
};

BR.resumeDebate = function (state, callFn, onProgress) {
  return BR.runDebate(state, callFn, onProgress);
};

/* ---------- Export builders ---------- */

BR.buildTranscriptText = function (state) {
  var lines = [];
  lines.push("BOARDROOM TRANSCRIPT");
  lines.push(state.title);
  lines.push("Created: " + state.createdAt);
  lines.push("Provider: " + state.provider + ", model: " + state.model + ", rounds: " + state.rounds + ", focus: " + state.focus);
  lines.push("");
  lines.push("Options:");
  state.options.forEach(function (o) { lines.push(o.id + ". " + o.label); });
  lines.push("");
  state.transcript.forEach(function (t) {
    lines.push("[" + t.title + "] " + t.speaker + ": " + t.body);
  });
  if (state.verdict) {
    lines.push("");
    lines.push("VERDICT: " + state.verdict.label + " (option " + state.verdict.recommendedId + " " + BR.optionLabelOf(state, state.verdict.recommendedId) + ")");
  }
  return lines.join("\n");
};

BR.buildMarkdown = function (state) {
  if (!state.verdict || !state.draft) { return ""; }
  var v = state.verdict;
  var lines = [];
  lines.push("# Boardroom: " + state.title);
  lines.push("");
  lines.push(state.createdAt + " | Seats: " + state.advisors.map(function (a) { return a.short; }).join(", ") + " | Rounds: " + state.rounds + " | Focus: " + state.focus);
  lines.push("");
  lines.push("## Verdict: " + v.label);
  lines.push("");
  lines.push("**The call:** option " + v.recommendedId + " " + BR.optionLabelOf(state, v.recommendedId) + ", scoring " + v.recommendedScore + "/10.");
  lines.push("");
  lines.push("Option scores: " + state.options.map(function (o) { return o.id + " " + v.optionScores[o.id].score; }).join(" | ") + " | Support for the resolution " + v.support + "/10 | Confidence " + v.confidence + "/10 | Spread " + v.spread + " | Vote: " + v.votes.endorse + " endorse, " + v.votes.amend + " amend, " + v.votes.dissent + " dissent");
  if (v.overrides.length > 0) {
    lines.push("");
    v.overrides.forEach(function (o) { lines.push("Override: " + o); });
  }
  lines.push("");
  lines.push("## Scorecard");
  lines.push("");
  lines.push("| Seat | Weight | Final stance | Pillar score | Their line |");
  lines.push("|---|---|---|---|---|");
  state.advisors.forEach(function (a) {
    var w = state.director.weights[a.id] ? state.director.weights[a.id].weight : 1;
    var f = state.final[a.id];
    var latest = state.debateRounds.length > 0
      ? state.debateRounds[state.debateRounds.length - 1].cards[a.id]
      : state.opening[a.id];
    lines.push("| " + a.short + " | " + w + " | " + (latest ? latest.stance : "") + " | " + v.pillarScores[a.id] + " | " + (f ? f.line : "") + " |");
  });
  lines.push("");
  lines.push("Math:");
  state.options.forEach(function (o) { lines.push("- " + v.optionScores[o.id].math); });
  lines.push("");
  lines.push("## Conditions");
  lines.push("");
  state.draft.conditions.forEach(function (c) { lines.push("- " + c.text + (c.gating ? " (must clear before any irreversible step)" : "")); });
  lines.push("");
  lines.push("## What to do next");
  lines.push("");
  state.draft.nextSteps.forEach(function (s, i) { lines.push((i + 1) + ". " + s); });
  lines.push("");
  lines.push("**Cheapest test:** " + state.draft.cheapestTest);
  lines.push("");
  lines.push("**Kill criteria:** " + state.draft.killCriteria);
  if (state.draft.waitFor) {
    lines.push("");
    lines.push("**Wait trigger:** " + state.draft.waitFor);
  }
  if (v.minority) {
    lines.push("");
    lines.push("## Minority report");
    lines.push("");
    lines.push(v.minority.short + " dissented: " + v.minority.reason);
  }
  if (v.dissentList.length > 0) {
    lines.push("");
    lines.push("## Dissent notes");
    lines.push("");
    v.dissentList.forEach(function (d) { lines.push("- " + d.short + " (" + d.vote + "): " + d.reason); });
  }
  if (v.preferredOtherwise.length > 0) {
    lines.push("");
    lines.push("## Preferred otherwise");
    lines.push("");
    lines.push("These advisors endorsed the resolution but preferred another option:");
    v.preferredOtherwise.forEach(function (d) { lines.push("- " + d.short + " preferred option " + d.topId + " (" + d.vote + "): " + d.reason); });
  }
  lines.push("");
  lines.push("---");
  lines.push("Advisors on this board are AI simulations inspired by public frameworks. They are not the real people and do not speak for them.");
  return lines.join("\n");
};
