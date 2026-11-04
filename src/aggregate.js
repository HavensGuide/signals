const SIG_WORD = { bull: "bullish", bear: "bearish", neu: "mixed" };

function timeAgo(date) {
  const ms = Date.now() - date.getTime();
  const hours = Math.round(ms / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

// Combines one engine's per-article judgments into an explainable
// per-ticker signal. This is deterministic code, not another model call:
// TypeSafe's own guidance is to keep composition and thresholds in code so
// they stay reviewable and don't require re-running inference to retune.
// Engine-agnostic on purpose — called once per engine (Jev, optionally
// OpenAI) on the same underlying articles, so results are comparable.
export function summarizeJudgments(engineLabel, judgedArticles) {
  if (judgedArticles.length === 0) {
    return { sig: "neu", cv: 0, summary: "No recent coverage found for this ticker.", regulatoryFlag: false };
  }

  const weightedVotes = { bull: 0, bear: 0, neu: 0 };
  let convictionSum = 0;
  let convictionWeight = 0;
  let regulatoryFlag = false;

  for (const a of judgedArticles) {
    const { sentiment, sentimentConfidence, convictionScore, convictionConfidence, regulatoryProb } =
      a.judgment;
    weightedVotes[sentiment] += sentimentConfidence;
    convictionSum += (convictionScore / 2) * 100 * convictionConfidence;
    convictionWeight += convictionConfidence;
    if (regulatoryProb > 0.6) regulatoryFlag = true;
  }

  const sig = Object.entries(weightedVotes).sort((a, b) => b[1] - a[1])[0][0];
  const agreeCount = judgedArticles.filter((a) => a.judgment.sentiment === sig).length;
  const agreement = agreeCount / judgedArticles.length;
  const avgConviction = convictionWeight > 0 ? convictionSum / convictionWeight : 0;
  const cv = Math.max(0, Math.min(100, Math.round(avgConviction * agreement)));

  const anchor = judgedArticles
    .filter((a) => a.judgment.sentiment === sig)
    .sort((a, b) => b.judgment.sentimentConfidence - a.judgment.sentimentConfidence)[0];

  const bullCount = judgedArticles.filter((a) => a.judgment.sentiment === "bull").length;
  const bearCount = judgedArticles.filter((a) => a.judgment.sentiment === "bear").length;
  const neuCount = judgedArticles.filter((a) => a.judgment.sentiment === "neu").length;

  let summary =
    `${engineLabel}: coverage leans ${SIG_WORD[sig]} (${agreeCount} of ${judgedArticles.length} sources), ` +
    `anchored by "${anchor.headline}" (${anchor.source}). ` +
    `${bullCount} bullish, ${neuCount} neutral, ${bearCount} bearish overall.`;
  if (regulatoryFlag) {
    summary += " At least one source flags possible regulatory or legal action.";
  }

  return { sig, cv, summary, regulatoryFlag };
}

// The source list is shared between engines (both judge the same articles);
// each entry carries a tag per engine that actually judged it, so the UI
// can show them side by side.
export function buildSourceList(articles) {
  return articles
    .slice()
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .map((a) => ({
      so: a.source,
      h: a.headline,
      t: timeAgo(a.publishedAt),
      jevTag: a.jevJudgment?.sentiment ?? null,
      openaiTag: a.openaiJudgment?.sentiment ?? null,
    }));
}

export function buildTickerRecord(
  tickerMeta,
  quote,
  articles,
  { openaiEnabled, crowdSignal = null, jevLabel = "TypeSafe/Jev" },
) {
  const jevJudged = articles
    .filter((a) => a.jevJudgment)
    .map((a) => ({ ...a, judgment: a.jevJudgment }));
  const jev = summarizeJudgments(jevLabel, jevJudged);

  let openai = null;
  if (openaiEnabled) {
    const openaiJudged = articles
      .filter((a) => a.openaiJudgment)
      .map((a) => ({ ...a, judgment: a.openaiJudgment }));
    openai = summarizeJudgments("OpenAI", openaiJudged);
  }

  return {
    s: tickerMeta.s,
    n: quote.name || tickerMeta.n,
    sec: tickerMeta.sec,
    a: tickerMeta.a,
    p: quote.price,
    c: quote.changePct,
    jev,
    openai,
    // Third, externally-produced signal (TradingView rating / CoinGecko
    // votes) — passed through as-is, not aggregated from per-article
    // judgments like the two engines above. `provider` names the source.
    crowd: crowdSignal,
    src: buildSourceList(articles),
  };
}
