"use strict";

/* Boardroom server function: POST /api/chat.
   The page never holds an API key. It calls this function on its own
   deployment, and this function calls the chosen provider with a key
   that lives only in the server environment. No key appears in the
   repo, the page, the browser's storage, or any request the browser
   makes to a third party.
   No request or response body is ever logged here. */

var MAX_MODEL = 200;
var MAX_SYSTEM = 8000;
var MAX_USER = 12000;
var MAX_PROVIDER_BODY = 400;
var PROVIDER_TIMEOUT_MS = 60000;
var RATE_WINDOW_MS = 10 * 60 * 1000;
var RATE_MAX = 120;

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
  if (body.provider !== "groq" && body.provider !== "gemini") {
    fail(res, 400, "bad_request", "Provider must be groq or gemini.");
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
  var key = body.provider === "groq" ? process.env.GROQ_API_KEY : process.env.GEMINI_API_KEY;
  if (!key) {
    fail(res, 500, "not_configured", "No server key is configured for this provider.");
    return;
  }
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, PROVIDER_TIMEOUT_MS);
  var result;
  try {
    result = body.provider === "groq"
      ? await callGroq(key, body.model, body.system, body.user, controller.signal)
      : await callGemini(key, body.model, body.system, body.user, controller.signal);
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") {
      fail(res, 504, "timeout", "The provider took too long to respond.");
      return;
    }
    fail(res, 502, "provider_unreachable", "The provider could not be reached.");
    return;
  }
  clearTimeout(timer);
  if (!result.ok) {
    send(res, 200, { ok: false, status: result.status, body: result.body });
    return;
  }
  send(res, 200, { ok: true, text: result.text });
};

/* A full debate step can take well over the 10 second default on a
   free deployment, so allow up to 60 seconds per function call. */
module.exports.config = { maxDuration: 60 };
