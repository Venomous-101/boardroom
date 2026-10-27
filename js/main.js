/* Boardroom main wiring.
   Keys live only in localStorage. They are never displayed, never logged,
   and never sent anywhere except the chosen provider's API host. */

var BR = (function () {
  if (typeof window !== "undefined") { window.BR = window.BR || {}; return window.BR; }
  globalThis.BR = globalThis.BR || {}; return globalThis.BR;
})();

BR.HISTORY_KEY = "boardroom.sessions.v1";
BR.KEY_GROQ = "boardroom.groqKey";
BR.KEY_GEMINI = "boardroom.geminiKey";

BR.getKey = function (providerId) {
  try {
    return window.localStorage.getItem(providerId === "gemini" ? BR.KEY_GEMINI : BR.KEY_GROQ) || "";
  } catch (e) {
    return "";
  }
};

BR.setKey = function (providerId, value) {
  try {
    window.localStorage.setItem(providerId === "gemini" ? BR.KEY_GEMINI : BR.KEY_GROQ, value);
  } catch (e) { /* storage unavailable: keys stay in memory only for this session */ }
};

BR.clearKeys = function () {
  try {
    window.localStorage.removeItem(BR.KEY_GROQ);
    window.localStorage.removeItem(BR.KEY_GEMINI);
  } catch (e) { /* ignore */ }
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
  var running = false;
  var speakingId = null;

  var els = {
    keyGroq: $("key-groq"), keyGemini: $("key-gemini"),
    keyStatus: $("key-status"), saveKeys: $("save-keys"), clearKeys: $("clear-keys"),
    title: $("d-title"), context: $("d-context"), options: $("d-options"),
    rounds: $("d-rounds"), focus: $("d-focus"), provider: $("d-provider"), model: $("d-model"),
    customName: $("d-custom-name"), customView: $("d-custom-view"),
    start: $("start-debate"), newDebate: $("new-debate"),
    status: $("status"), errorBox: $("error-box"), errorText: $("error-text"),
    retryStep: $("retry-step"), switchProvider: $("switch-provider"),
    board: $("board"), transcript: $("transcript"), scorecard: $("scorecard"),
    verdict: $("verdict"), history: $("history"),
    downloadMd: $("download-md"), copyTx: $("copy-tx"), printBtn: $("print-btn"),
    setupForm: $("setup-form"), debateView: $("debate-view")
  };

  function refreshKeyStatus() {
    var g = BR.getKey("groq") ? "saved" : "not saved";
    var m = BR.getKey("gemini") ? "saved" : "not saved";
    els.keyStatus.textContent = "Groq key: " + g + ". Gemini key: " + m + ". Keys are stored only in this browser.";
  }

  function renderAll() {
    if (!currentState) { return; }
    BR.renderBoard(els.board, currentState, speakingId);
    BR.renderTranscript(els.transcript, currentState);
    BR.renderScorecard(els.scorecard, currentState);
    BR.renderVerdict(els.verdict, currentState);
  }

  function setStatus(text) {
    els.status.textContent = text;
  }

  function showError(failed) {
    els.errorText.textContent = "Step failed: " + failed.label + ". Cause: " + failed.error.message;
    els.errorBox.classList.remove("hidden");
    var other = currentState.provider === "groq" ? "gemini" : "groq";
    if (BR.getKey(other)) {
      els.switchProvider.classList.remove("hidden");
      els.switchProvider.textContent = "Retry this step with " + BR.PROVIDERS[other].label + " instead";
    } else {
      els.switchProvider.classList.add("hidden");
    }
  }

  function hideError() {
    els.errorBox.classList.add("hidden");
  }

  function callFn(state, step) {
    var providerId = state.provider;
    var key = BR.getKey(providerId);
    var model = state.model || BR.PROVIDERS[providerId].defaultModel;
    if (!key) {
      return Promise.resolve({ ok: false, error: { code: "no_key", message: "No API key saved for " + BR.PROVIDERS[providerId].label + ". Add your key first." } });
    }
    var system = "";
    var user = "";
    if (step.key === "director") {
      system = BR.directorSystem;
      user = BR.directorUser(state);
    } else if (step.key.indexOf("opening:") === 0) {
      var adv = BR.advisorById(state, step.advisorId);
      var w = state.director.weights[adv.id] ? state.director.weights[adv.id].weight : 1;
      system = BR.personaPromptFor(adv);
      user = BR.openingUser(state, adv, w);
    } else if (step.key.indexOf("debate:") === 0) {
      var adv2 = BR.advisorById(state, step.advisorId);
      var prev = step.round === 1 ? state.opening : state.debateRounds[step.round - 2].cards;
      system = BR.personaPromptFor(adv2);
      user = BR.debateUser(state, adv2, prev, step.round);
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
      system = BR.personaPromptFor(adv3);
      user = BR.finalUser(state, adv3);
    }
    return BR.callLLM(providerId, key, model, system, user);
  }

  function onProgress(step, attempt) {
    speakingId = step.advisorId || null;
    setStatus("Working: " + step.label + (attempt > 1 ? " (attempt " + attempt + ")" : "") + ".");
    if (currentState) { BR.renderBoard(els.board, currentState, speakingId); }
  }

  function onStepDone() {
    speakingId = null;
    renderAll();
  }

  function runCurrent() {
    running = true;
    hideError();
    setStatus("Debate running.");
    currentState.onStepDone = onStepDone;
    return BR.runDebate(currentState, callFn, onProgress).then(function (res) {
      running = false;
      speakingId = null;
      renderAll();
      if (res.ok) {
        setStatus("Debate complete. Verdict ready below.");
        BR.saveHistory(currentState);
        renderHistoryList();
      } else {
        setStatus("Debate paused at a failed step. Fix it and retry that step only.");
        showError(res.failedStep);
      }
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
          els.setupForm.classList.add("hidden");
          els.debateView.classList.remove("hidden");
          setStatus("Loaded a past debate. Nothing was rerun.");
          renderAll();
        }
      });
    });
  }

  els.saveKeys.addEventListener("click", function () {
    var g = els.keyGroq.value.trim();
    var m = els.keyGemini.value.trim();
    if (g) { BR.setKey("groq", g); }
    if (m) { BR.setKey("gemini", m); }
    els.keyGroq.value = "";
    els.keyGemini.value = "";
    refreshKeyStatus();
    setStatus("Keys saved in this browser only.");
  });

  els.clearKeys.addEventListener("click", function () {
    BR.clearKeys();
    refreshKeyStatus();
    setStatus("Keys cleared from this browser.");
  });

  els.provider.addEventListener("change", function () {
    els.model.value = BR.PROVIDERS[els.provider.value].defaultModel;
  });

  els.start.addEventListener("click", function () {
    if (running) { return; }
    var title = els.title.value.trim();
    var context = els.context.value.trim();
    if (!title) { setStatus("Enter a decision title first."); return; }
    if (!context) { setStatus("Enter context for the decision first."); return; }
    var providerId = els.provider.value;
    if (!BR.getKey(providerId)) {
      setStatus("Add your " + BR.PROVIDERS[providerId].label + " API key first. Keys are stored only in this browser.");
      return;
    }
    var optionLines = els.options.value.split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
    var customName = els.customName.value.trim();
    var customView = els.customView.value.trim();
    if (customName && !customView) {
      setStatus("Add a viewpoint for your custom advisor, or leave the name blank.");
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
      rounds: els.rounds.value,
      provider: providerId,
      model: els.model.value.trim() || BR.PROVIDERS[providerId].defaultModel,
      advisors: advisors
    });
    els.setupForm.classList.add("hidden");
    els.debateView.classList.remove("hidden");
    renderAll();
    runCurrent();
  });

  els.newDebate.addEventListener("click", function () {
    if (running) { return; }
    currentState = null;
    els.debateView.classList.add("hidden");
    els.setupForm.classList.remove("hidden");
    hideError();
    setStatus("Ready for a new debate.");
  });

  els.retryStep.addEventListener("click", function () {
    if (running || !currentState || !currentState.failedStep) { return; }
    runCurrent();
  });

  els.switchProvider.addEventListener("click", function () {
    if (running || !currentState) { return; }
    var other = currentState.provider === "groq" ? "gemini" : "groq";
    if (!BR.getKey(other)) { return; }
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
  refreshKeyStatus();
  renderHistoryList();
  setStatus("Ready. Add your key, describe a decision, and start the board.");
});
