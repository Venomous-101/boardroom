/* Boardroom provider clients.
   Calls go directly from the user's browser to the chosen provider.
   No Boardroom server exists, so no key ever passes through our hands.
   Gemini keys are sent via the x-goog-api-key header, never in a URL. */

var BR = (function () {
  if (typeof window !== "undefined") { window.BR = window.BR || {}; return window.BR; }
  globalThis.BR = globalThis.BR || {}; return globalThis.BR;
})();

BR.PROVIDERS = {
  groq: {
    id: "groq",
    label: "Groq",
    host: "api.groq.com",
    defaultModel: "openai/gpt-oss-120b",
    keyHelp: "Get a free key at console.groq.com"
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    host: "generativelanguage.googleapis.com",
    defaultModel: "gemini-2.0-flash",
    keyHelp: "Get a free key at aistudio.google.com"
  }
};

BR.CALL_TIMEOUT_MS = 90000;

BR.mapProviderError = function (providerId, status, bodyText) {
  var label = providerId === "groq" ? "Groq" : "Google Gemini";
  var body = (bodyText || "").slice(0, 400);
  if (status === 401 || status === 403) {
    return { code: "bad_key", message: "Invalid API key for " + label + ". Check the key and try again." };
  }
  if (status === 429) {
    return { code: "rate_limit", message: "Rate limit from " + label + ". Wait a minute, then retry this step." };
  }
  if (status === 404) {
    return { code: "bad_model", message: "Model not found on " + label + ". Check the model name and try again." };
  }
  if (status === 400) {
    return { code: "bad_request", message: "Request rejected by " + label + ". This usually means a bad model name or an invalid key. Details: " + body };
  }
  if (status >= 500) {
    return { code: "provider_error", message: label + " returned a server error (" + status + "). Retry this step." };
  }
  return { code: "http_" + status, message: label + " returned HTTP " + status + ". Details: " + body };
};

/* Extract a JSON object from model output. Models often wrap JSON in
   fences or add a short lead-in line. Returns the parsed object or null. */
BR.extractJSON = function (text) {
  if (!text || typeof text !== "string") { return null; }
  var cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  var start = cleaned.indexOf("{");
  var end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) { return null; }
  var slice = cleaned.slice(start, end + 1);
  try {
    var parsed = JSON.parse(slice);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) { return parsed; }
    return null;
  } catch (e) {
    return null;
  }
};

BR.toScore = function (value, fallback) {
  var n = Number(value);
  if (!isFinite(n)) { return fallback; }
  if (n < 0) { return 0; }
  if (n > 10) { return 10; }
  return Math.round(n * 10) / 10;
};

BR.toConfidence = function (value, fallback) {
  var n = Math.round(Number(value));
  if (!isFinite(n)) { return fallback; }
  if (n < 1) { return 1; }
  if (n > 5) { return 5; }
  return n;
};

BR.callGroq = function (key, model, systemPrompt, userPrompt, signal) {
  return fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + key,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 1500
    }),
    signal: signal
  }).then(function (res) {
    if (!res.ok) {
      return res.text().then(function (t) {
        return { ok: false, error: BR.mapProviderError("groq", res.status, t) };
      });
    }
    return res.json().then(function (data) {
      var content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (typeof content !== "string" || content.length === 0) {
        return { ok: false, error: { code: "empty_response", message: "Groq returned an empty response. Retry this step." } };
      }
      return { ok: true, text: content };
    });
  }).catch(function (err) {
    if (err && err.name === "AbortError") {
      return { ok: false, error: { code: "timeout", message: "Request timed out. Check your connection and retry this step." } };
    }
    return { ok: false, error: { code: "network", message: "Network error reaching Groq. Check your connection and retry this step." } };
  });
};

BR.callGemini = function (key, model, systemPrompt, userPrompt, signal) {
  var cleanModel = String(model).replace(/^models\//, "");
  var url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(cleanModel) + ":generateContent";
  return fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": key,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 1500 }
    }),
    signal: signal
  }).then(function (res) {
    if (!res.ok) {
      return res.text().then(function (t) {
        return { ok: false, error: BR.mapProviderError("gemini", res.status, t) };
      });
    }
    return res.json().then(function (data) {
      var parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
      var text = "";
      if (Array.isArray(parts)) {
        parts.forEach(function (p) { if (p && typeof p.text === "string") { text += p.text; } });
      }
      if (!text) {
        return { ok: false, error: { code: "empty_response", message: "Gemini returned an empty response. Retry this step." } };
      }
      return { ok: true, text: text };
    });
  }).catch(function (err) {
    if (err && err.name === "AbortError") {
      return { ok: false, error: { code: "timeout", message: "Request timed out. Check your connection and retry this step." } };
    }
    return { ok: false, error: { code: "network", message: "Network error reaching Google Gemini. Check your connection and retry this step." } };
  });
};

/* One LLM call with a timeout. Never logs the key or the request body. */
BR.callLLM = function (providerId, key, model, systemPrompt, userPrompt) {
  var controller = null;
  var signal = null;
  if (typeof AbortController !== "undefined") {
    controller = new AbortController();
    signal = controller.signal;
    setTimeout(function () { try { controller.abort(); } catch (e) { /* ignore */ } }, BR.CALL_TIMEOUT_MS);
  }
  if (providerId === "gemini") {
    return BR.callGemini(key, model, systemPrompt, userPrompt, signal);
  }
  return BR.callGroq(key, model, systemPrompt, userPrompt, signal);
};
