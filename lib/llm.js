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
// (whatever it is — parsing happens in postprocess.js), latency, the finish
// reason, and t_prompt, or throws with a short reason on timeout/network/HTTP
// failure.
//
// t_prompt (ms) times buildRequest()+JSON.stringify() alone — building the
// system prompt (lib/prompt.js's systemPrompt, called from buildRequest) is
// pure, synchronous string work, no I/O, so this should be near-zero; it's
// split out from `latencyMs` so a slow request's time is attributed to the
// actual network round trip, not wrongly blamed on prompt assembly.
//
// latencyMs (and t_gen downstream in api/draft.js) used to be measured as
// `await fetch(...)` resolving — that's when the response HEADERS arrive
// (time to first byte), not when the body finishes. For a non-streaming
// completions call the body only finishes once the model is done
// generating every token, so that gap — `await res.json()` actually reading
// and parsing the body — is most of a slow request's real latency, and it
// was being silently folded into whatever ran next rather than measured.
// Split here into t_ttfb (fetch() resolving) and t_body (res.json()
// resolving) so that's visible; latencyMs stays their sum for backward
// compatibility with existing callers.
async function callLLM(apiKey, model, sentText) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
  const promptStarted = Date.now();
  let t_prompt = 0;
  let started = promptStarted;
  let ttfbAt = null;
  try {
    const body = JSON.stringify(buildRequest(model, sentText));
    t_prompt = Date.now() - promptStarted;
    started = Date.now();
    const res = await fetch(CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://almostsent.app",
        "X-Title": "almost sent"
      },
      body: body,
      signal: controller.signal,
      dispatcher: dispatcher
    });
    ttfbAt = Date.now();
    const t_ttfb = ttfbAt - started;
    if (!res.ok) {
      const errBody = await res.text().catch(function () { return ""; });
      throw new Error("llm " + res.status + ": " + errBody.slice(0, 200));
    }
    const data = await res.json();
    const t_body = Date.now() - ttfbAt;
    if (data && data.error) {
      throw new Error("llm: " + (data.error.message || "error"));
    }
    const choice = data && data.choices && data.choices[0];
    if (!choice) throw new Error("no choices returned");
    const text = extractText(choice.message);
    // OpenRouter routes a single model id across multiple upstream
    // providers and can switch between calls; it echoes which one actually
    // served the request back in `provider`. Surfaced up through `why` so
    // routing changes mid-session are visible without a separate log.
    const provider = (data && data.provider) || null;
    return {
      text: text, latencyMs: t_ttfb + t_body, t_ttfb: t_ttfb, t_body: t_body,
      finishReason: choice.finish_reason, provider: provider, t_prompt: t_prompt
    };
  } catch (err) {
    const now = Date.now();
    const t_ttfb = ttfbAt !== null ? ttfbAt - started : now - started;
    const t_body = ttfbAt !== null ? now - ttfbAt : 0;
    const latencyMs = t_ttfb + t_body;
    const isAbort = err && err.name === "AbortError";
    const isDispatcherTimeout = err && /^UND_ERR_(HEADERS|BODY|CONNECT)_TIMEOUT$/.test(err.code || "");
    if (isAbort || isDispatcherTimeout) {
      const reason = isAbort ? "abort" : err.code;
      const timeoutErr = new Error("timeout after " + TIMEOUT_MS + "ms (" + reason + ")");
      timeoutErr.latencyMs = latencyMs;
      timeoutErr.t_ttfb = t_ttfb;
      timeoutErr.t_body = t_body;
      timeoutErr.t_prompt = t_prompt;
      throw timeoutErr;
    }
    if (err && err.latencyMs === undefined) err.latencyMs = latencyMs;
    if (err && err.t_ttfb === undefined) err.t_ttfb = t_ttfb;
    if (err && err.t_body === undefined) err.t_body = t_body;
    if (err && err.t_prompt === undefined) err.t_prompt = t_prompt;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { callLLM, BASE_URL, CHAT_URL, TIMEOUT_MS };
