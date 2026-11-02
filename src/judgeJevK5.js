// Local judgment engine: JevK5 (github.com/allebee/jevk5, Apache-2.0), an
// open-weight Jev alternative, served from a GGUF by llama.cpp's llama-server:
//
//   llama-server -m jevk5-4b-v0.3-Q4_K_M.gguf -c 8192 -ngl 99 --port 8090
//
// This is a port of the project's own llama.cpp client (jevk5/gguf.py and
// jevk5/prompt.py at v0.3.x). Nothing is generated: the prompt lists the
// options as letters A, B, C…, the server returns the log-probabilities of the
// next token, and the options' letters are renormalised under the model's
// calibration temperature. So, like Jev, each answer is a probability
// distribution, not a self-reported confidence.
//
// Every question here has at most 3 options, so the upstream multi-pass
// "knockout" readout for more than 16 options is not needed and not ported.
import { JEVK5_URL, JEVK5_TEMPERATURE, JEVK5_TOP_K } from "./config.js";
import { SENTIMENT, CONVICTION, REGULATORY } from "./questions.js";

const LETTERS = "ABCDEFGHIJKLMNOP";
// A letter missing from the returned top-k sits at least this far below the
// lowest one returned (upstream MISSING_MARGIN).
const MISSING_MARGIN = 2.0;

// Pinned verbatim from jevk5/prompt.py: the system prompt and Qwen3.5's chat
// template with thinking off, so the tokens match what the model was trained on.
const SYSTEM =
  "Apply the supplied criterion to the supplied evidence. Choose exactly one listed option. " +
  "Respond with only its uppercase letter, with no explanation or reasoning.";
const chatTemplate = (system, user) =>
  `<|im_start|>system\n${system}<|im_end|>\n` +
  `<|im_start|>user\n${user}<|im_end|>\n` +
  `<|im_start|>assistant\n<think>\n\n</think>\n\n`;

// Python's json.dumps(..., ensure_ascii=False): same as JSON.stringify except
// for the ", " and ": " separators. Upstream builds the user message with
// Python, so this keeps the prompt byte-identical.
export function pyJson(value) {
  if (Array.isArray(value)) return "[" + value.map(pyJson).join(", ") + "]";
  if (value !== null && typeof value === "object") {
    return (
      "{" +
      Object.entries(value)
        .map(([k, v]) => JSON.stringify(k) + ": " + pyJson(v))
        .join(", ") +
      "}"
    );
  }
  return JSON.stringify(value);
}

// (option id, option text) pairs — upstream decision_options().
export function decisionOptions(question) {
  const crit = question.criteria;
  let pairs;
  if (question.type === "noul") {
    pairs = ["true", "false"].map((k) => [k, crit?.[k] || `The proposition is ${k}.`]);
  } else if (question.type === "choice") {
    const dict = Array.isArray(crit) ? Object.fromEntries(crit.map((k) => [k, null])) : crit;
    pairs = Object.entries(dict).map(([k, v]) => [k, v || k]);
  } else {
    pairs = crit.map((level, i) => [String(i), level]);
  }
  return pairs.map(([k, d]) => [k, `${k}: ${d}`]);
}

export function promptText(state, criterion, optionTexts) {
  const payload = {
    evidence: state,
    criterion,
    options: optionTexts.map((d, i) => ({ letter: LETTERS[i], description: d })),
  };
  return chatTemplate(SYSTEM, pyJson(payload));
}

async function post(path, body) {
  const res = await fetch(JEVK5_URL + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`llama-server ${path} returned HTTP ${res.status} (${JEVK5_URL})`);
  }
  return res.json();
}

// Next-token log-probabilities at the answer position, keyed by token text.
async function answerLogprobs(prompt) {
  // Tokenise with parse_special first, then send token ids: /completion treats
  // a prompt string as plain text and would split <|im_start|> into pieces.
  const { tokens } = await post("/tokenize", {
    content: prompt,
    add_special: false,
    parse_special: true,
  });
  const out = await post("/completion", {
    prompt: tokens,
    n_predict: 1,
    n_probs: JEVK5_TOP_K,
    temperature: 0,
    cache_prompt: false,
  });
  const top = out.completion_probabilities?.[0]?.top_logprobs;
  if (!Array.isArray(top)) {
    throw new Error("llama-server returned no top_logprobs; is it a recent llama.cpp build?");
  }
  return Object.fromEntries(top.map((e) => [e.token, e.logprob]));
}

// One question → { optionId: probability }, calibrated.
async function probabilities(state, question) {
  const options = decisionOptions(question);
  const seen = await answerLogprobs(promptText(state, question.instructions, options.map(([, t]) => t)));
  const floor = Math.min(0, ...Object.values(seen)) - MISSING_MARGIN;
  const logprobs = options.map((_, i) => seen[LETTERS[i]] ?? floor);
  const top = Math.max(...logprobs);
  const weights = logprobs.map((z) => Math.exp((z - top) / JEVK5_TEMPERATURE));
  const total = weights.reduce((a, b) => a + b, 0);
  return Object.fromEntries(options.map(([k], i) => [k, weights[i] / total]));
}

const argmax = (probs) => Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0];
const maxProb = (probs) => Math.max(...Object.values(probs));

// Same return shape as judge.js's TypeSafe path. The three questions go one
// after another: llama-server evaluates them on one GPU anyway.
export async function judgeArticleJevK5({ ticker, company, headline, source }) {
  const state = { ticker, company, headline, source };
  const sentiment = await probabilities(state, SENTIMENT);
  const conviction = await probabilities(state, CONVICTION);
  const regulatory = await probabilities(state, REGULATORY);
  return {
    sentiment: argmax(sentiment),
    sentimentConfidence: maxProb(sentiment),
    // Expected level, 0..2 — the same definition as upstream's `score`.
    convictionScore: Object.entries(conviction).reduce((s, [k, p]) => s + Number(k) * p, 0),
    convictionConfidence: maxProb(conviction),
    regulatoryProb: regulatory.true,
  };
}
