import { JUDGE_ENGINE, TYPESAFE_API_KEY } from "./config.js";
import { SENTIMENT, CONVICTION, REGULATORY } from "./questions.js";
import { judgeArticleJevK5 } from "./judgeJevK5.js";

// Primary judgment engine, chosen by JUDGE_ENGINE in .env:
//   "typesafe" (default) — TypeSafe's hosted Jev, needs TYPESAFE_API_KEY
//   "jevk5"              — a local JevK5 GGUF behind llama-server (judgeJevK5.js)
// Both fill the dashboard's `jev` slot with the same judgment shape.
export const ENGINE_LABEL = JUDGE_ENGINE === "jevk5" ? "JevK5 (local)" : "TypeSafe/Jev";

let judgeTypeSafe = null;

if (JUDGE_ENGINE === "typesafe") {
  if (!TYPESAFE_API_KEY) {
    throw new Error(
      "TYPESAFE_API_KEY is not set. Copy .env.example to .env and add your TypeSafe API key " +
        "(https://docs.typesafe.ai) — it is read from the environment and never committed to git. " +
        "Or set JUDGE_ENGINE=jevk5 to judge with a local JevK5 model instead.",
    );
  }
  // Imported only on this path, so a JevK5-only setup needs no TypeSafe key.
  const { TypeSafeClient, choice, score, noul } = await import("@typesafe-ai/sdk");

  // TypeSafeClient reads TYPESAFE_API_KEY from the environment itself; passing
  // it explicitly here just makes the dependency visible at a glance.
  const client = new TypeSafeClient({ apiKey: TYPESAFE_API_KEY });
  const questions = {
    sentiment: choice(SENTIMENT.instructions, SENTIMENT.criteria),
    conviction: score(CONVICTION.instructions, CONVICTION.criteria),
    regulatory: noul(REGULATORY.instructions),
  };

  // One `systemOne` call asks all three questions in parallel against the same
  // article state — this is TypeSafe's recommended shape (independent
  // questions batched per request) rather than three serial round trips.
  judgeTypeSafe = async ({ ticker, company, headline, source }) => {
    const response = await client.systemOne({
      state: { ticker, company, headline, source },
      questions,
    });
    const { sentiment, conviction, regulatory } = response.answers;
    return {
      sentiment: sentiment.choice,
      sentimentConfidence: sentiment.confidence,
      convictionScore: conviction.score, // 0..2
      convictionConfidence: conviction.confidence,
      regulatoryProb: regulatory.noul,
    };
  };
} else if (JUDGE_ENGINE !== "jevk5") {
  throw new Error(`Unknown JUDGE_ENGINE "${JUDGE_ENGINE}" — use "typesafe" or "jevk5".`);
}

export function judgeArticle(input) {
  return JUDGE_ENGINE === "jevk5" ? judgeArticleJevK5(input) : judgeTypeSafe(input);
}
