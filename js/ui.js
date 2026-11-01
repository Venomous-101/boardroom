/* Boardroom UI rendering: the conversation room.
   Every dynamic string passes through BR.esc before it reaches innerHTML.
   No user text and no model text is ever inserted unescaped.
   Characters come from a fixed look table keyed by seat id, never
   from user input, and are inline SVG, never photos of real people.
   Animation is CSS plus GSAP one-shots, in five states per seat
   (idle, thinking, speaking, listening, reacting): thinking bubble
   and ponder tilt during a model wait, visible lift and head tilt
   with a moving mouth on the face during speech, idle breathing and
   blink, hover lift with a seat card, click to focus, spotlight,
   and an animated dashed interaction arc with a rebuttal strip.
   Reduced motion is honored in styles.css. */

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

/* Vote stamp on a figure: ENDORSE (green), AMEND (amber), DISSENT (red). */
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

/* Animated SVG characters, one per seat. Full cartoon figures:
   legs, torso, two arms with hands, neck, and a head group
   that turns, eyes that blink, a mouth that moves with speech, and
   a gesture arm. Each seat gets a distinct look (skin, hair, top,
   accessory, brows) from a fixed table, never from user input, so
   no seat can be confused with another. Motion is split cleanly:
   CSS keyframes drive the loops (blink, breathing, thinking tilt,
   listening turn, speaking head and arm loops), while GSAP, when
   the CDN loaded, drives one-shot motion (per-word mouth, speaking
   arm gesture, panel entrance). The two never fight: GSAP owns only
   the gesture arm and the mouth, CSS owns everything else, and the
   page adds a gsap-on class to the body when GSAP is present so the
   CSS speaking loops stand down. Any other id (including the
   custom advisor) falls back to initials with no face, so it never
   wears a floating mouth. */
BR.CHAR_LOOK = {
  operator: { skin: "#e8c39a", hair: "#2b2118", hairStyle: "short", accessory: "tie", top: "shirt", brows: "flat" },
  offer: { skin: "#f2c9a0", hair: "#d9a441", hairStyle: "bold", accessory: "none", top: "tee", brows: "arched" },
  investor: { skin: "#e6b98d", hair: "#9aa7b4", hairStyle: "sides", accessory: "glasses", top: "jacket", brows: "flat" },
  marketer: { skin: "#c98d5f", hair: "#1f160e", hairStyle: "curly", accessory: "headset", top: "tee", brows: "arched" },
  philosopher: { skin: "#e8c39a", hair: "#3a2c1c", hairStyle: "bald", accessory: "beard", top: "shirt", brows: "flat" },
  founder: { skin: "#f0cfa8", hair: "#333333", hairStyle: "cap", accessory: "none", top: "jacket", brows: "arched" },
  saas: { skin: "#d9a06b", hair: "#26221e", hairStyle: "buzz", accessory: "badge", top: "shirt", brows: "flat" },
  eos: { skin: "#e8c39a", hair: "#1f160e", hairStyle: "long", accessory: "scarf", top: "tee", brows: "arched" }
};

BR.charHairFor = function (look) {
  var h = look.hair;
  if (look.hairStyle === "short") { return '<path d="M34 42 Q34 14 60 14 Q86 14 86 42 Q80 26 60 26 Q40 26 34 42 Z" fill="' + h + '"/>'; }
  if (look.hairStyle === "bold") { return '<path d="M32 44 Q30 10 60 10 Q90 10 88 44 Q82 24 60 24 Q38 24 32 44 Z" fill="' + h + '"/>'; }
  if (look.hairStyle === "sides") { return '<path d="M34 34 Q32 22 40 20 L40 34 Z" fill="' + h + '"/><path d="M86 34 Q88 22 80 20 L80 34 Z" fill="' + h + '"/>'; }
  if (look.hairStyle === "curly") { return '<circle cx="42" cy="22" r="8" fill="' + h + '"/><circle cx="60" cy="15" r="9" fill="' + h + '"/><circle cx="78" cy="22" r="8" fill="' + h + '"/>'; }
  if (look.hairStyle === "cap") { return '<path d="M34 36 Q34 12 60 12 Q86 12 86 36 Z" fill="' + h + '"/><ellipse cx="60" cy="35" rx="28" ry="5" fill="' + h + '"/>'; }
  if (look.hairStyle === "buzz") { return '<path d="M36 36 Q36 18 60 18 Q84 18 84 36 Q78 26 60 26 Q42 26 36 36 Z" fill="' + h + '"/>'; }
  if (look.hairStyle === "long") { return '<rect x="32" y="24" width="9" height="34" rx="4" fill="' + h + '"/><rect x="79" y="24" width="9" height="34" rx="4" fill="' + h + '"/>'; }
  return "";
};

BR.charBrowFor = function (look) {
  if (look.brows === "arched") {
    return '<path d="M44 33 Q49 29 54 33" fill="none" stroke="#14100a" stroke-width="1.8" stroke-linecap="round"/><path d="M66 33 Q71 29 76 33" fill="none" stroke="#14100a" stroke-width="1.8" stroke-linecap="round"/>';
  }
  return '<line x1="44" y1="32" x2="54" y2="32" stroke="#14100a" stroke-width="1.8" stroke-linecap="round"/><line x1="66" y1="32" x2="76" y2="32" stroke="#14100a" stroke-width="1.8" stroke-linecap="round"/>';
};

/* Face accessories first, body accessories second: glasses, headset,
   and beard sit on the face, while tie, badge, and scarf sit on the
   torso. The beard draws before the mouth, so the mouth stays
   visible on top of it. */
BR.charFaceAccessoryFor = function (look) {
  if (look.accessory === "glasses") { return '<g fill="none" stroke="#14100a" stroke-width="2"><circle cx="50" cy="42" r="7"/><circle cx="70" cy="42" r="7"/><line x1="57" y1="42" x2="63" y2="42"/></g>'; }
  if (look.accessory === "headset") { return '<g fill="none" stroke="#14100a" stroke-width="2.5" stroke-linecap="round"><path d="M36 40 Q36 12 60 12 Q84 12 84 40"/><line x1="84" y1="40" x2="78" y2="54"/><circle cx="76" cy="56" r="3" fill="#14100a" stroke="none"/></g>'; }
  if (look.accessory === "beard") { return '<path d="M38 48 Q36 66 50 74 Q60 78 70 74 Q84 66 82 48 Q76 62 60 62 Q44 62 38 48 Z" fill="' + look.hair + '"/>'; }
  return "";
};

BR.charBodyAccessoryFor = function (look, color) {
  if (look.accessory === "tie") { return '<polygon points="60,88 54,100 60,126 66,100" fill="#14100a"/>'; }
  if (look.accessory === "badge") { return '<circle cx="78" cy="102" r="6" fill="#e8ecf1"/><circle cx="78" cy="102" r="2.5" fill="' + color + '"/>'; }
  if (look.accessory === "scarf") { return '<rect x="40" y="80" width="40" height="9" rx="4" fill="#e8ecf1"/><rect x="66" y="88" width="8" height="14" rx="3" fill="#e8ecf1"/>'; }
  return "";
};

BR.charTopFor = function (look) {
  if (look.top === "shirt") { return '<path d="M50 86 L60 96 L70 86" fill="none" stroke="#14100a" stroke-width="2.5" stroke-linecap="round"/><circle cx="60" cy="108" r="2" fill="#14100a"/><circle cx="60" cy="122" r="2" fill="#14100a"/>'; }
  if (look.top === "jacket") { return '<polygon points="48,86 60,108 52,152" fill="rgba(0,0,0,0.20)"/><polygon points="72,86 60,108 68,152" fill="rgba(0,0,0,0.20)"/><line x1="60" y1="96" x2="60" y2="150" stroke="#14100a" stroke-width="2"/>'; }
  return '<path d="M50 86 Q60 96 70 86" fill="none" stroke="#14100a" stroke-width="2.5" stroke-linecap="round"/>';
};

/* Deterministic blink delay per seat, so the room does not blink in
   unison. Derived from the seat id only, no clock or randomness. */
BR.blinkDelayFor = function (id) {
  var sum = 0;
  for (var i = 0; i < id.length; i++) { sum += id.charCodeAt(i); }
  return ((sum % 46) / 10).toFixed(1);
};

/* One animated character figure. Large (72 by 120px) on the stage,
   small (30 by 50px) in the transcript, key points, and consult
   panels. The full body reads at a glance: legs and shoes, torso in
   the seat color with its top style, two arms with hands, neck, and
   a head with hair, brows, eyes, nose, and a mouth that sits on the
   face inside the SVG, so it can never float off it. */
BR.characterFigure = function (a, cls) {
  var look = BR.CHAR_LOOK[a.id];
  if (!look) {
    return '<span class="char-figure ' + (cls || "") + '"><span class="char-initials" style="background:' + BR.esc(a.color) + '">' + BR.esc(a.initials) + '</span></span>';
  }
  var color = BR.esc(a.color);
  var skin = look.skin;
  var svg = '<svg class="char-svg" viewBox="0 0 120 200" aria-hidden="true">';
  svg += '<g class="char-arm"><path d="M36 90 Q28 110 30 132" stroke="' + color + '" stroke-width="11" stroke-linecap="round" fill="none"/><circle cx="30" cy="138" r="6" fill="' + skin + '"/></g>';
  svg += '<g class="char-legs"><rect x="46" y="150" width="12" height="40" rx="4" fill="#232a33"/><rect x="62" y="150" width="12" height="40" rx="4" fill="#232a33"/><ellipse cx="52" cy="192" rx="9" ry="5" fill="#14100a"/><ellipse cx="68" cy="192" rx="9" ry="5" fill="#14100a"/></g>';
  svg += '<g class="char-torso"><path d="M36 88 Q60 80 84 88 L84 152 Q60 158 36 152 Z" fill="' + color + '"/>' + BR.charTopFor(look) + BR.charBodyAccessoryFor(look, color) + '</g>';
  svg += '<g class="char-arm char-arm-g"><path d="M84 90 Q96 104 92 128" stroke="' + color + '" stroke-width="11" stroke-linecap="round" fill="none"/><circle cx="92" cy="134" r="6" fill="' + skin + '"/></g>';
  svg += '<rect x="54" y="66" width="12" height="20" fill="' + skin + '"/>';
  svg += '<g class="char-head">';
  svg += '<circle cx="34" cy="44" r="5" fill="' + skin + '"/><circle cx="86" cy="44" r="5" fill="' + skin + '"/>';
  svg += '<ellipse cx="60" cy="44" rx="26" ry="28" fill="' + skin + '"/>';
  svg += BR.charHairFor(look);
  svg += BR.charFaceAccessoryFor(look);
  svg += BR.charBrowFor(look);
  svg += '<g class="char-eyes"><circle cx="50" cy="42" r="3" fill="#14100a"/><circle cx="70" cy="42" r="3" fill="#14100a"/><circle cx="51" cy="41" r="1" fill="#fff"/><circle cx="71" cy="41" r="1" fill="#fff"/></g>';
  svg += '<path d="M60 46 Q58 52 60 54" fill="none" stroke="#14100a" stroke-width="1.4" stroke-linecap="round"/>';
  svg += '<ellipse class="char-mouth" cx="60" cy="62" rx="8" ry="3" fill="#7c2a2a"/>';
  svg += '</g></svg>';
  return '<span class="char-figure ' + (cls || "") + '" style="--blink-delay:' + BR.blinkDelayFor(a.id) + 's">' + svg + '</span>';
};

/* Mouth state classes, as literals, for the same audit reason. */
BR.MOUTH_STATE_CLASS = { "mouth-closed": "char-mouth-closed", "mouth-mid": "char-mouth-mid", "mouth-open": "char-mouth-open" };
BR.MOUTH_STATE_SCALE = { "mouth-closed": 0.15, "mouth-mid": 0.6, "mouth-open": 1 };

/* Move one figure's mouth to a word state. With GSAP present, a
   short one-shot tween scales the mouth and the matching CSS class
   is set too, so class and tween always agree; without GSAP the
   class alone sets the same scale. Classes are always cleared
   first, so a GSAP tween and a CSS class never fight over the same
   mouth. A null state resets the mouth: it kills any in-flight
   tween and clears the inline transform, so a stopped playback
   never freezes a mouth open. */
BR.charMouth = function (figureEl, mouthClass) {
  if (!figureEl) { return; }
  var mouth = figureEl.querySelector(".char-mouth");
  ["char-mouth-closed", "char-mouth-mid", "char-mouth-open"].forEach(function (c) { figureEl.classList.remove(c); });
  if (typeof window !== "undefined" && window.gsap && mouth) { window.gsap.killTweensOf(mouth); }
  if (!mouthClass) {
    if (mouth) { mouth.style.transform = ""; }
    return;
  }
  var target = BR.MOUTH_STATE_CLASS[mouthClass] || "char-mouth-closed";
  figureEl.classList.add(target);
  if (typeof window !== "undefined" && window.gsap && mouth) {
    window.gsap.to(mouth, { scaleY: BR.MOUTH_STATE_SCALE[mouthClass] || 0.15, duration: 0.12, transformOrigin: "50% 50%" });
  }
};

/* One-shot speaking arm gesture. GSAP only: a short raise and fall
   of the front gesture arm when a line starts speaking. Without
   GSAP the CSS speaking loop carries the arm instead, so this is
   never called unless GSAP loaded. */
BR.charGesture = function (figureEl) {
  if (!figureEl || typeof window === "undefined" || !window.gsap) { return; }
  var arm = figureEl.querySelector(".char-arm-g");
  if (!arm) { return; }
  /* svgOrigin, not transformOrigin: the shoulder sits at viewBox
     point (84, 90), and a px transformOrigin on SVG is ambiguous
     across GSAP's bbox handling, which could swing the arm around
     a point far outside the figure. svgOrigin pins the pivot to
     the shoulder exactly. */
  window.gsap.fromTo(arm, { rotation: 0, svgOrigin: "84 90" }, { rotation: -32, duration: 0.35, yoyo: true, repeat: 1, ease: "sine.inOut" });
};

/* Live character states. Exactly one per seat at a time, enforced by
   construction: the map holds one value per seat id, and an unknown
   state is ignored, never stored. Order is the life of a line:
   idle, then thinking while its model call is in flight, then
   speaking while its line reveals word by word, then listening
   while another seat speaks (addressed is a listening seat that
   was answered or rebutted, a modifier, not a sixth state). A
   reaction (nod or shake) is a transient animation on the figure
   wrapper during playback, not a second state, so the map never
   holds two states for one seat. "reacting" stays a valid value
   for charStateFor validation, but the page never renders it. */
BR.CHAR_STATES = ["idle", "thinking", "speaking", "listening", "reacting"];

BR.charStateFor = function (charStates, seatId) {
  if (!charStates || BR.CHAR_STATES.indexOf(charStates[seatId]) === -1) { return "idle"; }
  return charStates[seatId];
};

/* One state per seat for a whole board, from the two live ids the
   page tracks: the seat whose call is in flight thinks, the seat
   whose line is revealing speaks, every other seat listens while
   either is live, and every seat is idle when neither is. A seat is
   never both thinking and speaking. */
BR.charStatesFor = function (advisors, thinkingId, speakingId) {
  var out = {};
  advisors.forEach(function (a) {
    if (thinkingId && a.id === thinkingId) { out[a.id] = "thinking"; }
    else if (speakingId && a.id === speakingId) { out[a.id] = "speaking"; }
    else if (thinkingId || speakingId) { out[a.id] = "listening"; }
    else { out[a.id] = "idle"; }
  });
  return out;
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
  return { x: 50 + 42 * Math.cos(rad), y: 50 + 37 * Math.sin(rad) };
};

/* Lean toward the addressed seat as a real vector on the table, not
   just left or right: the unit direction from the speaker's point to
   the target's point, scaled to 14 pixels. Same seat or no target:
   no lean. */
BR.leanVectorFor = function (speakerIndex, targetIndex, total) {
  if (speakerIndex === null || speakerIndex === undefined ||
      targetIndex === null || targetIndex === undefined || speakerIndex === targetIndex) { return null; }
  var from = BR.seatPointFor(speakerIndex, total);
  var to = BR.seatPointFor(targetIndex, total);
  var dx = to.x - from.x;
  var dy = to.y - from.y;
  var len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) { return null; }
  return { dx: Math.round((dx / len) * 20), dy: Math.round((dy / len) * 20) };
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


/* Data-driven reaction for the ADDRESSED seat after a line, never
   for the speaker and never from tone. A final vote decides it when
   one exists: endorse or endorse with amendment nods, dissent
   shakes. Before any final vote, the addressed seat nods only when
   its latest card recommends the same option the speaker just
   argued for; any other combination gives no reaction at all.
   This replaces the old speaker-reaction helper: Ali's live check
   showed reactions must read on the seat being answered, not on
   the seat that just spoke. */
BR.targetReactionFor = function (speakerOptionId, targetOptionId, targetVote) {
  if (targetVote === "Dissent") { return "shake"; }
  if (targetVote === "Endorse" || targetVote === "Endorse with amendment") { return "nod"; }
  if (targetVote) { return ""; }
  if (speakerOptionId && targetOptionId && speakerOptionId === targetOptionId) { return "nod"; }
  return "";
};

/* Animated interaction arc in pixels for a stage box of the given
   size: a quadratic curve from the speaker's seat EDGE to the
   target's seat edge, bowed a third of the way toward the table
   centre so it reads as an arc across the table, not a straight
   ruler line. Endpoints stop at the seat edge, never at the seat
   centre, because the seats sit above the SVG and would hide the
   arrowhead. The inset is capped at 80px and at 30 percent of the
   seat distance, so short chords still show an arc. Returns null
   for a missing or identical pair. The page sizes the SVG to the
   real stage box after render, so the arc keeps its shape at any
   stage width. */
BR.arcPathFor = function (fromIndex, toIndex, total, width, height) {
  if (fromIndex === null || fromIndex === undefined ||
      toIndex === null || toIndex === undefined || fromIndex === toIndex ||
      !width || !height) { return null; }
  var from = BR.seatPointFor(fromIndex, total);
  var to = BR.seatPointFor(toIndex, total);
  var x1 = (from.x / 100) * width, y1 = (from.y / 100) * height;
  var x2 = (to.x / 100) * width, y2 = (to.y / 100) * height;
  var dx = x2 - x1, dy = y2 - y1;
  var dist = Math.sqrt(dx * dx + dy * dy);
  if (!dist) { return null; }
  var inset = Math.min(80, dist * 0.3);
  var ux = dx / dist, uy = dy / dist;
  var sx = Math.round(x1 + ux * inset), sy = Math.round(y1 + uy * inset);
  var tx = Math.round(x2 - ux * inset), ty = Math.round(y2 - uy * inset);
  var mx = (sx + tx) / 2, my = (sy + ty) / 2;
  var cx = Math.round(mx + (width / 2 - mx) * 0.35);
  var cy = Math.round(my + (height / 2 - my) * 0.35);
  return "M " + sx + " " + sy + " Q " + cx + " " + cy + " " + tx + " " + ty;
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

BR.renderStage = function (container, state, speakingId, rebuttal, charStates) {
  var total = state.advisors.length;
  var speakerIdx = -1;
  var targetIdx = -1;
  state.advisors.forEach(function (a, i) {
    if (a.id === speakingId) { speakerIdx = i; }
    if (rebuttal && rebuttal.to && a.id === rebuttal.to.id) { targetIdx = i; }
  });
  var speakingAdv = speakerIdx >= 0 ? state.advisors[speakerIdx] : null;
  /* A live seat, thinking or speaking, spotlights the room. The
     old code spotlit only on speakingId, so listeners never dimmed
     during a model wait even though their state was listening. */
  var hasLive = !!speakingId;
  if (!hasLive && charStates) {
    state.advisors.forEach(function (a) {
      var st = BR.charStateFor(charStates, a.id);
      if (st === "thinking" || st === "speaking") { hasLive = true; }
    });
  }
  /* The arc, the addressed highlight, and the strip belong to the
     CURRENT line only: the rebuttal pair must be the live
     speaker's pair, or a line that rebuts nobody would still show
     the previous speaker's arc and brighten the previous target. */
  var livePair = !!(rebuttal && speakingId && rebuttal.from && rebuttal.from.id === speakingId);
  var html = '<div class="stage-round' + (hasLive ? ' spotlight' : '') + '">';
  /* Centre table: decision title, and the current speaker. The table
     is decorative structure, not a seat, and carries no vote. */
  html += '<div class="round-table"><div class="round-table-title">' + BR.esc(state.title || "The board") + '</div>';
  if (speakingAdv) {
    html += '<div class="round-table-speaker">' + BR.esc(speakingAdv.short) + ' speaking</div>';
  } else {
    html += '<div class="round-table-speaker">The board</div>';
  }
  html += '</div>';
  /* Animated interaction arc across the table, speaker to target,
     shown only while a line is live (speakingId set). The path
     starts in the same percent coordinates as the seats, and the
     page then repositions it in pixels for the real stage box (see
     positionArrows in main.js), so the arc keeps its shape on any
     stage width instead of stretching. The text strip below
     repeats it in words for screen readers and for plain text. */
  if (livePair && rebuttal.to && speakerIdx >= 0 && targetIdx >= 0 && speakerIdx !== targetIdx) {
    var arcD = BR.arcPathFor(speakerIdx, targetIdx, total, 100, 100) || "";
    html += '<svg class="round-arrows" data-from-idx="' + speakerIdx + '" data-to-idx="' + targetIdx + '" data-total="' + total + '" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><defs><marker id="rt-head" markerWidth="14" markerHeight="14" refX="12" refY="7" orient="auto"><path d="M0,0 L14,7 L0,14 Z" fill="#e8a33d" /></marker></defs><path class="round-arrow-line" d="' + arcD + '" fill="none" stroke="#e8a33d" stroke-width="3" vector-effect="non-scaling-stroke" marker-end="url(#rt-head)" /></svg>';
  }
  state.advisors.forEach(function (a, idx) {
    var found = BR.latestCardFor(state, a.id);
    var card = found ? found.card : null;
    var final = state.final[a.id];
    var speaking = speakingId === a.id;
    var seatState = charStates
      ? BR.charStateFor(charStates, a.id)
      : (speaking ? "speaking" : (speakingId ? "listening" : "idle"));
    var pt = BR.seatPointFor(idx, total);
    var cls = "stage-seat state-" + seatState;
    var style = "--seat-color:" + BR.esc(a.color) + ";";
    if (seatState === "speaking") {
      cls += " speaking";
      if (rebuttal && rebuttal.from && rebuttal.from.id === a.id && targetIdx >= 0) {
        var vec = BR.leanVectorFor(speakerIdx, targetIdx, total);
        if (vec) {
          cls += " lean-toward";
          style += "--lean-dx:" + vec.dx + "px;--lean-dy:" + vec.dy + "px;";
        }
      }
    }
    else if (seatState === "listening" && hasLive) { cls += " dim"; }
    /* Look direction: the speaker faces its target, and every idle
       seat turns visibly toward the live seat, speaker or thinker,
       so the room reads as listening instead of staring straight
       ahead. Lean stays a separate seat-level translation. */
    var liveIdx = speakerIdx;
    if (liveIdx < 0 && charStates) {
      state.advisors.forEach(function (b, j) {
        if (BR.charStateFor(charStates, b.id) === "thinking") { liveIdx = j; }
      });
    }
    var look = "";
    if (speaking) {
      if (targetIdx >= 0) { look = BR.lookDirectionFor(speakerIdx, targetIdx, total); }
    } else if (liveIdx >= 0) {
      look = BR.lookDirectionFor(idx, liveIdx, total);
    }
    if (look) { cls += " look-" + look; }
    if (livePair && rebuttal.to && rebuttal.to.id === a.id) { cls += " addressed"; }
    if (pt.y < 50) { cls += " card-below"; }
    /* Edge seats anchor the hover card to the seat's inner edge, so
       the 190px card never runs past the viewport (see styles.css). */
    if (pt.x < 25) { cls += " card-left"; }
    else if (pt.x > 75) { cls += " card-right"; }
    var weight = state.director && state.director.weights[a.id] ? state.director.weights[a.id] : null;
    html += '<div class="round-seat" style="left:' + pt.x.toFixed(2) + '%;top:' + pt.y.toFixed(2) + '%;">';
    html += '<div class="' + cls + '" data-seat-id="' + BR.esc(a.id) + '" tabindex="0" role="button" aria-label="Focus ' + BR.esc(a.short) + '" style="' + style + '">';
    html += '<span class="thumb-wrap">' + BR.characterFigure(a, speaking ? "large talking" : "large idle");
    if (seatState === "thinking") {
      html += '<span class="think-bubble" aria-hidden="true"><span></span><span></span><span></span></span>';
    }
    if (final) {
      html += '<span class="vote-stamp ' + BR.voteStampClass(final.vote) + '">' + BR.esc(BR.voteStampText(final.vote)) + '</span>';
    }
    html += '</span>';
    html += '<div class="stage-name">' + BR.esc(a.short) + '</div>';
    /* Fixed-height state label, so Thinking and Speaking never push
       the role or status lines down when they appear. */
    html += '<div class="state-label">' + BR.esc(seatState === "thinking" ? "Thinking" : (seatState === "speaking" ? "Speaking" : "")) + '</div>';
    html += '<div class="stage-role">' + BR.esc(a.role) + '</div>';
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
  if (livePair && rebuttal.from && rebuttal.to) {
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
  html += '<h3>Chair weights</h3><p class="weights-line">Chair weights: ' + state.advisors.map(function (a) {
    var w = state.director.weights[a.id] ? state.director.weights[a.id] : { weight: 1, reason: "General relevance." };
    return BR.esc(a.short) + " " + BR.esc(w.weight);
  }).join(" · ") + '</p>';
  html += '<p class="muted">Full weight reasons live in the verdict sheet full detail, so the fault lines stay one quiet line instead of a second competing table.</p>';
  if (state.director.assumptions && state.director.assumptions.length > 0) {
    html += '<p class="muted">Assumptions: ' + state.director.assumptions.map(function (a) { return BR.esc(a); }).join("; ") + '</p>';
  }
  container.innerHTML = html;
};

/* Sharp view for one transcript body: a one-line headline, up to two
   short supporting sentences, and the rest behind an expand control.
   An explicit headline from the model wins; otherwise the first
   sentence is the headline. Everything is cut at sentence
   boundaries, never mid-sentence, and a body of two sentences or
   fewer has no remainder, so short cards render with no control at
   all. Pure presentation: the full text is never altered, only
   split, so playback, copy, and download still read the whole
   body. */
BR.splitSharp = function (body, headline) {
  var text = (body || "").replace(/\s+/g, " ").trim();
  if (!text) { return { headline: "", excerpt: "", rest: "", hasMore: false }; }
  var sentences = text.match(/[^.!?]+[.!?]+["')\]]*/g) || [text];
  sentences = sentences.map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
  function capWords(s, max) {
    if (s.length <= max) { return s; }
    var cut = s.slice(0, max);
    var sp = cut.lastIndexOf(" ");
    return (sp > 40 ? cut.slice(0, sp) : cut).replace(/[,\s]+$/, "") + "...";
  }
  var given = (headline || "").trim();
  var head = given ? capWords(given, 160) : capWords(sentences[0], 160);
  var start = 1;
  if (given && sentences.length > 0) {
    var probe = given.slice(0, 30);
    if (sentences[0].indexOf(probe) === 0 || given.indexOf(sentences[0].slice(0, 30)) === 0) { start = 1; }
    else { start = 0; }
  }
  var parts = [];
  var len = 0;
  var i = start;
  while (i < sentences.length && parts.length < 2 && len + sentences[i].length <= 280) {
    parts.push(sentences[i]);
    len += sentences[i].length;
    i += 1;
  }
  var rest = sentences.slice(i).join(" ");
  return { headline: head, excerpt: parts.join(" "), rest: rest, hasMore: rest.length > 0 };
};

/* The extra lines of one transcript entry, each shown only when the
   card actually carries it. A card with no concession shows no
   concession line, never an invented one. These live inside the
   expandable full text, never in the sharp view, so a discussion
   entry reads as one headline plus two lines by default instead of
   a stack of six. */
BR.txExtrasFor = function (t, displayTo) {
  var extras = [];
  if (t.disagreeWith) { extras.push("Rebuts " + BR.esc(t.disagreeWith)); }
  if (t.kind === "discussion" && t.answerTo) {
    extras.push("Answers " + BR.esc(displayTo) + " (" + BR.esc(t.agree || "") + " on: " + BR.esc(t.pointAnswered || "") + ")");
    if (t.steelman) { extras.push("Steelman: " + BR.esc(t.steelman)); }
    if (t.weakPoint) { extras.push("Weak point: " + BR.esc(t.weakPoint)); }
    if (t.concede) { extras.push("Concedes: " + BR.esc(t.concede)); }
    if (t.costOfBeingWrong || t.evidenceDemanded) {
      extras.push("Cost if wrong: " + BR.esc(t.costOfBeingWrong || "") + " · Settles it: " + BR.esc(t.evidenceDemanded || ""));
    }
  } else if (t.concede) {
    extras.push("Concedes: " + BR.esc(t.concede));
  }
  return extras;
};

BR.renderTranscript = function (container, state, speakingId, workingLabel) {
  if (!state || state.transcript.length === 0) {
    container.innerHTML = '<p class="muted">No conversation yet. Start a debate and every step will appear here live.</p>';
    return;
  }
  /* One entry, sharp by default: headline plus up to two supporting
     sentences, then the full text and the extra lines behind one
     visible expand control. Short entries with no extras render
     exactly as before, badge in the head; long entries keep the
     head to speaker plus kind, and the badge moves into the full
     text, so no head ever carries a stack of pills. */
  function entryBlocks(t, displayTo) {
    var sharp = BR.splitSharp(t.body || "", t.headline || "");
    var extras = BR.txExtrasFor(t, displayTo || "");
    var badge = BR.servedBadgeFor(state, t.stepKey);
    var showToggle = sharp.hasMore || extras.length > 0;
    var out = { headBadge: showToggle ? "" : badge, blocks: "" };
    if (!showToggle) {
      out.blocks = '<div class="tx-body">' + BR.esc(t.body || "") + '</div>';
      return out;
    }
    var sharpHtml = "";
    if (sharp.headline || sharp.excerpt) {
      sharpHtml = '<div class="tx-sharp">';
      if (sharp.headline) { sharpHtml += '<div class="tx-headline">' + BR.esc(sharp.headline) + '</div>'; }
      if (sharp.excerpt) { sharpHtml += '<div class="tx-excerpt">' + BR.esc(sharp.excerpt) + '</div>'; }
      sharpHtml += '</div>';
    }
    var fullHtml = '<div class="tx-full" hidden><div class="tx-body">' + BR.esc(t.body || "") + '</div>';
    extras.forEach(function (e) { fullHtml += '<div class="tx-rebuts">' + e + '</div>'; });
    if (badge) { fullHtml += '<div>' + badge + '</div>'; }
    fullHtml += '</div>';
    out.blocks = sharpHtml + fullHtml +
      '<button class="tx-expand" type="button" data-show-label="' + (sharp.hasMore ? "Show full text" : "Show detail") + '">' + (sharp.hasMore ? "Show full text" : "Show detail") + '</button>';
    return out;
  }
  var html = "";
  state.transcript.forEach(function (t) {
    if (t.kind === "director" || t.speaker === "Director") {
      var dBlocks = entryBlocks(t, "");
      html += '<div class="tx-entry tx-director" data-speaker="director" data-kind="' + BR.esc(t.kind) + '"><div class="tx-head"><span class="tx-speaker">Director</span>';
      html += '<span class="tx-kind">' + BR.esc(t.title) + '</span>' + dBlocks.headBadge + '</div>';
      html += dBlocks.blocks + '</div>';
    } else {
      var adv = BR.advisorByShort(state, t.speaker);
      var speakerId = adv ? adv.id : "";
      var displayTo = (t.kind === "discussion" && typeof BR.displayDiscussionTarget === "function")
        ? BR.displayDiscussionTarget(state, t)
        : (t.answerTo || "");
      var aBlocks = entryBlocks(t, displayTo);
      html += '<div class="tx-entry tx-advisor" data-speaker="' + BR.esc(speakerId) + '" data-kind="' + BR.esc(t.kind) + '" data-answer-to="' + BR.esc(displayTo) + '" data-disagree-with="' + BR.esc(t.disagreeWith || "") + '">';
      if (adv) { html += BR.characterFigure(adv, ""); }
      html += '<div class="tx-content"><div class="tx-head"><span class="tx-speaker">' + BR.esc(t.speaker) + '</span>';
      html += '<span class="tx-kind">' + BR.esc(t.title) + '</span>' + aBlocks.headBadge + '</div>';
      html += aBlocks.blocks;
      html += '</div></div>';
    }
  });
  if (speakingId && !state.completed) {
    var current = BR.advisorById(state, speakingId);
    if (current) {
      html += '<div class="tx-entry tx-thinking">' + BR.characterFigure(current, "") + '<span><strong>' + BR.esc(current.short) + '</strong> is thinking<span class="thinking"><span></span><span></span><span></span></span></span></div>';
    }
  } else if (workingLabel && !state.completed) {
    /* Director and draft steps have no seat, so their model wait
       gets a Director working row instead of an idle room. */
    html += '<div class="tx-entry tx-thinking"><span><strong>' + BR.esc(workingLabel) + '</strong> is thinking<span class="thinking"><span></span><span></span><span></span></span></span></div>';
  }
  container.innerHTML = html;
};

/* Key points side panel: live one-liners per seat during the debate,
   stacked cards after the verdict. The verdict used to render as a
   five-column table inside the 340px aside, and on real phones its
   headers wrapped letter by letter while every Line cell cut off
   mid-sentence. Cards fix that by construction: each card is full
   container width, every field is labelled, and the Line prints in
   full at word boundaries, so no text can ever be cut off at any
   width. Weighted maths live on the verdict sheet, not here. */
BR.renderKeyPoints = function (container, state) {
  if (state.verdict) {
    var v = state.verdict;
    var html = "";
    state.advisors.forEach(function (a) {
      var w = state.director.weights[a.id] ? state.director.weights[a.id].weight : 1;
      var latest = BR.latestCardFor(state, a.id);
      var f = state.final[a.id];
      var finalCell = (f && f.vote && isFinite(Number(f.finalScore))) ? f.vote + " (" + f.finalScore + "/10)" : (latest ? latest.card.stance : "");
      var badgeClass = (f && f.vote === "Endorse") ? "yes" : (f && f.vote === "Endorse with amendment") ? "yes-if" : (f && f.vote === "Dissent") ? "no" : BR.voteBadgeClass(latest ? latest.card.stance : "");
      html += '<div class="kp-item" data-seat-id="' + BR.esc(a.id) + '">' + BR.characterFigure(a, "") + '<div class="kp-content">';
      html += '<div class="kp-head"><span class="kp-name">' + BR.esc(a.short) + '</span>';
      html += '<span class="kp-weight">Weight ' + BR.esc(w) + ' / 3</span></div>';
      html += '<div class="kp-line"><span class="vote-badge ' + badgeClass + '">' + BR.esc(finalCell) + '</span> · Pillar ' + BR.esc(v.pillarScores[a.id]) + '/10</div>';
      html += '<div class="kp-reason">' + BR.esc(f ? f.line : "") + '</div>';
      html += '</div></div>';
    });
    container.innerHTML = html;
    return;
  }
  var items = "";
  state.advisors.forEach(function (a) {
    var found = BR.latestCardFor(state, a.id);
    var card = found ? found.card : null;
    var weight = state.director && state.director.weights[a.id] ? state.director.weights[a.id] : null;
    items += '<div class="kp-item" data-seat-id="' + BR.esc(a.id) + '">' + BR.characterFigure(a, "") + '<div class="kp-content">';
    items += '<div class="kp-head"><span class="kp-name">' + BR.esc(a.short) + '</span>';
    items += '<span class="kp-weight">Weight ' + BR.esc(weight ? weight.weight : "-") + ' / 3</span></div>';
    if (weight && weight.reason) {
      items += '<div class="kp-weight-reason">' + BR.esc(weight.reason) + '</div>';
    }
    if (card) {
      items += '<div class="kp-line"><span class="vote-badge ' + BR.voteBadgeClass(card.stance) + '">' + BR.esc(card.stance) + '</span> Option ' + BR.esc(card.recommendedId) + ': ' + BR.esc(card.optionScores[card.recommendedId]) + '/10</div>';
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

/* Verdict sheet, verdict first: the winning option and the
   one-line call at the top, then the 3 deciding reasons, then every
   seat in one sharp line. Option bars, maths, stats, and the rest
   live behind one Full detail control, so a reader grasps the
   outcome in under 30 seconds and nothing competes with it. The
   data and maths behind the sheet are exactly as before; only the
   presentation changed. */
BR.renderVerdict = function (container, state) {
  if (!state.verdict) {
    container.innerHTML = '<p class="muted">The verdict appears here after the final vote.</p>';
    return;
  }
  var v = state.verdict;
  var d = state.draft;
  var html = '<div class="verdict-sheet"><div class="verdict-label">' + BR.esc(v.label) + '</div>';
  html += '<p class="verdict-call">Option ' + BR.esc(v.recommendedId) + ' ' + BR.esc(BR.optionLabelOf(state, v.recommendedId)) + ', scoring ' + BR.esc(v.recommendedScore) + '/10.</p>';
  if (v.topReasons && v.topReasons.length > 0) {
    html += '<h3>Why it won</h3><ol class="verdict-reasons">';
    v.topReasons.slice(0, 3).forEach(function (r) {
      html += '<li><strong>' + BR.esc(r.short) + '</strong> (pillar ' + BR.esc(r.pillarScore) + '/10): ' + BR.esc(r.reason) + '</li>';
    });
    html += '</ol>';
  }
  /* Every seat, one sharp line: vote, score, weight, pillar, final
     line. This replaces the pillar scorecard table and absorbs the
     chair weights, so the sheet has one hierarchy and no competing
     tables. The scores and maths behind it are untouched. */
  html += '<h3>Every seat, one line</h3><div class="verdict-seats">';
  state.advisors.forEach(function (a) {
    var f = state.final[a.id];
    var w = state.director && state.director.weights[a.id] ? state.director.weights[a.id].weight : 1;
    var voteCls = !f ? "waiting" : (f.vote === "Endorse" ? "yes" : (f.vote === "Endorse with amendment" ? "yes-if" : "no"));
    var voteText = (f && f.vote) ? f.vote + " (" + f.finalScore + "/10)" : "No vote";
    html += '<div class="verdict-seat"><strong>' + BR.esc(a.short) + '</strong> <span class="vote-badge ' + voteCls + '">' + BR.esc(voteText) + '</span> · Weight ' + BR.esc(w) + ' · Pillar ' + BR.esc(v.pillarScores[a.id]) + '/10: <span class="verdict-seat-line">' + BR.esc(f ? f.line : "") + '</span></div>';
  });
  html += '</div>';
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
  html += '<h3>Option scores</h3><div class="option-bars">';
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
  if (state.director && state.director.weights) {
    html += '<h3>Chair weights</h3><ul>';
    state.advisors.forEach(function (a) {
      var w = state.director.weights[a.id] ? state.director.weights[a.id] : { weight: 1, reason: "General relevance." };
      html += '<li><strong>' + BR.esc(a.short) + '</strong> ' + BR.esc(w.weight) + ' / 3: ' + BR.esc(w.reason) + '</li>';
    });
    html += '</ul>';
  }
  if (v.pillarFixes && v.pillarFixes.length > 0) {
    html += '<h3>Pillar fixes</h3><ul>';
    v.pillarFixes.forEach(function (f) {
      html += '<li><strong>' + BR.esc(f.dimension) + '</strong> scores ' + BR.esc(f.score) + '/10 (' + BR.esc(f.short) + '). Fix: ' + BR.esc(f.line) + '</li>';
    });
    html += '</ul>';
  }
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
  html += '<p class="muted sim-note">Advisors on this board are AI simulations inspired by public frameworks. They are not the real people and do not speak for them.</p></div>';
  container.innerHTML = html;
};

/* Consult answer: one seat, one prose answer, no scores. */
BR.renderConsult = function (container, consult) {
  if (!consult || !consult.advisor) {
    container.innerHTML = '<p class="muted">No consult answer yet.</p>';
    return;
  }
  var a = consult.advisor;
  var html = '<div class="consult-head">' + BR.characterFigure(a, "") + '<div><strong>' + BR.esc(a.short) + '</strong>';
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
