"use strict";

/* Boardroom server function: POST /api/chat.
   Keys live only in the server environment (GROQ_API_KEY,
   OPENROUTER_API_KEY, GEMINI_API_KEY). No key appears in the repo,
   the page, the browser's storage, or any request the browser makes
   to a third party.
   No request or response body is ever logged here.
   When Groq is rate-limited or errors, the function automatically
   tries free OpenRouter models (OPENROUTER_FREE_CHAIN below) in one
   call with OpenRouter's models array. The chain lists free models
   only, so the function never spends money on its own. Each success
   response names the provider and model that served it, so a
   fallback is visible, never silent. No HTTP-Referer or title header
   is sent to OpenRouter, so nothing about this deployment leaks to a
   third party through request headers. */

var MAX_MODEL = 200;
var MAX_SYSTEM = 8000;
var MAX_USER = 12000;
var MAX_PROVIDER_BODY = 400;
var ATTEMPT_TIMEOUT_MS = 25000;
var FUNCTION_DEADLINE_MS = 55000;
var RATE_WINDOW_MS = 10 * 60 * 1000;
var RATE_MAX = 120;

/* Free-only fallback chain, verified against OpenRouter's live model
   catalog at build time. Every id ends in :free. The free roster
   rotates, so if fallback starts failing, re-check the live list at
   openrouter.ai/models with the free filter before assuming an
   outage. Keep in sync with js/providers.js; the harness asserts the
   two lists match. */
var OPENROUTER_FREE_CHAIN = [
  "google/gemma-4-31b-it:free",
  "dots-studio/dots-3-note-preview:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free"
];

/* Per-instance tripwire only: serverless instances do not share this
   map, so it cannot stop a determined caller. The real protection for
   a private deployment is keeping its URL private (see README). */
var buckets = new Map();

function clientIp(req) {
  var forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded) {
    return forwarded.split(",")[0].trim();
  }
  if (req.socket && req.socket.remoteAddress) {
    return req.socket.remoteAddress;
  }
  return "unknown";
}

function rateLimited(ip) {
  var now = Date.now();
  buckets.forEach(function (entry, key) {
    if (entry.resetAt <= now) { buckets.delete(key); }
  });
  var entry = buckets.get(ip);
  if (!entry) {
    /* Bound the map: cleanup above only removes expired entries, so
       refuse to grow past 5000 live entries and fail open instead of
       growing without bound on a long-lived instance. */
    if (buckets.size >= 5000) { return false; }
    buckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_MAX;
}

function send(res, status, body) {
  res.status(status).json(body);
}

function fail(res, status, code, message) {
  send(res, status, { ok: false, error: { code: code, message: message } });
}

function isUsableString(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function providerError(status, bodyText) {
  return { ok: false, status: status, body: (bodyText || "").slice(0, MAX_PROVIDER_BODY) };
}

/* Models array for an OpenRouter call. A requested free model goes
   first, then the rest of the free chain. A requested paid model is
   sent alone: the chain never adds a paid model, and a paid choice
   stays the user's explicit choice. */
function openRouterModelsFor(requested) {
  if (typeof requested === "string" && requested && /:free$/.test(requested)) {
    var out = [requested];
    OPENROUTER_FREE_CHAIN.forEach(function (m) {
      if (out.indexOf(m) === -1) { out.push(m); }
    });
    /* OpenRouter rejects a models array longer than 3 items with HTTP
       400, so cap every models array at 3, even when a requested free
       model is prepended to the chain. */
    return out.slice(0, 3);
  }
  if (typeof requested === "string" && requested) { return [requested]; }
  return OPENROUTER_FREE_CHAIN.slice();
}

async function callGroq(key, model, system, user, signal) {
  var resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + key
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      temperature: 0.7,
      max_tokens: 2048
    }),
    signal: signal
  });
  if (!resp.ok) {
    return providerError(resp.status, await resp.text());
  }
  var data = await resp.json();
  var content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (typeof content !== "string" || content.length === 0) {
    return { ok: false, status: 200, body: "" };
  }
  return { ok: true, text: content };
}

async function callGemini(key, model, system, user, signal) {
  var cleanModel = String(model).replace(/^models\//, "");
  var url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(cleanModel) + ":generateContent";
  var resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ parts: [{ text: user }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
    }),
    signal: signal
  });
  if (!resp.ok) {
    return providerError(resp.status, await resp.text());
  }
  var data = await resp.json();
  var parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  var text = "";
  if (Array.isArray(parts)) {
    parts.forEach(function (p) {
      if (p && typeof p.text === "string") { text += p.text; }
    });
  }
  if (!text) {
    return { ok: false, status: 200, body: "" };
  }
  return { ok: true, text: text };
}

/* One OpenRouter call carrying the whole models array. OpenRouter
   walks the array in order on any error (rate limit, downtime,
   moderation, context length) and reports the model that actually
   served the request in the response model field. Only the
   Authorization and Content-Type headers are sent. */
async function callOpenRouter(key, models, system, user, signal) {
  var resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + key
    },
    body: JSON.stringify({
      model: models[0],
      models: models,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      temperature: 0.7,
      max_tokens: 2048
    }),
    signal: signal
  });
  if (!resp.ok) {
    return providerError(resp.status, await resp.text());
  }
  var data = await resp.json();
  var content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (typeof content !== "string" || content.length === 0) {
    return { ok: false, status: 200, body: "" };
  }
  var served = (data && typeof data.model === "string" && data.model) ? data.model : models[0];
  return { ok: true, text: content, servedModel: served };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    fail(res, 405, "method_not_allowed", "Only POST is allowed.");
    return;
  }
  var body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (e) {
      fail(res, 400, "bad_request", "Request body is not valid JSON.");
      return;
    }
  }
  if (!body || typeof body !== "object") {
    fail(res, 400, "bad_request", "Request body must be a JSON object.");
    return;
  }
  if (body.provider !== "groq" && body.provider !== "gemini" && body.provider !== "openrouter") {
    fail(res, 400, "bad_request", "Provider must be groq, gemini, or openrouter.");
    return;
  }
  if (!isUsableString(body.model, MAX_MODEL)) {
    fail(res, 400, "bad_request", "Model name is missing or too long.");
    return;
  }
  if (!isUsableString(body.system, MAX_SYSTEM) || !isUsableString(body.user, MAX_USER)) {
    fail(res, 400, "bad_request", "Prompt text is missing or too long.");
    return;
  }
  if (rateLimited(clientIp(req))) {
    res.setHeader("Retry-After", "60");
    fail(res, 429, "proxy_rate_limit", "Too many requests from this address. Wait a minute and retry.");
    return;
  }

  /* Every attempt runs under the function deadline, so the Groq
     attempt plus the OpenRouter attempt always finish inside the
     function limit. A slow or hanging attempt is aborted, never
     allowed to eat the whole budget. A single attempt with no second
     leg behind it (Gemini, OpenRouter direct, or Groq with no
     OpenRouter key) uses the full deadline, so its behavior is
     unchanged from before the fallback existed. */
  var deadline = Date.now() + FUNCTION_DEADLINE_MS;
  var runAttempt = async function (fn, capMs) {
    var remaining = deadline - Date.now();
    if (remaining < 5000) {
      return { ok: false, status: 0, body: "deadline", deadline: true };
    }
    var cap = (typeof capMs === "number" && capMs > 0) ? capMs : FUNCTION_DEADLINE_MS;
    var ms = Math.min(cap, remaining);
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, ms);
    try {
      var result = await fn(controller.signal);
      clearTimeout(timer);
      return result;
    } catch (err) {
      clearTimeout(timer);
      if (err && err.name === "AbortError") {
        return { ok: false, status: 0, body: "timeout", timeout: true };
      }
      return { ok: false, status: 0, body: "unreachable", unreachable: true };
    }
  };

  /* Gemini: single attempt, unchanged behavior. */
  if (body.provider === "gemini") {
    var geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
      fail(res, 500, "not_configured", "No server key is configured for this provider.");
      return;
    }
    var geminiResult = await runAttempt(function (signal) {
      return callGemini(geminiKey, body.model, body.system, body.user, signal);
    });
    if (geminiResult.ok) {
      send(res, 200, { ok: true, text: geminiResult.text, servedBy: { provider: "gemini", model: body.model } });
      return;
    }
    if (geminiResult.timeout) {
      fail(res, 504, "timeout", "The provider took too long to respond.");
      return;
    }
    if (geminiResult.unreachable || geminiResult.deadline) {
      fail(res, 502, "provider_unreachable", "The provider could not be reached.");
      return;
    }
    send(res, 200, { ok: false, status: geminiResult.status, body: geminiResult.body });
    return;
  }

  /* OpenRouter direct: one call carrying the models array. */
  if (body.provider === "openrouter") {
    var openRouterKey = process.env.OPENROUTER_API_KEY;
    if (!openRouterKey) {
      fail(res, 500, "not_configured", "No server key is configured for this provider.");
      return;
    }
    var directModels = openRouterModelsFor(body.model);
    var directResult = await runAttempt(function (signal) {
      return callOpenRouter(openRouterKey, directModels, body.system, body.user, signal);
    });
    if (directResult.ok) {
      send(res, 200, { ok: true, text: directResult.text, servedBy: { provider: "openrouter", model: directResult.servedModel } });
      return;
    }
    if (directResult.timeout) {
      fail(res, 504, "timeout", "The provider took too long to respond.");
      return;
    }
    if (directResult.unreachable || directResult.deadline) {
      fail(res, 502, "provider_unreachable", "The provider could not be reached.");
      return;
    }
    send(res, 200, { ok: false, status: directResult.status, body: directResult.body });
    return;
  }

  /* Groq primary with automatic OpenRouter free fallback. The
     fallback triggers only on capacity or availability failures
     (rate limit, server error, timeout, unreachable). A rejected key
     or a bad model name fails fast: switching providers cannot fix
     a configuration error, and the error must say so plainly. */
  var groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    fail(res, 500, "not_configured", "No server key is configured for this provider.");
    return;
  }
  /* The fallback is completely inert when its key is unset: the Groq
     attempt keeps the full deadline, exactly as before, and no
     OpenRouter call is ever made. Only when the key exists is the
     Groq attempt capped at 25 seconds, leaving room for the fallback
     leg inside the same deadline. */
  var fallbackKey = process.env.OPENROUTER_API_KEY;
  var primary = await runAttempt(function (signal) {
    return callGroq(groqKey, body.model, body.system, body.user, signal);
  }, fallbackKey ? ATTEMPT_TIMEOUT_MS : FUNCTION_DEADLINE_MS);
  if (primary.ok) {
    send(res, 200, { ok: true, text: primary.text, servedBy: { provider: "groq", model: body.model } });
    return;
  }
  if (primary.status === 401 || primary.status === 403 || primary.status === 400 || primary.status === 404) {
    send(res, 200, { ok: false, status: primary.status, body: primary.body });
    return;
  }
  if (!fallbackKey) {
    if (primary.timeout) {
      fail(res, 504, "timeout", "The provider took too long to respond.");
      return;
    }
    if (primary.unreachable || primary.deadline) {
      fail(res, 502, "provider_unreachable", "The provider could not be reached.");
      return;
    }
    send(res, 200, { ok: false, status: primary.status, body: primary.body, fallbackSkipped: "no_openrouter_key" });
    return;
  }
  var fallback = await runAttempt(function (signal) {
    return callOpenRouter(fallbackKey, OPENROUTER_FREE_CHAIN.slice(), body.system, body.user, signal);
  }, ATTEMPT_TIMEOUT_MS);
  if (fallback.ok) {
    send(res, 200, { ok: true, text: fallback.text, servedBy: { provider: "openrouter", model: fallback.servedModel } });
    return;
  }
  /* Chain exhausted: report the primary failure, flagged, plus the
     exact fallback status and truncated fallback body, so the page
     can say what the fallback actually returned instead of only
     "exhausted". When the primary had no HTTP status (timeout or
     unreachable), report the fallback outcome instead, still
     flagged, with the same fallback fields. */
  if (primary.timeout || primary.unreachable || primary.deadline) {
    if (fallback.timeout) {
      fail(res, 504, "timeout", "The provider took too long to respond.");
      return;
    }
    if (fallback.unreachable || fallback.deadline) {
      fail(res, 502, "provider_unreachable", "The provider could not be reached.");
      return;
    }
    send(res, 200, { ok: false, status: fallback.status, body: fallback.body, fallbackExhausted: true, fallbackStatus: fallback.status, fallbackBody: fallback.body });
    return;
  }
  send(res, 200, { ok: false, status: primary.status, body: primary.body, fallbackExhausted: true, fallbackStatus: fallback.status, fallbackBody: fallback.body });
};

/* When a fallback leg follows, the Groq attempt is capped at 25
   seconds inside a 55 second function deadline, under the 60 second
   function limit. A single attempt with no fallback uses the full
   deadline, so Groq behavior without an OpenRouter key is unchanged. */
module.exports.config = { maxDuration: 60 };
module.exports.OPENROUTER_FREE_CHAIN = OPENROUTER_FREE_CHAIN;
/* Test hook only: the deployed handler never calls this. It lets the
   harness prove the bucket cap without firing 5000 real requests. */
module.exports._rateLimitedForTest = rateLimited;
