// Node's own global fetch is backed by its own internal, bundled copy of
// undici — it rejects a dispatcher built from this separately installed
// undici package (different class, so it just fails with a generic "fetch
// failed"). Use undici's own fetch here too so the fetch call and the
// dispatcher it's given come from the same undici instance.
const { fetch, Agent } = require("undici");
const { buildRequest } = require("./prompt");

const BASE_URL = (process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
const CHAT_URL = BASE_URL + "/chat/completions";
const TIMEOUT_MS = 12000;

// AbortController alone has been observed to not be enough: a connection
// that stalls (a dead keep-alive socket reused from the pool, a proxy that
// swallows the response) can leave the fetch promise never settling even
// after controller.abort() fires, hanging the whole process. These are
// socket-level timeouts enforced by undici itself, independent of the
// abort signal — a real backstop against exactly that failure mode, not
// just a second copy of the same mechanism.
const dispatcher = new Agent({
  connect: { timeout: TIMEOUT_MS },
  headersTimeout: TIMEOUT_MS,
  bodyTimeout: TIMEOUT_MS
});

// Some reasoning models leave `content` empty and put everything in a
// separate `reasoning` field if the token budget runs out before the
// answer — fall back to it rather than silently returning nothing.
function extractText(message) {
  if (!message) return "";
  let text = message.content;
  if (Array.isArray(text)) {
    text = text.map(function (part) { return (part && part.text) || ""; }).join(" ");
  }
  text = String(text || "").trim();
  if (!text && message.reasoning) text = String(message.reasoning).trim();
  return text;
}

// Calls the LLM (any OpenAI-compatible chat/completions endpoint — default
// OpenRouter) for one model + one input. Returns the raw assistant text
// (whatever it is — parsing happens in postprocess.js), latency, and the
// finish reason, or throws with a short reason on timeout/network/HTTP
// failure.
async function callLLM(apiKey, model, sentText) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://almostsent.app",
        "X-Title": "almost sent"
      },
      body: JSON.stringify(buildRequest(model, sentText)),
      signal: controller.signal,
      dispatcher: dispatcher
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const errBody = await res.text().catch(function () { return ""; });
      throw new Error("llm " + res.status + ": " + errBody.slice(0, 200));
    }
    const data = await res.json();
    if (data && data.error) {
      throw new Error("llm: " + (data.error.message || "error"));
    }
    const choice = data && data.choices && data.choices[0];
    if (!choice) throw new Error("no choices returned");
    const text = extractText(choice.message);
    return { text: text, latencyMs: latencyMs, finishReason: choice.finish_reason };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const isAbort = err && err.name === "AbortError";
    const isDispatcherTimeout = err && /^UND_ERR_(HEADERS|BODY|CONNECT)_TIMEOUT$/.test(err.code || "");
    if (isAbort || isDispatcherTimeout) {
      const reason = isAbort ? "abort" : err.code;
      const timeoutErr = new Error("timeout after " + TIMEOUT_MS + "ms (" + reason + ")");
      timeoutErr.latencyMs = latencyMs;
      throw timeoutErr;
    }
    if (err && err.latencyMs === undefined) err.latencyMs = latencyMs;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { callLLM, BASE_URL, CHAT_URL, TIMEOUT_MS };
