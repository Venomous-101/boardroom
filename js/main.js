/* Boardroom main wiring.
   The page holds no API key. Calls go through this deployment's own
   server function (/api/chat), which holds the key server-side.
   Past debates live only in this browser's localStorage.
   Consult answers are never saved to history. */

var BR = (function () {
  if (typeof window !== "undefined") { window.BR = window.BR || {}; return window.BR; }
  globalThis.BR = globalThis.BR || {}; return globalThis.BR;
})();

BR.HISTORY_KEY = "boardroom.sessions.v1";
BR.IN_PROGRESS_KEY = "boardroom.inprogress.v1";

/* In-progress persistence: debate state only, saved after each step
   and on a failed step, cleared when a debate completes or is
   discarded. It never holds a key: the state carries only provider
   and model names, never credentials, and the server key is never in
   the page at all. A saved debate is resumed only on the user's
   click, never automatically, so a reload never restarts a debate
   the user did not ask to continue. */
BR.loadInProgress = function () {
  try {
    var raw = window.localStorage.getItem(BR.IN_PROGRESS_KEY);
    if (!raw) { return null; }
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || parsed.completed) { return null; }
    return parsed;
  } catch (e) {
    return null;
  }
};

BR.saveInProgress = function (state) {
  try {
    if (!state || state.completed) { return; }
    var copy = JSON.parse(JSON.stringify(state));
    delete copy.failedStep;
    delete copy.onStepDone;
    window.localStorage.setItem(BR.IN_PROGRESS_KEY, JSON.stringify(copy));
  } catch (e) { /* persistence is best effort; a failed save never blocks the debate */ }
};

BR.clearInProgress = function () {
  try { window.localStorage.removeItem(BR.IN_PROGRESS_KEY); } catch (e) { /* ignore */ }
};

BR.loadHistory = function () {
  try {
    var raw = window.localStorage.getItem(BR.HISTORY_KEY);
    if (!raw) { return []; }
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
};

BR.saveHistory = function (state) {
  try {
    var list = BR.loadHistory();
    var copy = JSON.parse(JSON.stringify(state));
    delete copy.failedStep;
    list.unshift(copy);
    while (list.length > 20) { list.pop(); }
    window.localStorage.setItem(BR.HISTORY_KEY, JSON.stringify(list));
  } catch (e) { /* history is best effort; a failed save never blocks the debate */ }
};

document.addEventListener("DOMContentLoaded", function () {
  var $ = function (id) { return document.getElementById(id); };
  var currentState = null;
  var currentConsult = null;
  var running = false;
  var speakingId = null;

  var els = {
    title: $("d-title"), context: $("d-context"), options: $("d-options"),
    mode: $("d-mode"), rounds: $("d-rounds"), focus: $("d-focus"), provider: $("d-provider"), model: $("d-model"),
    customName: $("d-custom-name"), customView: $("d-custom-view"),
    consultSeatRow: $("consult-seat-row"), consultSeat: $("d-consult-seat"),
    start: $("start-debate"), newDebate: $("new-debate"),
    status: $("status"), errorBox: $("error-box"), errorText: $("error-text"),
    retryStep: $("retry-step"), switchProvider: $("switch-provider"),
    stepper: $("stepper"), stage: $("stage"), cruxes: $("cruxes"), draft: $("draft"),
    transcript: $("transcript"), keypoints: $("keypoints"),
    verdict: $("verdict"), history: $("history"),
    downloadMd: $("download-md"), copyTx: $("copy-tx"), printBtn: $("print-btn"),
    voiceToggle: $("voice-toggle"),
    setupForm: $("setup-form"), debateView: $("debate-view"),
    resumePanel: $("resume-panel"), resumeText: $("resume-text"),
    resumeDebate: $("resume-debate"), resumeDiscard: $("resume-discard"),
    consultView: $("consult-view"), consultAnswer: $("consult-answer"),
    consultRetry: $("consult-retry"), consultNew: $("consult-new")
  };

  function renderAll() {
    if (!currentState) { return; }
    BR.renderStepper(els.stepper, currentState);
    BR.renderStage(els.stage, currentState, speakingId, BR.currentRebuttal(currentState));
    BR.renderCruxes(els.cruxes, currentState);
    BR.renderDraft(els.draft, currentState);
    BR.renderTranscript(els.transcript, currentState, speakingId);
    BR.renderKeyPoints(els.keypoints, currentState);
    BR.renderVerdict(els.verdict, currentState);
  }

  function setStatus(text) {
    els.status.textContent = text;
  }

  var providerOrder = ["groq", "openrouter", "gemini"];

  function nextProvider(current) {
    var i = providerOrder.indexOf(current);
    return providerOrder[(i + 1) % providerOrder.length];
  }

  function showError(failed) {
    els.errorText.textContent = "Step failed: " + failed.label + ". Cause: " + failed.error.message;
    els.errorBox.classList.remove("hidden");
    var other = nextProvider(currentState.provider);
    els.switchProvider.classList.remove("hidden");
    els.switchProvider.textContent = "Retry this step with " + BR.PROVIDERS[other].label + " instead";
  }

  function hideError() {
    els.errorBox.classList.add("hidden");
  }

  function callFn(state, step) {
    var providerId = state.provider;
    var model = state.model || BR.PROVIDERS[providerId].defaultModel;
    var system = "";
    var user = "";
    if (step.key === "director") {
      system = BR.directorSystem;
      user = BR.directorUser(state);
    } else if (step.key.indexOf("opening:") === 0) {
      var adv = BR.advisorById(state, step.advisorId);
      var w = state.director.weights[adv.id] ? state.director.weights[adv.id].weight : 1;
      system = BR.slicePrompt ? BR.slicePrompt(adv, "opening") : BR.personaPromptFor(adv);
      user = BR.openingUser(state, adv, w);
    } else if (step.key.indexOf("debate:") === 0) {
      var adv2 = BR.advisorById(state, step.advisorId);
      var prev = step.round === 1 ? state.opening : state.debateRounds[step.round - 2].cards;
      system = BR.slicePrompt ? BR.slicePrompt(adv2, "debate") : BR.personaPromptFor(adv2);
      user = BR.debateUser(state, adv2, prev, step.round);
    } else if (step.key.indexOf("discussion:") === 0) {
      var advD = BR.advisorById(state, step.advisorId);
      if (!state.discussionTargets || Object.keys(state.discussionTargets).length === 0) {
        if (BR.assignDiscussionTargets) { BR.assignDiscussionTargets(state); }
      }
      var target = BR.discussionTargetFor ? BR.discussionTargetFor(state, advD.id) : BR.strongestDiscussionTarget(state, advD.id);
      var latest = state.debateRounds.length > 0
        ? state.debateRounds[state.debateRounds.length - 1].cards
        : state.opening;
      var targetCard = target ? latest[target.id] : null;
      system = BR.slicePrompt ? BR.slicePrompt(advD, "discussion", target) : BR.personaPromptFor(advD);
      user = BR.discussionUser(state, advD, target, targetCard);
    } else if (step.key === "draft") {
      var latest = state.debateRounds.length > 0
        ? state.debateRounds[state.debateRounds.length - 1].cards
        : state.opening;
      var scores = BR.computeOptionScores(state, latest);
      var rec = BR.pickRecommended(state, scores);
      system = BR.directorSystem;
      user = BR.draftUser(state, scores, rec);
    } else if (step.key.indexOf("final:") === 0) {
      var adv3 = BR.advisorById(state, step.advisorId);
      system = BR.slicePrompt ? BR.slicePrompt(adv3, "final") : BR.personaPromptFor(adv3);
      user = BR.finalUser(state, adv3);
    }
    return BR.callLLM(providerId, model, system, user);
  }

  function onProgress(step, attempt) {
    stopPlayback();
    speakingId = step.advisorId || null;
    setStatus("Working: " + step.label + (attempt > 1 ? " (attempt " + attempt + ")" : "") + ".");
    if (currentState) { renderAll(); }
  }

  /* Word-by-word speaking playback. After a step completes, the last
     transcript entry reveals word by word while the speaker's portrait
     cycles mouth states and leans toward the seat it addressed, when
     there is one. Mouth states are stylised indicators, not lip-sync.
     Under reduced motion, the full text shows at once and no mouth
     cycling runs. Voice uses only the browser's built-in speech, only
     when the toggle is on (off by default); nothing is sent anywhere
     and no key is involved. Playback never blocks the debate: the
     next step runs on its own schedule regardless of playback. */
  var playbackTimer = null;
  var playbackSeatEl = null;
  var playbackThumbEl = null;

  function voiceOn() {
    return !!(els.voiceToggle && els.voiceToggle.checked);
  }

  function stopPlayback() {
    if (playbackTimer) { clearInterval(playbackTimer); playbackTimer = null; }
    try {
      if (window.speechSynthesis) { window.speechSynthesis.cancel(); }
    } catch (e) { /* ignore */ }
    if (playbackThumbEl) {
      ["mouth-closed", "mouth-mid", "mouth-open"].forEach(function (c) { playbackThumbEl.classList.remove(c); });
      playbackThumbEl = null;
    }
    if (playbackSeatEl) {
      playbackSeatEl.classList.remove("lean-left");
      playbackSeatEl.classList.remove("lean-right");
      playbackSeatEl.classList.remove("lean-toward");
      playbackSeatEl.style.removeProperty("--lean-dx");
      playbackSeatEl.style.removeProperty("--lean-dy");
      playbackSeatEl = null;
    }
  }

  function playLastEntry() {
    stopPlayback();
    if (!currentState || !currentState.transcript || currentState.transcript.length === 0) { return; }
    var last = currentState.transcript[currentState.transcript.length - 1];
    var entries = els.transcript.querySelectorAll(".tx-entry");
    if (entries.length === 0) { return; }
    var entryEl = entries[entries.length - 1];
    var bodyEl = entryEl.querySelector(".tx-body");
    if (!bodyEl) { return; }
    var fullText = last.body || bodyEl.textContent || "";
    var words = BR.splitWords ? BR.splitWords(fullText) : fullText.split(/\s+/).filter(Boolean);
    if (words.length === 0) { return; }
    if (voiceOn()) {
      try {
        if (window.speechSynthesis && window.SpeechSynthesisUtterance) {
          var utter = new SpeechSynthesisUtterance(fullText);
          window.speechSynthesis.speak(utter);
        }
      } catch (e) { /* voice is best effort; playback continues silently */ }
    }
    if (reducedMotion) { return; }
    var speakerId = entryEl.getAttribute("data-speaker") || "";
    var seatEl = speakerId ? els.stage.querySelector('[data-seat-id="' + speakerId + '"]') : null;
    if (seatEl) {
      playbackSeatEl = seatEl;
      var thumbEl = seatEl.querySelector(".thumb");
      if (thumbEl) { playbackThumbEl = thumbEl; }
      var targetShort = last.answerTo || last.disagreeWith || "";
      var targetId = "";
      if (targetShort) {
        var targetAdv = BR.advisorByShort(currentState, targetShort);
        if (targetAdv) { targetId = targetAdv.id; }
      }
      if (targetId) {
        var sIdx = -1;
        var tIdx = -1;
        currentState.advisors.forEach(function (a, i) {
          if (a.id === speakerId) { sIdx = i; }
          if (a.id === targetId) { tIdx = i; }
        });
        var vec = BR.leanVectorFor ? BR.leanVectorFor(sIdx, tIdx, currentState.advisors.length) : null;
        if (vec) {
          seatEl.classList.add("lean-toward");
          seatEl.style.setProperty("--lean-dx", vec.dx + "px");
          seatEl.style.setProperty("--lean-dy", vec.dy + "px");
        }
      }
    }
    var interval = Math.max(55, Math.min(180, Math.round(9000 / words.length)));
    var i = 0;
    bodyEl.textContent = "";
    playbackTimer = setInterval(function () {
      i += 1;
      bodyEl.textContent = words.slice(0, i).join(" ");
      if (playbackThumbEl) {
        ["mouth-closed", "mouth-mid", "mouth-open"].forEach(function (c) { playbackThumbEl.classList.remove(c); });
        playbackThumbEl.classList.add(BR.mouthClassFor(i - 1));
      }
      if (i >= words.length) {
        bodyEl.textContent = fullText;
        stopPlayback();
      }
    }, interval);
  }

  function onStepDone() {
    speakingId = null;
    renderAll();
    playLastEntry();
  }

  function runCurrent() {
    running = true;
    stopPlayback();
    hideError();
    setStatus("Debate running.");
    /* Save after every completed step, so a reload can resume from
       the next undone step instead of restarting the debate. */
    currentState.onStepDone = function () {
      BR.saveInProgress(currentState);
      onStepDone();
    };
    return BR.runDebate(currentState, callFn, onProgress).then(function (res) {
      running = false;
      speakingId = null;
      renderAll();
      if (res.ok) {
        setStatus("Debate complete. Verdict ready below.");
        BR.clearInProgress();
        BR.saveHistory(currentState);
        renderHistoryList();
      } else {
        setStatus("Debate paused at a failed step. Fix it and retry that step only.");
        BR.saveInProgress(currentState);
        showError(res.failedStep);
      }
    });
  }

  function showResumePanel() {
    var saved = BR.loadInProgress();
    if (!saved || !els.resumePanel) { return; }
    els.resumeText.textContent = "An unfinished debate was found: \"" + (saved.title || "Untitled") + "\". Resume it to continue from the next undone step, or discard it to start fresh. Nothing was rerun on reload.";
    els.resumePanel.classList.remove("hidden");
  }

  if (els.resumeDebate) {
    els.resumeDebate.addEventListener("click", function () {
      if (running) { return; }
      var saved = BR.loadInProgress();
      if (!saved) { return; }
      currentState = saved;
      currentConsult = null;
      els.resumePanel.classList.add("hidden");
      els.setupForm.classList.add("hidden");
      els.consultView.classList.add("hidden");
      els.debateView.classList.remove("hidden");
      setStatus("Resuming your debate from the next undone step. Earlier steps were not rerun.");
      renderAll();
      runCurrent();
    });
  }

  if (els.resumeDiscard) {
    els.resumeDiscard.addEventListener("click", function () {
      BR.clearInProgress();
      if (els.resumePanel) { els.resumePanel.classList.add("hidden"); }
      setStatus("Discarded the unfinished debate. Ready for a new debate.");
    });
  }

  function renderHistoryList() {
    var list = BR.loadHistory();
    BR.renderHistory(els.history, list);
    var items = els.history.querySelectorAll(".history-item");
    items.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-session-id");
        var found = null;
        list.forEach(function (s) { if (s.id === id) { found = s; } });
        if (found) {
          currentState = found;
          currentConsult = null;
          els.setupForm.classList.add("hidden");
          els.consultView.classList.add("hidden");
          els.debateView.classList.remove("hidden");
          setStatus("Loaded a past debate. Nothing was rerun.");
          renderAll();
        }
      });
    });
  }

  function resetToSetup() {
    if (running) { return; }
    stopPlayback();
    currentState = null;
    currentConsult = null;
    els.debateView.classList.add("hidden");
    els.consultView.classList.add("hidden");
    els.setupForm.classList.remove("hidden");
    hideError();
    setStatus("Ready for a new debate.");
  }

  function runConsult() {
    if (running || !currentConsult) { return; }
    running = true;
    hideError();
    setStatus("Consulting " + currentConsult.advisor.short + ".");
    BR.renderConsult(els.consultAnswer, currentConsult);
    var providerId = currentConsult.provider;
    var model = currentConsult.model || BR.PROVIDERS[providerId].defaultModel;
    var consultSystem = (currentConsult.advisor.id !== "custom" && BR.slicePrompt)
      ? BR.slicePrompt(currentConsult.advisor, "consult") + "\nAnswer as prose, in this order: your recommendation (which option, or none), why from your pillar, the biggest risk, and the one fact or number that would change your mind. Keep it under 400 words. Do not score anything and do not use JSON."
      : BR.consultSystem;
    BR.callLLM(providerId, model, consultSystem, BR.consultUser(currentConsult, currentConsult.advisor)).then(function (res) {
      running = false;
      if (res.ok && res.text) {
        currentConsult.answer = res.text;
        currentConsult.servedBy = res.servedBy || null;
        currentConsult.completed = true;
        setStatus("Consult answer ready. Consult answers are not saved to history.");
      } else {
        setStatus("Consult failed: " + (res.error ? res.error.message : "unknown error") + " Retry below.");
      }
      BR.renderConsult(els.consultAnswer, currentConsult);
    });
  }

  function applyMode() {
    var mode = els.mode.value;
    if (mode === "consult") {
      els.consultSeatRow.classList.remove("hidden");
      els.rounds.disabled = true;
    } else {
      els.consultSeatRow.classList.add("hidden");
      if (mode === "quick") {
        els.rounds.value = "1";
        els.rounds.disabled = true;
      } else {
        els.rounds.disabled = false;
      }
    }
  }

  function populateConsultSeats() {
    BR.PERSONAS.forEach(function (p) {
      var opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.short + " (" + p.pillar + ")";
      els.consultSeat.appendChild(opt);
    });
    var custom = document.createElement("option");
    custom.value = "custom";
    custom.textContent = "Custom advisor (from the fields below)";
    els.consultSeat.appendChild(custom);
  }

  function focusSeat(seatId) {
    var entries = els.transcript.querySelectorAll('[data-speaker="' + seatId + '"]');
    if (entries.length > 0) {
      var last = entries[entries.length - 1];
      var prev = els.transcript.querySelectorAll(".tx-entry.focused");
      prev.forEach(function (el) { el.classList.remove("focused"); });
      last.classList.add("focused");
      if (last.scrollIntoView) { last.scrollIntoView({ behavior: "smooth", block: "center" }); }
    }
    var kp = els.keypoints.querySelectorAll(".kp-item");
    kp.forEach(function (el) {
      if (el.getAttribute("data-seat-id") === seatId) { el.classList.add("focused"); }
      else { el.classList.remove("focused"); }
    });
  }

  els.stage.addEventListener("click", function (ev) {
    var seat = ev.target.closest ? ev.target.closest("[data-seat-id]") : null;
    if (seat) { focusSeat(seat.getAttribute("data-seat-id")); }
  });

  els.stage.addEventListener("keydown", function (ev) {
    if (ev.key !== "Enter" && ev.key !== " ") { return; }
    var seat = ev.target.closest ? ev.target.closest("[data-seat-id]") : null;
    if (seat) {
      ev.preventDefault();
      focusSeat(seat.getAttribute("data-seat-id"));
    }
  });

  /* Idle blink: one random idle seat dips for 130ms on a 2.4 to 6.6s
     cycle. Skipped entirely under prefers-reduced-motion. */
  var reducedMotion = false;
  try {
    reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (e) { /* ignore */ }
  function scheduleBlink() {
    if (reducedMotion) { return; }
    var delay = 2400 + Math.random() * 4200;
    setTimeout(function () {
      var thumbs = els.stage.querySelectorAll(".stage-seat:not(.speaking) .thumb");
      if (thumbs.length > 0 && !els.debateView.classList.contains("hidden")) {
        var pick = thumbs[Math.floor(Math.random() * thumbs.length)];
        pick.classList.add("blinking");
        setTimeout(function () { pick.classList.remove("blinking"); }, 130);
      }
      scheduleBlink();
    }, delay);
  }

  els.provider.addEventListener("change", function () {
    els.model.value = BR.PROVIDERS[els.provider.value].defaultModel;
  });

  els.mode.addEventListener("change", applyMode);

  els.start.addEventListener("click", function () {
    if (running) { return; }
    var title = els.title.value.trim();
    var context = els.context.value.trim();
    if (!title) { setStatus("Enter a decision title first."); return; }
    if (!context) { setStatus("Enter context for the decision first."); return; }
    var providerId = els.provider.value;
    var optionLines = els.options.value.split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
    var customName = els.customName.value.trim();
    var customView = els.customView.value.trim();
    if (customName && !customView) {
      setStatus("Add a viewpoint for your custom advisor, or leave the name blank.");
      return;
    }
    var mode = els.mode.value;
    if (mode === "consult") {
      var seatId = els.consultSeat.value;
      var advisor = null;
      if (seatId === "custom") {
        if (!customName) {
          setStatus("Pick a seat for the consult, or name your custom advisor above.");
          return;
        }
        advisor = BR.buildCustomPersona(BR.clampText(customName, BR.LIMITS.customName), BR.clampText(customView, BR.LIMITS.viewpoint));
      } else {
        BR.PERSONAS.forEach(function (p) { if (p.id === seatId) { advisor = p; } });
        if (!advisor) { setStatus("Pick a seat for the consult."); return; }
      }
      currentConsult = BR.createConsult({
        title: title,
        context: context,
        options: optionLines,
        focus: els.focus.value,
        provider: providerId,
        model: els.model.value.trim() || BR.PROVIDERS[providerId].defaultModel,
        advisor: advisor
      });
      currentState = null;
      els.setupForm.classList.add("hidden");
      els.debateView.classList.add("hidden");
      els.consultView.classList.remove("hidden");
      runConsult();
      return;
    }
    var advisors = BR.PERSONAS.slice();
    if (customName) {
      advisors.push(BR.buildCustomPersona(BR.clampText(customName, BR.LIMITS.customName), BR.clampText(customView, BR.LIMITS.viewpoint)));
    }
    currentState = BR.createDebate({
      title: title,
      context: context,
      options: optionLines,
      focus: els.focus.value,
      rounds: mode === "quick" ? 1 : els.rounds.value,
      mode: mode,
      provider: providerId,
      model: els.model.value.trim() || BR.PROVIDERS[providerId].defaultModel,
      advisors: advisors
    });
    els.setupForm.classList.add("hidden");
    els.consultView.classList.add("hidden");
    els.debateView.classList.remove("hidden");
    renderAll();
    BR.saveInProgress(currentState);
    runCurrent();
  });

  els.newDebate.addEventListener("click", resetToSetup);
  els.consultNew.addEventListener("click", resetToSetup);
  els.consultRetry.addEventListener("click", runConsult);

  els.retryStep.addEventListener("click", function () {
    if (running || !currentState || !currentState.failedStep) { return; }
    runCurrent();
  });

  els.switchProvider.addEventListener("click", function () {
    if (running || !currentState) { return; }
    var other = nextProvider(currentState.provider);
    currentState.providerSwitches.push({ from: currentState.provider, to: other, at: currentState.failedStep ? currentState.failedStep.key : "" });
    currentState.provider = other;
    currentState.model = BR.PROVIDERS[other].defaultModel;
    currentState.transcript.push({ kind: "director", speaker: "Director", title: "Provider switch", body: "Switched to " + BR.PROVIDERS[other].label + " at your request. Earlier steps were not rerun." });
    els.provider.value = other;
    els.model.value = BR.PROVIDERS[other].defaultModel;
    renderAll();
    runCurrent();
  });

  els.downloadMd.addEventListener("click", function () {
    if (!currentState || !currentState.verdict) {
      setStatus("Finish a debate first, then download the summary.");
      return;
    }
    var text = BR.buildMarkdown(currentState);
    var blob = new Blob([text], { type: "text/markdown" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "boardroom-verdict.md";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });

  els.copyTx.addEventListener("click", function () {
    if (!currentState) { return; }
    var text = BR.buildTranscriptText(currentState);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        setStatus("Transcript copied.");
      }, function () {
        setStatus("Copy failed in this browser. Select the transcript text manually.");
      });
    } else {
      setStatus("Clipboard is not available in this browser.");
    }
  });

  els.printBtn.addEventListener("click", function () {
    window.print();
  });

  els.model.value = BR.PROVIDERS[els.provider.value].defaultModel;
  populateConsultSeats();
  applyMode();
  renderHistoryList();
  showResumePanel();
  scheduleBlink();
  setStatus("Ready. Describe a decision, and start the board.");
});
