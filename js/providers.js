/* Boardroom provider client.
   The page never holds an API key. It calls this deployment's own
   server function (/api/chat) over the same origin, and that function
   calls the chosen provider with a key from the server environment.
   No key appears in this file, in the page, in the browser's storage,
   or in any request the browser makes to a third party.
   No request body is ever logged. */

var BR = (function () {
  if (typeof window !== "undefined") { window.BR = window.BR || {}; return window.BR; }
  globalThis.BR = globalThis.BR || {}; return globalThis.BR;
})();

BR.PROVIDERS = {
  groq: {
    id: "groq",
    label: "Groq",
    defaultModel: "openai/gpt-oss-120b"
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    defaultModel: "gemini-2.0-flash"
  }
};

BR.CALL_TIMEOUT_MS = 90000;

BR.providerById = function (id) {
  return BR.PROVIDERS[id] || BR.PROVIDERS.groq;
};

/* Map a provider HTTP status (carried by the server function) to a
   plain-English error. */
BR.mapProviderError = function (providerId, status, bodyText) {
  var label = BR.providerById(providerId).label;
  var body = (bodyText || "").slice(0, 400);
  if (status === 401 || status === 403) {
    return { code: "bad_key", message: "The server key was rejected by " + label + ". Check the key in the deployment's environment and try again." };
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

/* Map a server-function error code to a plain-English error. */
BR.mapProxyError = function (providerId, code) {
  var label = BR.providerById(providerId).label;
  if (code === "not_configured") {
    return { code: "not_configured", message: "No server key is configured for " + label + ". Add it to the deployment's environment (see README), or switch provider." };
  }
  if (code === "proxy_rate_limit") {
    return { code: "rate_limit", message: "Too many requests to this deployment. Wait a minute, then retry this step." };
  }
  if (code === "timeout") {
    return { code: "timeout", message: "The provider took too long to respond. Retry this step." };
  }
  if (code === "provider_unreachable") {
    return { code: "network", message: "The provider could not be reached through the server. Retry this step." };
  }
  if (code === "bad_request") {
    return { code: "bad_request", message: "The server rejected this request. Check the model name and try again." };
  }
  return { code: "proxy_error", message: "The server function returned an error (" + code + "). Retry this step." };
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

/* One LLM call through this deployment's own server function, with a
   timeout. Never logs the request body. */
BR.callLLM = function (providerId, model, systemPrompt, userPrompt) {
  var provider = BR.providerById(providerId);
  var controller = null;
  var signal = null;
  if (typeof AbortController !== "undefined") {
    controller = new AbortController();
    signal = controller.signal;
    setTimeout(function () { try { controller.abort(); } catch (e) { /* ignore */ } }, BR.CALL_TIMEOUT_MS);
  }
  return fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: provider.id, model: model, system: systemPrompt, user: userPrompt }),
    signal: signal
  }).then(function (res) {
    return res.json().then(function (data) {
      if (!res.ok) {
        if (data && data.error && data.error.code) {
          return { ok: false, error: BR.mapProxyError(provider.id, data.error.code) };
        }
        return { ok: false, error: { code: "http_" + res.status, message: "The server function returned HTTP " + res.status + ". Retry this step." } };
      }
      if (data && data.ok && typeof data.text === "string" && data.text.length > 0) {
        return { ok: true, text: data.text };
      }
      if (data && typeof data.status === "number") {
        if (data.status === 200 && !data.body) {
          return { ok: false, error: { code: "empty_response", message: provider.label + " returned an empty response. Retry this step." } };
        }
        return { ok: false, error: BR.mapProviderError(provider.id, data.status, data.body) };
      }
      return { ok: false, error: { code: "proxy_error", message: "The server function returned an unusable response. Retry this step." } };
    });
  }).catch(function (err) {
    if (err && err.name === "AbortError") {
      return { ok: false, error: { code: "timeout", message: "Request timed out. Check your connection and retry this step." } };
    }
    return { ok: false, error: { code: "network", message: "Network error reaching this deployment's server function. Check your connection and retry this step." } };
  });
};
