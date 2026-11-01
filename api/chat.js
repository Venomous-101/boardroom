"use strict";

/* Boardroom server function: POST /api/chat.
   Keys live only in the server environment (GROQ_API_KEY,
   OPENROUTER_API_KEY, GEMINI_API_KEY). No key appears in the repo,
   the page, the browser's storage, or any request the browser makes
   to a third party.
   No request or response body is ever logged here.
   When Groq is rate-limited or errors, the function automatically
   walks free OpenRouter models (OPENROUTER_FREE_CHAIN below) one
   request at a time, best model first, until one serves the call.
   A long models array in a single request was rejected live with
   HTTP 400 on 29 Oct 2026, so no request ever carries more than
   one model. The chain lists free models only, so the function
   never spends money on its own. Each success response names the
   provider and model that served it, so a fallback is visible,
   never silent. No HTTP-Referer or title header is sent to
   OpenRouter, so nothing about this deployment leaks to a third
   party through request headers. */

var MAX_MODEL = 200;
var MAX_SYSTEM = 8000;
var MAX_USER = 12000;
var MAX_PROVIDER_BODY = 400;
var ATTEMPT_TIMEOUT_MS = 12000;
var WALK_LEG_CAP_MS = 20000;
var FUNCTION_DEADLINE_MS = 55000;
var RATE_WINDOW_MS = 10 * 60 * 1000;
var RATE_MAX = 120;

/* Free-only fallback chain, verified against OpenRouter's live model
   catalog on 1 Nov 2026: every id below was present in the live
   catalog with prompt and completion price 0. Order is best first
   by the catalog's own benchmark block (coding, agentic):
   Inkling 52.1/22.5, Nemotron Ultra 49.3/20.1, Gemma 4 31B
   43.4/4.2, Dots3-Note lightest. The free roster rotates, so if
   fallback starts failing, re-check the live list at
   openrouter.ai/models with the free filter before assuming an
   outage. Dots3-Note Preview carries a preview expiry of
   2026-12-31 in the catalog; when it goes, drop it from the chain
   rather than letting the walk end on it. Keep in sync with
   js/providers.js; the harness asserts the two lists match. */
var OPENROUTER_FREE_CHAIN = [
  "thinkingmachines/inkling:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "google/gemma-4-31b-it:free",
  "dots-studio/dots-3-note-preview:free"
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

/* Walk order for an OpenRouter call. A requested free model goes
   first, then the rest of the free chain. A requested paid model is
   sent alone: the chain never adds a paid model, and a paid choice
   stays the user's explicit choice. The walk tries these in order,
   one request each, never more than one model per request. */
function openRouterWalkFor(requested) {
  if (typeof requested === "string" && requested && /:free$/.test(requested)) {
    var out = [requested];
    OPENROUTER_FREE_CHAIN.forEach(function (m) {
      if (out.indexOf(m) === -1) { out.push(m); }
    });
    return out;
  }
  if (typeof requested === "string" && requested) { return [requested]; }
  return OPENROUTER_FREE_CHAIN.slice();
}

/* Whether an OpenRouter failure is worth trying the next model for.
   Rate limits, server errors, timeouts, unreachable hosts, empty
   replies, and unknown model ids (404: the id rotated out of the
   free roster) can all clear on the next model. Auth failures,
   bad requests, and payment blocks cannot: they describe the key
   or the request, not the model, so the walk stops on them. */
function openRouterRetryable(result) {
  if (!result) { return false; }
  if (result.timeout || result.unreachable || result.deadline) { return true; }
  if (result.ok) { return false; }
  if (result.status === 429 || result.status === 404) { return true; }
  if (result.status >= 500) { return true; }
  if (result.status === 200) { return true; }
  return false;
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

/* One OpenRouter call for exactly one model. No models array is ever
   sent: a long array in a single request was rejected live with
   HTTP 400, so the walk below sends one model per request and moves
   on when that model fails. Only the Authorization and Content-Type
   headers are sent. */
async function callOpenRouter(key, model, system, user, signal) {
  var resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
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
  var served = (data && typeof data.model === "string" && data.model) ? data.model : model;
  return { ok: true, text: content, servedModel: served };
}

/* Sequential OpenRouter walk: try each model in order, one request
   each, until one serves. Bounded twice: at most one attempt per
   model in the list, and the runAttempt deadline guard stops the
   walk when the function deadline approaches, so the walk can never
   loop forever. Returns the success with its model and attempt
   count, or the last failure with the attempt count, so the caller
   can report honestly how many free models were tried. */
async function walkOpenRouter(key, models, system, user, runAttempt) {
  var last = null;
  var attempts = 0;
  for (var i = 0; i < models.length; i++) {
    var model = models[i];
    var result = await runAttempt(function (signal) {
      return callOpenRouter(key, model, system, user, signal);
    }, WALK_LEG_CAP_MS);
    attempts += 1;
    if (result.ok) {
      return { ok: true, text: result.text, servedModel: result.servedModel, attempts: attempts };
    }
    last = result;
    if (result.deadline) {
      return { ok: false, deadline: true, attempts: attempts, last: last };
    }
    if (!openRouterRetryable(result)) {
      return { ok: false, status: result.status, body: result.body, attempts: attempts, last: last };
    }
  }
  if (last && last.timeout) {
    return { ok: false, timeout: true, attempts: attempts, last: last };
  }
  if (last && (last.unreachable || last.deadline)) {
    return { ok: false, unreachable: true, attempts: attempts, last: last };
  }
  return { ok: false, status: last ? last.status : 0, body: last ? last.body : "", attempts: attempts, last: last };
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

  /* OpenRouter direct: walk the requested model first, then the free
     chain, one request per model, until one serves. A requested paid
     model walks alone, so a paid choice stays the user's explicit
     choice. */
  if (body.provider === "openrouter") {
    var openRouterKey = process.env.OPENROUTER_API_KEY;
    if (!openRouterKey) {
      fail(res, 500, "not_configured", "No server key is configured for this provider.");
      return;
    }
    var directModels = openRouterWalkFor(body.model);
    var directResult = await walkOpenRouter(openRouterKey, directModels, body.system, body.user, runAttempt);
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
    send(res, 200, { ok: false, status: directResult.status, body: directResult.body, walkAttempts: directResult.attempts, walkExhausted: directResult.attempts >= directModels.length });
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
     Groq attempt capped at 12 seconds, leaving room for the walk
     legs (20 seconds each) inside the same deadline. */
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
  var fallback = await walkOpenRouter(fallbackKey, OPENROUTER_FREE_CHAIN.slice(), body.system, body.user, runAttempt);
  if (fallback.ok) {
    send(res, 200, { ok: true, text: fallback.text, servedBy: { provider: "openrouter", model: fallback.servedModel } });
    return;
  }
  /* Walk exhausted or stopped: report the primary failure, flagged,
     plus the exact last walk status, truncated walk body, and how
     many free models were tried, so the page can say what the walk
     actually did instead of only "exhausted". When the primary had
     no HTTP status (timeout or unreachable), report the walk
     outcome instead, still flagged, with the same walk fields. */
  var walkExhausted = fallback.attempts >= OPENROUTER_FREE_CHAIN.length;
  var walkStatus = fallback.last ? fallback.last.status : fallback.status;
  var walkBody = fallback.last ? fallback.last.body : fallback.body;
  if (primary.timeout || primary.unreachable || primary.deadline) {
    if (fallback.timeout) {
      fail(res, 504, "timeout", "The provider took too long to respond.");
      return;
    }
    if (fallback.unreachable || fallback.deadline) {
      fail(res, 502, "provider_unreachable", "The provider could not be reached.");
      return;
    }
    send(res, 200, { ok: false, status: walkStatus, body: walkBody, fallbackExhausted: walkExhausted, fallbackStatus: walkStatus, fallbackBody: walkBody, fallbackAttempts: fallback.attempts });
    return;
  }
  send(res, 200, { ok: false, status: primary.status, body: primary.body, fallbackExhausted: walkExhausted, fallbackStatus: walkStatus, fallbackBody: walkBody, fallbackAttempts: fallback.attempts });
};

/* When a fallback walk follows, the Groq attempt is capped at 12
   seconds and each walk leg at 20 seconds, inside a 55 second
   function deadline, under the 60 second function limit. A single
   attempt with no fallback uses the full deadline, so Groq behavior
   without an OpenRouter key is unchanged. */
module.exports.config = { maxDuration: 60 };
module.exports.OPENROUTER_FREE_CHAIN = OPENROUTER_FREE_CHAIN;
/* Test hook only: the deployed handler never calls this. It lets the
   harness prove the bucket cap without firing 5000 real requests. */
module.exports._rateLimitedForTest = rateLimited;
