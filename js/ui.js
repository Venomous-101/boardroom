/* Boardroom UI rendering: the conversation room.
   Every dynamic string passes through BR.esc before it reaches innerHTML.
   No user text and no model text is ever inserted unescaped.
   Portraits come from a fixed allowlist of seat ids, never from user input. */

var BR = (function () {
  if (typeof window !== "undefined") { window.BR = window.BR || {}; return window.BR; }
  globalThis.BR = globalThis.BR || {}; return globalThis.BR;
})();

BR.esc = function (value) {
  var s = (value === null || value === undefined) ? "" : String(value);
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
};

BR.voteBadgeClass = function (stance) {
  if (!stance) { return "waiting"; }
  if (stance.indexOf("Strong yes") === 0) { return "yes-strong"; }
  if (stance.indexOf("Yes, if") === 0) { return "yes-if"; }
  if (stance.indexOf("Yes") === 0) { return "yes"; }
  if (stance.indexOf("Strong no") === 0) { return "no-strong"; }
  return "no";
};

BR.latestCardFor = function (state, advisorId) {
  if (state.debateRounds.length > 0) {
    var last = state.debateRounds[state.debateRounds.length - 1].cards[advisorId];
    if (last) { return { card: last, phase: "Debate" }; }
  }
  if (state.opening[advisorId]) { return { card: state.opening[advisorId], phase: "Opening" }; }
  return null;
};

/* Portrait files shipped with the app, keyed by seat id. Any other id
   (including the custom advisor) falls back to initials. */
BR.avatarPathFor = function (advisorId) {
  var known = ["operator", "offer", "investor", "marketer", "philosopher", "founder", "saas", "eos"];
  if (known.indexOf(advisorId) === -1) { return null; }
  return "assets/avatars/" + advisorId + ".png";
};

/* Round thumb: initials underneath, portrait on top. If the portrait
   fails to load, the onerror hides it and the initials show instead. */
BR.avatarThumb = function (a, cls) {
  var path = BR.avatarPathFor(a.id);
  var inner = '<span class="thumb-initials" style="background:' + BR.esc(a.color) + '">' + BR.esc(a.initials) + '</span>';
  if (path) {
    inner += '<img class="thumb-img" src="' + BR.esc(path) + '" alt="" onerror="this.style.display=\'none\'">';
  }
  return '<span class="thumb ' + (cls || "") + '">' + inner + '</span>';
};

BR.advisorByShort = function (state, short) {
  var found = null;
  state.advisors.forEach(function (a) { if (a.short === short) { found = a; } });
  return found;
};

/* Room progress: 0 Brief, 1 Openings, 2 Fault lines, 3 Debate, 4 Vote, 5 Verdict. */
BR.phaseOf = function (state) {
  if (state.verdict) { return 5; }
  if (Object.keys(state.final).length > 0) { return 4; }
  if (state.debateRounds.length > 0) { return 3; }
  if (state.director && Object.keys(state.opening).length >= state.advisors.length) { return 2; }
  if (state.director) { return 1; }
  return 0;
};

BR.STEPPER_LABELS = ["Brief", "Openings", "Fault lines", "Debate", "Vote", "Verdict"];

BR.renderStepper = function (container, state) {
  var phase = BR.phaseOf(state);
  var html = '<nav class="stepper" aria-label="Debate progress">';
  BR.STEPPER_LABELS.forEach(function (label, i) {
    var cls = "step";
    if (i < phase) { cls += " done"; }
    if (i === phase) { cls += " current"; }
    if (i > 0) { html += '<span class="step-sep" aria-hidden="true">›</span>'; }
    html += '<span class="' + cls + '">' + BR.esc(label) + '</span>';
  });
  html += '</nav>';
  container.innerHTML = html;
};

BR.renderStage = function (container, state, speakingId) {
  var html = '<div class="stage">';
  state.advisors.forEach(function (a) {
    var found = BR.latestCardFor(state, a.id);
    var card = found ? found.card : null;
    var final = state.final[a.id];
    var speaking = speakingId === a.id;
    var cls = "stage-seat";
    if (speaking) { cls += " speaking"; }
    else if (speakingId) { cls += " dim"; }
    html += '<div class="' + cls + '" style="--seat-color:' + BR.esc(a.color) + '">';
    html += BR.avatarThumb(a, "large");
    html += '<div class="stage-name">' + BR.esc(a.short) + '</div>';
    html += '<div class="stage-role">' + BR.esc(a.role) + '</div>';
    if (speaking) {
      html += '<div class="thinking" aria-label="Speaking"><span></span><span></span><span></span></div>';
    }
    if (final) {
      html += '<div class="stage-status"><span class="vote-badge">' + BR.esc(final.vote) + '</span> ' + BR.esc(final.finalScore) + '/10</div>';
    } else if (card) {
      html += '<div class="stage-status"><span class="vote-badge ' + BR.voteBadgeClass(card.stance) + '">' + BR.esc(card.stance) + '</span> Option ' + BR.esc(card.recommendedId) + ': ' + BR.esc(card.optionScores[card.recommendedId]) + '/10</div>';
    } else {
      html += '<div class="stage-status"><span class="vote-badge waiting">Waiting</span></div>';
    }
    html += '</div>';
  });
  html += '</div>';
  html += '<p class="stage-note muted sim-note">Seats are AI simulations inspired by public frameworks. They are not the real people and do not speak for them.</p>';
  container.innerHTML = html;
};

BR.renderCruxes = function (container, state) {
  if (!state.director) {
    container.innerHTML = '<p class="muted">The Director\'s fault lines appear here after the brief.</p>';
    return;
  }
  var html = '<p class="crux-brief">' + BR.esc(state.director.brief) + '</p>';
  html += '<ol class="crux-list">';
  state.director.cruxes.forEach(function (c) {
    html += '<li><strong>' + BR.esc(c.question) + '</strong>';
    if (c.sides && c.sides.length > 0) {
      html += '<span class="crux-sides">' + c.sides.map(function (s) {
        return BR.esc(s.position || s);
      }).join(" vs ") + '</span>';
    }
    html += '</li>';
  });
  html += '</ol>';
  if (state.director.assumptions && state.director.assumptions.length > 0) {
    html += '<p class="muted">Assumptions: ' + state.director.assumptions.map(function (a) { return BR.esc(a); }).join("; ") + '</p>';
  }
  container.innerHTML = html;
};

BR.renderTranscript = function (container, state, speakingId) {
  if (!state || state.transcript.length === 0) {
    container.innerHTML = '<p class="muted">No conversation yet. Start a debate and every step will appear here live.</p>';
    return;
  }
  var html = "";
  state.transcript.forEach(function (t) {
    if (t.kind === "director" || t.speaker === "Director") {
      html += '<div class="tx-entry tx-director"><div class="tx-head"><span class="tx-speaker">Director</span>';
      html += '<span class="tx-kind">' + BR.esc(t.title) + '</span></div>';
      html += '<div class="tx-body">' + BR.esc(t.body) + '</div></div>';
    } else {
      var adv = BR.advisorByShort(state, t.speaker);
      html += '<div class="tx-entry tx-advisor">';
      if (adv) { html += BR.avatarThumb(adv, ""); }
      html += '<div class="tx-content"><div class="tx-head"><span class="tx-speaker">' + BR.esc(t.speaker) + '</span>';
      html += '<span class="tx-kind">' + BR.esc(t.title) + '</span></div>';
      html += '<div class="tx-body">' + BR.esc(t.body) + '</div></div></div>';
    }
  });
  if (speakingId && !state.completed) {
    var current = BR.advisorById(state, speakingId);
    if (current) {
      html += '<div class="tx-entry tx-thinking">' + BR.avatarThumb(current, "") + '<span><strong>' + BR.esc(current.short) + '</strong> is thinking<span class="thinking"><span></span><span></span><span></span></span></span></div>';
    }
  }
  container.innerHTML = html;
};

/* Key points side panel: live one-liners per seat during the debate,
   the full scorecard table and math lines after the verdict. */
BR.renderKeyPoints = function (container, state) {
  if (state.verdict) {
    var v = state.verdict;
    var html = '<table class="score-table"><thead><tr><th>Seat</th><th>Weight</th><th>Final stance</th><th>Pillar</th><th>Line</th></tr></thead><tbody>';
    state.advisors.forEach(function (a) {
      var w = state.director.weights[a.id] ? state.director.weights[a.id].weight : 1;
      var latest = BR.latestCardFor(state, a.id);
      var f = state.final[a.id];
      html += '<tr><td>' + BR.esc(a.short) + '</td><td>' + BR.esc(w) + '</td>';
      html += '<td>' + BR.esc(latest ? latest.card.stance : "") + '</td>';
      html += '<td>' + BR.esc(v.pillarScores[a.id]) + '/10</td>';
      html += '<td>' + BR.esc(f ? f.line : "") + '</td></tr>';
    });
    html += '</tbody></table>';
    html += '<div class="math-lines">';
    state.options.forEach(function (o) {
      html += '<div>' + BR.esc(v.optionScores[o.id].math) + '</div>';
    });
    html += '</div>';
    container.innerHTML = html;
    return;
  }
  var items = "";
  state.advisors.forEach(function (a) {
    var found = BR.latestCardFor(state, a.id);
    var card = found ? found.card : null;
    var weight = state.director && state.director.weights[a.id] ? state.director.weights[a.id].weight : "-";
    items += '<div class="kp-item">' + BR.avatarThumb(a, "") + '<div class="kp-content">';
    items += '<div class="kp-head"><span class="kp-name">' + BR.esc(a.short) + '</span>';
    items += '<span class="kp-weight">Weight ' + BR.esc(weight) + ' / 3</span></div>';
    if (card) {
      items += '<div class="kp-line"><span class="vote-badge ' + BR.voteBadgeClass(card.stance) + '">' + BR.esc(card.stance) + '</span> Option ' + BR.esc(card.recommendedId) + ': ' + BR.esc(card.optionScores[card.recommendedId]) + '/10</div>';
      items += '<div class="kp-meta">Pillar ' + BR.esc(card.pillarScore) + '/10 &middot; Confidence ' + BR.esc(card.confidence) + '/5 &middot; Ruin: ' + BR.esc(card.ruinRisk) + ' &middot; Door: ' + BR.esc(card.door) + '</div>';
      items += '<div class="kp-reason">' + BR.esc(card.reason) + '</div>';
    } else {
      items += '<div class="kp-line"><span class="vote-badge waiting">Waiting</span></div>';
    }
    items += '</div></div>';
  });
  container.innerHTML = items;
};

BR.renderVerdict = function (container, state) {
  if (!state.verdict || !state.draft) {
    container.innerHTML = '<p class="muted">The verdict appears here after the final vote.</p>';
    return;
  }
  var v = state.verdict;
  var d = state.draft;
  var html = '<div class="verdict-label">' + BR.esc(v.label) + '</div>';
  html += '<p class="verdict-call">Option ' + BR.esc(v.recommendedId) + ' ' + BR.esc(BR.optionLabelOf(state, v.recommendedId)) + ', scoring ' + BR.esc(v.recommendedScore) + '/10.</p>';
  html += '<div class="verdict-stats">';
  html += '<span>Support ' + BR.esc(v.support) + '/10</span><span>Confidence ' + BR.esc(v.confidence) + '/10</span>';
  html += '<span>Spread ' + BR.esc(v.spread) + '</span>';
  html += '<span>Vote: ' + BR.esc(v.votes.endorse) + ' endorse, ' + BR.esc(v.votes.amend) + ' amend, ' + BR.esc(v.votes.dissent) + ' dissent</span>';
  html += '</div>';
  if (v.overrides.length > 0) {
    html += '<div class="overrides">';
    v.overrides.forEach(function (o) { html += '<div>Override: ' + BR.esc(o) + '</div>'; });
    html += '</div>';
  }
  html += '<h3>Conditions</h3><ul>';
  d.conditions.forEach(function (c) {
    html += '<li>' + BR.esc(c.text) + (c.gating ? ' <strong>(must clear before any irreversible step)</strong>' : '') + '</li>';
  });
  if (d.conditions.length === 0) { html += '<li>No conditions recorded.</li>'; }
  html += '</ul>';
  html += '<h3>What to do next</h3><ol>';
  d.nextSteps.forEach(function (s) { html += '<li>' + BR.esc(s) + '</li>'; });
  if (d.nextSteps.length === 0) { html += '<li>No next steps recorded.</li>'; }
  html += '</ol>';
  html += '<p><strong>Cheapest test:</strong> ' + BR.esc(d.cheapestTest) + '</p>';
  html += '<p><strong>Kill criteria:</strong> ' + BR.esc(d.killCriteria) + '</p>';
  if (d.waitFor) { html += '<p><strong>Wait trigger:</strong> ' + BR.esc(d.waitFor) + '</p>'; }
  if (d.risks.length > 0) {
    html += '<h3>Hidden risks</h3><ul>';
    d.risks.forEach(function (r) { html += '<li>' + BR.esc(r) + '</li>'; });
    html += '</ul>';
  }
  if (d.tradeoffs.length > 0) {
    html += '<h3>Explicit trade-offs</h3><ul>';
    d.tradeoffs.forEach(function (t) { html += '<li>' + BR.esc(t) + '</li>'; });
    html += '</ul>';
  }
  if (v.minority) {
    html += '<h3>Minority report</h3><p>' + BR.esc(v.minority.short) + ' dissented: ' + BR.esc(v.minority.reason) + '</p>';
  }
  if (v.dissentList.length > 0) {
    html += '<h3>Dissent notes</h3><ul>';
    v.dissentList.forEach(function (d2) {
      html += '<li>' + BR.esc(d2.short) + ' (' + BR.esc(d2.vote) + '): ' + BR.esc(d2.reason) + '</li>';
    });
    html += '</ul>';
  }
  if (v.preferredOtherwise.length > 0) {
    html += '<h3>Preferred otherwise</h3><p>These advisors endorsed the resolution but preferred another option:</p><ul>';
    v.preferredOtherwise.forEach(function (d3) {
      html += '<li>' + BR.esc(d3.short) + ' preferred option ' + BR.esc(d3.topId) + ' (' + BR.esc(d3.vote) + '): ' + BR.esc(d3.reason) + '</li>';
    });
    html += '</ul>';
  }
  html += '<p class="muted sim-note">Advisors on this board are AI simulations inspired by public frameworks. They are not the real people and do not speak for them.</p>';
  container.innerHTML = html;
};

BR.renderHistory = function (container, sessions) {
  if (!sessions || sessions.length === 0) {
    container.innerHTML = '<p class="muted">No past debates yet. Completed debates are saved here automatically.</p>';
    return;
  }
  var html = "";
  sessions.forEach(function (s) {
    html += '<button class="history-item" data-session-id="' + BR.esc(s.id) + '">';
    html += '<span class="history-title">' + BR.esc(s.title) + '</span>';
    html += '<span class="history-meta">' + BR.esc(s.createdAt) + ' &middot; ' + BR.esc(s.provider) + ' &middot; ' + BR.esc(s.rounds) + ' rounds</span>';
    html += '</button>';
  });
  container.innerHTML = html;
};
