/* Boardroom UI rendering: the conversation room.
   Every dynamic string passes through BR.esc before it reaches innerHTML.
   No user text and no model text is ever inserted unescaped.
   Portraits come from a fixed allowlist of seat ids, never from user input.
   Animation is pure CSS/JS: speaking rise/glow/bob, idle breathing and
   blink, hover lift with a seat card, click to focus, spotlight, and a
   rebuttal arrow strip. Reduced motion is honored in styles.css and by
   the blink timer in main.js. */

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

/* Vote stamp on a bust: ENDORSE (green), AMEND (amber), DISSENT (red). */
BR.voteStampClass = function (vote) {
  if (vote === "Endorse") { return "endorse"; }
  if (vote === "Endorse with amendment") { return "amend"; }
  if (vote === "Dissent") { return "dissent"; }
  return "";
};

BR.voteStampText = function (vote) {
  if (vote === "Endorse") { return "ENDORSE"; }
  if (vote === "Endorse with amendment") { return "AMEND"; }
  if (vote === "Dissent") { return "DISSENT"; }
  return "";
};

/* Small badge naming which provider and model served a step. Empty
   when no serving info exists, so old saved debates render cleanly.
   Provider and model are escaped like every other dynamic string. */
BR.providerBadge = function (servedBy) {
  if (!servedBy || !servedBy.provider || !servedBy.model) { return ""; }
  var label = (BR.PROVIDERS && BR.PROVIDERS[servedBy.provider])
    ? BR.PROVIDERS[servedBy.provider].label
    : servedBy.provider;
  return '<span class="provider-badge">via ' + BR.esc(label) + ' &middot; ' + BR.esc(servedBy.model) + '</span>';
};

/* Badge for one transcript step, looked up by the step key recorded
   when the step succeeded. */
BR.servedBadgeFor = function (state, stepKey) {
  if (!state || !stepKey || !state.servedBy) { return ""; }
  return BR.providerBadge(state.servedBy[stepKey]);
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
  inner += '<span class="mouth" aria-hidden="true"></span>';
  inner += '<span class="eyelid" aria-hidden="true"></span>';
  return '<span class="thumb ' + (cls || "") + '">' + inner + '</span>';
};

BR.advisorByShort = function (state, short) {
  var found = null;
  state.advisors.forEach(function (a) { if (a.short === short) { found = a; } });
  return found;
};

/* The most recent debate rebuttal in the transcript, as a speaker to
   target pair, for the rebuttal arrow strip under the stage. */
BR.currentRebuttal = function (state) {
  if (!state || !state.transcript) { return null; }
  for (var i = state.transcript.length - 1; i >= 0; i--) {
    var t = state.transcript[i];
    if (t.kind === "argument" && t.disagreeWith) {
      var from = BR.advisorByShort(state, t.speaker);
      var to = BR.advisorByShort(state, t.disagreeWith);
      if (from && to && from.id !== to.id) { return { from: from, to: to, kind: "argument" }; }
    }
    if (t.kind === "discussion" && t.answerTo) {
      var fromD = BR.advisorByShort(state, t.speaker);
      var toD = null;
      if (t.targetId) {
        state.advisors.forEach(function (a) { if (a.id === t.targetId) { toD = a; } });
      }
      if (!toD && typeof BR.matchAdvisorByLabel === "function") {
        toD = BR.matchAdvisorByLabel(state, t.answerTo, fromD ? fromD.id : null);
      }
      if (!toD) { toD = BR.advisorByShort(state, t.answerTo); }
      if (fromD && toD && fromD.id !== toD.id) { return { from: fromD, to: toD, kind: "discussion" }; }
    }
  }
  return null;
};

/* Room progress. Full: 0 Brief, 1 Openings, 2 Fault lines, 3 Debate,
   4 Discussion, 5 Draft, 6 Vote, 7 Verdict. Quick: 0 Brief, 1 Openings,
   2 Fault lines, 3 Vote, 4 Verdict (no debate, no discussion, no
   draft). Consult: no stepper. */
BR.stepperLabelsFor = function (state) {
  var mode = (state && state.mode) || "full";
  if (mode === "quick") { return ["Brief", "Openings", "Fault lines", "Vote", "Verdict"]; }
  if (mode === "consult") { return []; }
  return ["Brief", "Openings", "Fault lines", "Debate", "Discussion", "Draft", "Vote", "Verdict"];
};

BR.phaseOf = function (state) {
  var mode = (state && state.mode) || "full";
  if (mode === "consult") { return -1; }
  if (state.verdict) { return mode === "quick" ? 4 : 7; }
  if (Object.keys(state.final).length > 0) { return mode === "quick" ? 3 : 6; }
  if (mode !== "quick" && state.draft) { return 5; }
  if (mode !== "quick" && state.discussion && Object.keys(state.discussion).length > 0) { return 4; }
  if (state.debateRounds.length > 0) { return 3; }
  if (state.director && Object.keys(state.opening).length >= state.advisors.length) { return 2; }
  if (state.director) { return 1; }
  return 0;
};

BR.renderStepper = function (container, state) {
  var labels = BR.stepperLabelsFor(state);
  if (labels.length === 0) { container.innerHTML = ""; return; }
  var phase = BR.phaseOf(state);
  var html = '<nav class="stepper" aria-label="Debate progress">';
  labels.forEach(function (label, i) {
    var cls = "step";
    if (i < phase) { cls += " done"; }
    if (i === phase) { cls += " current"; }
    if (i > 0) { html += '<span class="step-sep" aria-hidden="true">›</span>'; }
    html += '<span class="' + cls + '"' + (i === phase ? ' aria-current="step"' : '') + '>' + BR.esc(label) + '</span>';
  });
  html += '</nav>';
  container.innerHTML = html;
};

/* Round table geometry: seats sit on an ellipse, starting at the
   top and going clockwise. Angles are in degrees, points are in
   percent of the stage box, so the table scales with the page and
   needs no fixed pixel layout. A custom advisor, if present, joins
   the same ring, so the table grows with the council. */
BR.seatPointFor = function (index, total) {
  var n = total > 0 ? total : 1;
  var rad = (-90 + (index * 360) / n) * Math.PI / 180;
  return { x: 50 + 42 * Math.cos(rad), y: 50 + 44 * Math.sin(rad) };
};

/* Lean toward the addressed seat as a real vector on the table, not
   just left or right: the unit direction from the speaker's point to
   the target's point, scaled to 14 pixels. Same seat or no target:
   no lean. The old leanClassFor stays for compatibility. */
BR.leanVectorFor = function (speakerIndex, targetIndex, total) {
  if (speakerIndex === null || speakerIndex === undefined ||
      targetIndex === null || targetIndex === undefined || speakerIndex === targetIndex) { return null; }
  var from = BR.seatPointFor(speakerIndex, total);
  var to = BR.seatPointFor(targetIndex, total);
  var dx = to.x - from.x;
  var dy = to.y - from.y;
  var len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) { return null; }
  return { dx: Math.round((dx / len) * 14), dy: Math.round((dy / len) * 14) };
};

/* Look direction on the table: which way a seat faces, from the real
   table geometry. Returns "left" or "right" when the target sits
   clearly to one side, and "" when it sits almost straight ahead or
   behind, so no seat turns for a target it already faces. This is
   direction only, distinct from the lean translation. */
BR.lookDirectionFor = function (fromIndex, toIndex, total) {
  if (fromIndex === null || fromIndex === undefined ||
      toIndex === null || toIndex === undefined || fromIndex === toIndex) { return ""; }
  var from = BR.seatPointFor(fromIndex, total);
  var to = BR.seatPointFor(toIndex, total);
  var dx = to.x - from.x;
  if (dx > 2) { return "right"; }
  if (dx < -2) { return "left"; }
  return "";
};

/* Arrow endpoints in pixels for a stage box of the given size, so
   the arrowhead keeps its shape: the SVG is sized to the box in
   pixels instead of stretching a 100 by 100 viewBox across a wide
   stage. Returns null for a missing or identical pair. */
BR.arrowPointsFor = function (fromIndex, toIndex, total, width, height) {
  if (fromIndex === null || fromIndex === undefined ||
      toIndex === null || toIndex === undefined || fromIndex === toIndex ||
      !width || !height) { return null; }
  var from = BR.seatPointFor(fromIndex, total);
  var to = BR.seatPointFor(toIndex, total);
  return {
    x1: Math.round((from.x / 100) * width), y1: Math.round((from.y / 100) * height),
    x2: Math.round((to.x / 100) * width), y2: Math.round((to.y / 100) * height)
  };
};

/* Data-driven reaction for a seat whose new card just landed, judged
   against the previous speaker's option. The seat nods when its new
   card moves onto the previous speaker's option, shakes when its new
   card moves off it, and stays neutral otherwise. No reaction is
   ever drawn from tone, only from these three option ids. */
BR.reactionFor = function (previousOptionId, newOptionId, speakerOptionId) {
  if (!previousOptionId || !newOptionId || !speakerOptionId) { return ""; }
  if (newOptionId === speakerOptionId && previousOptionId !== speakerOptionId) { return "nod"; }
  if (previousOptionId === speakerOptionId && newOptionId !== speakerOptionId) { return "shake"; }
  return "";
};

/* History dates in plain local form: "29 Oct 2026, 7:09 pm" style,
   from the browser's own locale, with no timezone label added. An
   unparseable value is returned as stored, never replaced with a
   guessed date. */
BR.formatHistoryDate = function (iso) {
  if (!iso) { return ""; }
  var d = new Date(iso);
  if (isNaN(d.getTime())) { return String(iso); }
  try {
    return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch (e) {
    return String(iso);
  }
};

BR.renderStage = function (container, state, speakingId, rebuttal) {
  var total = state.advisors.length;
  var speakerIdx = -1;
  var targetIdx = -1;
  state.advisors.forEach(function (a, i) {
    if (a.id === speakingId) { speakerIdx = i; }
    if (rebuttal && rebuttal.to && a.id === rebuttal.to.id) { targetIdx = i; }
  });
  var speakingAdv = speakerIdx >= 0 ? state.advisors[speakerIdx] : null;
  var html = '<div class="stage-round' + (speakingId ? ' spotlight' : '') + '">';
  /* Centre table: decision title, and the current speaker. The table
     is decorative structure, not a seat, and carries no vote. */
  html += '<div class="round-table"><div class="round-table-title">' + BR.esc(state.title || "The board") + '</div>';
  if (speakingAdv) {
    html += '<div class="round-table-speaker">' + BR.esc(speakingAdv.short) + ' speaking</div>';
  } else {
    html += '<div class="round-table-speaker">The board</div>';
  }
  html += '</div>';
  /* Arrow across the table, speaker to target. The line starts in
     the same percent coordinates as the seats, and the page then
     repositions it in pixels for the real stage box (see
     positionArrows in main.js), so the arrowhead keeps its shape on
     any stage width instead of stretching. The text strip below
     repeats it in words for screen readers and for plain text. */
  if (rebuttal && rebuttal.from && rebuttal.to && speakerIdx >= 0 && targetIdx >= 0 && speakerIdx !== targetIdx) {
    var fromPt = BR.seatPointFor(speakerIdx, total);
    var toPt = BR.seatPointFor(targetIdx, total);
    html += '<svg class="round-arrows" data-from-idx="' + speakerIdx + '" data-to-idx="' + targetIdx + '" data-total="' + total + '" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><defs><marker id="rt-head" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 Z" fill="#e8a33d" /></marker></defs><line class="round-arrow-line" x1="' + fromPt.x + '" y1="' + fromPt.y + '" x2="' + toPt.x + '" y2="' + toPt.y + '" stroke="#e8a33d" stroke-width="1.5" vector-effect="non-scaling-stroke" marker-end="url(#rt-head)" /></svg>';
  }
  state.advisors.forEach(function (a, idx) {
    var found = BR.latestCardFor(state, a.id);
    var card = found ? found.card : null;
    var final = state.final[a.id];
    var speaking = speakingId === a.id;
    var pt = BR.seatPointFor(idx, total);
    var cls = "stage-seat";
    var style = "--seat-color:" + BR.esc(a.color) + ";";
    if (speaking) {
      cls += " speaking";
      if (rebuttal && rebuttal.from && rebuttal.from.id === a.id && targetIdx >= 0) {
        var vec = BR.leanVectorFor(speakerIdx, targetIdx, total);
        if (vec) {
          cls += " lean-toward";
          style += "--lean-dx:" + vec.dx + "px;--lean-dy:" + vec.dy + "px;";
        }
      }
    }
    else if (speakingId) { cls += " dim"; }
    /* Look direction: the speaker faces its target, and every idle
       seat turns slightly toward the speaker, so the room reads as
       listening instead of staring straight ahead. Lean stays a
       separate seat-level translation. */
    var look = "";
    if (speaking) {
      if (targetIdx >= 0) { look = BR.lookDirectionFor(speakerIdx, targetIdx, total); }
    } else if (speakingId && speakerIdx >= 0) {
      look = BR.lookDirectionFor(idx, speakerIdx, total);
    }
    if (look) { cls += " look-" + look; }
    if (speakingId && rebuttal && rebuttal.to && rebuttal.to.id === a.id) { cls += " addressed"; }
    if (pt.y < 50) { cls += " card-below"; }
    var weight = state.director && state.director.weights[a.id] ? state.director.weights[a.id] : null;
    html += '<div class="round-seat" style="left:' + pt.x.toFixed(2) + '%;top:' + pt.y.toFixed(2) + '%;">';
    html += '<div class="' + cls + '" data-seat-id="' + BR.esc(a.id) + '" tabindex="0" role="button" aria-label="Focus ' + BR.esc(a.short) + '" style="' + style + '">';
    html += '<span class="thumb-wrap">' + BR.avatarThumb(a, speaking ? "large talking" : "large idle");
    if (final) {
      html += '<span class="vote-stamp ' + BR.voteStampClass(final.vote) + '">' + BR.esc(BR.voteStampText(final.vote)) + '</span>';
    }
    html += '</span>';
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
    html += '<div class="seat-card"><strong>' + BR.esc(a.short) + '</strong>';
    html += '<span>' + BR.esc(a.pillar) + '</span>';
    if (weight) {
      html += '<span>Weight ' + BR.esc(weight.weight) + ' / 3: ' + BR.esc(weight.reason) + '</span>';
    } else {
      html += '<span>Weight not set yet.</span>';
    }
    html += '</div>';
    html += '</div></div>';
  });
  html += '</div>';
  if (rebuttal && rebuttal.from && rebuttal.to) {
    html += '<div class="rebuttal-strip" data-from="' + BR.esc(rebuttal.from.id) + '" data-to="' + BR.esc(rebuttal.to.id) + '">';
    var verb = (rebuttal.kind === "discussion") ? "answers" : "rebuts";
    html += '<span>' + BR.esc(rebuttal.from.short) + ' ' + verb + ' ' + BR.esc(rebuttal.to.short) + '</span></div>';
  }
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
  html += '<h3>Chair weights</h3><div class="table-scroll"><table class="weights-table"><thead><tr><th>Seat</th><th>Weight</th><th>Reason</th></tr></thead><tbody>';
  state.advisors.forEach(function (a) {
    var w = state.director.weights[a.id] ? state.director.weights[a.id] : { weight: 1, reason: "General relevance." };
    html += '<tr><td>' + BR.esc(a.short) + '</td><td>' + BR.esc(w.weight) + ' / 3</td><td>' + BR.esc(w.reason) + '</td></tr>';
  });
  html += '</tbody></table></div>';
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
      html += '<div class="tx-entry tx-director" data-speaker="director" data-kind="' + BR.esc(t.kind) + '"><div class="tx-head"><span class="tx-speaker">Director</span>';
      html += '<span class="tx-kind">' + BR.esc(t.title) + '</span>' + BR.servedBadgeFor(state, t.stepKey) + '</div>';
      html += '<div class="tx-body">' + BR.esc(t.body) + '</div></div>';
    } else {
      var adv = BR.advisorByShort(state, t.speaker);
      var speakerId = adv ? adv.id : "";
      var displayTo = (t.kind === "discussion" && typeof BR.displayDiscussionTarget === "function")
        ? BR.displayDiscussionTarget(state, t)
        : (t.answerTo || "");
      html += '<div class="tx-entry tx-advisor" data-speaker="' + BR.esc(speakerId) + '" data-kind="' + BR.esc(t.kind) + '" data-answer-to="' + BR.esc(displayTo) + '" data-disagree-with="' + BR.esc(t.disagreeWith || "") + '">';
      if (adv) { html += BR.avatarThumb(adv, ""); }
      html += '<div class="tx-content"><div class="tx-head"><span class="tx-speaker">' + BR.esc(t.speaker) + '</span>';
      html += '<span class="tx-kind">' + BR.esc(t.title) + '</span>' + BR.servedBadgeFor(state, t.stepKey) + '</div>';
      html += '<div class="tx-body">' + BR.esc(t.body) + '</div>';
      if (t.disagreeWith) {
        html += '<div class="tx-rebuts">Rebuts ' + BR.esc(t.disagreeWith) + '</div>';
      }
      /* Weak point and concession are separate lines, each shown
         only when the card actually carries it. A card with no
         concession shows no concession line, never an invented one. */
      if (t.kind === "discussion" && t.answerTo) {
        html += '<div class="tx-rebuts">Answers ' + BR.esc(displayTo) + ' (' + BR.esc(t.agree || "") + ' on: ' + BR.esc(t.pointAnswered || "") + ')</div>';
        if (t.steelman) {
          html += '<div class="tx-rebuts">Steelman: ' + BR.esc(t.steelman) + '</div>';
        }
        if (t.weakPoint) {
          html += '<div class="tx-rebuts">Weak point: ' + BR.esc(t.weakPoint) + '</div>';
        }
        if (t.concede) {
          html += '<div class="tx-rebuts">Concedes: ' + BR.esc(t.concede) + '</div>';
        }
        if (t.costOfBeingWrong || t.evidenceDemanded) {
          html += '<div class="tx-rebuts">Cost if wrong: ' + BR.esc(t.costOfBeingWrong || "") + ' &middot; Settles it: ' + BR.esc(t.evidenceDemanded || "") + '</div>';
        }
      } else if (t.concede) {
        html += '<div class="tx-rebuts">Concedes: ' + BR.esc(t.concede) + '</div>';
      }
      html += '</div></div>';
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
   the scorecard table after the verdict. Weighted maths live on the
   verdict sheet, not here. */
BR.renderKeyPoints = function (container, state) {
  if (state.verdict) {
    var v = state.verdict;
    var html = '<div class="table-scroll"><table class="score-table"><thead><tr><th>Seat</th><th>Weight</th><th>Final stance</th><th>Pillar</th><th>Line</th></tr></thead><tbody>';
    state.advisors.forEach(function (a) {
      var w = state.director.weights[a.id] ? state.director.weights[a.id].weight : 1;
      var latest = BR.latestCardFor(state, a.id);
      var f = state.final[a.id];
      html += '<tr><td>' + BR.esc(a.short) + '</td><td>' + BR.esc(w) + '</td>';
      html += '<td>' + BR.esc(latest ? latest.card.stance : "") + '</td>';
      html += '<td>' + BR.esc(v.pillarScores[a.id]) + '/10</td>';
      html += '<td>' + BR.esc(f ? f.line : "") + '</td></tr>';
    });
    html += '</tbody></table></div>';
    container.innerHTML = html;
    return;
  }
  var items = "";
  state.advisors.forEach(function (a) {
    var found = BR.latestCardFor(state, a.id);
    var card = found ? found.card : null;
    var weight = state.director && state.director.weights[a.id] ? state.director.weights[a.id] : null;
    items += '<div class="kp-item" data-seat-id="' + BR.esc(a.id) + '">' + BR.avatarThumb(a, "") + '<div class="kp-content">';
    items += '<div class="kp-head"><span class="kp-name">' + BR.esc(a.short) + '</span>';
    items += '<span class="kp-weight">Weight ' + BR.esc(weight ? weight.weight : "-") + ' / 3</span></div>';
    if (weight && weight.reason) {
      items += '<div class="kp-weight-reason">' + BR.esc(weight.reason) + '</div>';
    }
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

/* Draft resolution panel: its own stage between Debate and Vote. */
BR.renderDraft = function (container, state) {
  if ((state.mode || "full") === "quick") {
    container.innerHTML = '<p class="muted">Quick mode skips the draft resolution stage. The vote runs on the leading option from the openings.</p>';
    return;
  }
  if (!state.draft) {
    container.innerHTML = '<p class="muted">The draft resolution appears here after the debate.</p>';
    return;
  }
  var d = state.draft;
  var html = '<p class="draft-rec">Recommend option ' + BR.esc(state.verdictDraftId) + ' ' + BR.esc(BR.optionLabelOf(state, state.verdictDraftId)) + '.</p>';
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
  if (d.revisit) { html += '<p><strong>Revisit:</strong> ' + BR.esc(d.revisit) + '</p>'; }
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
  container.innerHTML = html;
};

/* Verdict sheet: label and call, option bars with weighted maths,
   stats, why it won, pillar scorecard with fixes, draft content,
   overrides, minority, then a collapsible full detail section. */
BR.renderVerdict = function (container, state) {
  if (!state.verdict) {
    container.innerHTML = '<p class="muted">The verdict appears here after the final vote.</p>';
    return;
  }
  var v = state.verdict;
  var d = state.draft;
  var html = '<div class="verdict-label">' + BR.esc(v.label) + '</div>';
  html += '<p class="verdict-call">Option ' + BR.esc(v.recommendedId) + ' ' + BR.esc(BR.optionLabelOf(state, v.recommendedId)) + ', scoring ' + BR.esc(v.recommendedScore) + '/10.</p>';
  html += '<div class="option-bars">';
  state.options.forEach(function (o) {
    var score = v.optionScores[o.id].score;
    html += '<div class="option-row"><div class="option-row-label">Option ' + BR.esc(o.id) + ' ' + BR.esc(o.label) + ': ' + BR.esc(score) + '/10</div>';
    html += '<div class="option-bar"><div class="option-bar-fill" style="width:' + BR.esc(score * 10) + '%"></div></div></div>';
  });
  html += '</div>';
  html += '<div class="math-lines">';
  state.options.forEach(function (o) {
    html += '<div>' + BR.esc(v.optionScores[o.id].math) + '</div>';
  });
  html += '</div>';
  html += '<div class="verdict-stats">';
  html += '<span>Support ' + BR.esc(v.support) + '/10</span><span>Confidence ' + BR.esc(v.confidence) + '/10</span>';
  html += '<span>Spread ' + BR.esc(v.spread) + '</span>';
  html += '<span>Vote: ' + BR.esc(v.votes.endorse) + ' endorse, ' + BR.esc(v.votes.amend) + ' amend, ' + BR.esc(v.votes.dissent) + ' dissent</span>';
  html += '</div>';
  if (v.topReasons && v.topReasons.length > 0) {
    html += '<h3>Why it won</h3><ol>';
    v.topReasons.forEach(function (r) {
      html += '<li><strong>' + BR.esc(r.short) + '</strong> (pillar ' + BR.esc(r.pillarScore) + '/10): ' + BR.esc(r.reason) + '</li>';
    });
    html += '</ol>';
  }
  html += '<h3>Pillar scorecard</h3><div class="table-scroll"><table class="score-table"><thead><tr><th>Seat</th><th>Dimension</th><th>Pillar</th></tr></thead><tbody>';
  state.advisors.forEach(function (a) {
    html += '<tr><td>' + BR.esc(a.short) + '</td><td>' + BR.esc(a.dimension) + '</td><td>' + BR.esc(v.pillarScores[a.id]) + '/10</td></tr>';
  });
  html += '</tbody></table></div>';
  if (v.pillarFixes && v.pillarFixes.length > 0) {
    html += '<h3>Pillar fixes</h3><ul>';
    v.pillarFixes.forEach(function (f) {
      html += '<li><strong>' + BR.esc(f.dimension) + '</strong> scores ' + BR.esc(f.score) + '/10 (' + BR.esc(f.short) + '). Fix: ' + BR.esc(f.line) + '</li>';
    });
    html += '</ul>';
  }
  if (d) {
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
    if (d.revisit) { html += '<p><strong>Revisit:</strong> ' + BR.esc(d.revisit) + '</p>'; }
    if (d.waitFor) { html += '<p><strong>Wait trigger:</strong> ' + BR.esc(d.waitFor) + '</p>'; }
  } else {
    html += '<p class="muted">Quick mode skips the draft resolution stage, so there are no conditions, next steps, cheapest test, or kill criteria.</p>';
  }
  if (v.overrides.length > 0) {
    html += '<div class="overrides">';
    v.overrides.forEach(function (o) { html += '<div>Override: ' + BR.esc(o) + '</div>'; });
    html += '</div>';
  }
  if (v.minority) {
    html += '<h3>Minority report</h3><p>' + BR.esc(v.minority.short) + ' dissented: ' + BR.esc(v.minority.reason) + '</p>';
  }
  html += '<details><summary>Full detail</summary>';
  if (d && d.risks.length > 0) {
    html += '<h3>Hidden risks</h3><ul>';
    d.risks.forEach(function (r) { html += '<li>' + BR.esc(r) + '</li>'; });
    html += '</ul>';
  }
  if (d && d.tradeoffs.length > 0) {
    html += '<h3>Explicit trade-offs</h3><ul>';
    d.tradeoffs.forEach(function (t) { html += '<li>' + BR.esc(t) + '</li>'; });
    html += '</ul>';
  }
  if (v.amendments && v.amendments.length > 0) {
    html += '<h3>Ratification</h3><p class="muted">Amendments from endorsing seats are carried when the resolution passes; dissenting amendments go to the minority report.</p><ul>';
    v.amendments.forEach(function (am) {
      html += '<li><strong>' + BR.esc(am.short) + '</strong> (' + BR.esc(am.vote) + '): ' + BR.esc(am.amendment) + ' [' + (am.adopted ? 'Adopted' : 'Not adopted') + '] ' + BR.esc(am.reason) + '</li>';
    });
    html += '</ul>';
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
  html += '</details>';
  html += '<p class="muted sim-note">Advisors on this board are AI simulations inspired by public frameworks. They are not the real people and do not speak for them.</p>';
  container.innerHTML = html;
};

/* Consult answer: one seat, one prose answer, no scores. */
BR.renderConsult = function (container, consult) {
  if (!consult || !consult.advisor) {
    container.innerHTML = '<p class="muted">No consult answer yet.</p>';
    return;
  }
  var a = consult.advisor;
  var html = '<div class="consult-head">' + BR.avatarThumb(a, "") + '<div><strong>' + BR.esc(a.short) + '</strong>';
  html += '<div class="muted">' + BR.esc(a.pillar) + '</div></div></div>';
  html += '<p class="consult-question">' + BR.esc(consult.question) + '</p>';
  if (consult.servedBy) { html += '<div>' + BR.providerBadge(consult.servedBy) + '</div>'; }
  if (consult.answer) {
    html += '<div class="consult-answer">';
    consult.answer.split(/\n+/).forEach(function (para) {
      if (para.trim()) { html += '<p>' + BR.esc(para.trim()) + '</p>'; }
    });
    html += '</div>';
  } else {
    html += '<p class="muted">Waiting for the answer.</p>';
  }
  container.innerHTML = html;
};

BR.renderHistory = function (container, sessions) {
  if (!sessions || sessions.length === 0) {
    container.innerHTML = '<p class="muted">No past debates yet. Completed debates are saved here automatically.</p>';
    return;
  }
  var html = "";
  sessions.forEach(function (s) {
    var modeLabel = s.mode === "quick" ? "Quick" : "Full debate";
    html += '<button class="history-item" data-session-id="' + BR.esc(s.id) + '">';
    html += '<span class="history-title">' + BR.esc(s.title) + '</span>';
    html += '<span class="history-meta">' + BR.esc(BR.formatHistoryDate(s.createdAt)) + ' &middot; ' + modeLabel + ' &middot; ' + BR.esc(s.provider) + ' &middot; ' + BR.esc(s.rounds) + ' rounds</span>';
    html += '</button>';
  });
  container.innerHTML = html;
};
