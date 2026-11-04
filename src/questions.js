// The three per-article questions, as plain data so both judgment engines
// that speak TypeSafe's question types (TypeSafe/Jev in judge.js, a local
// JevK5 in judgeJevK5.js) ask exactly the same thing.
export const SENTIMENT = {
  type: "choice",
  instructions:
    "Considering `headline` about `ticker` (`company`), does this news suggest the stock or " +
    "asset's price is more likely to rise, fall, or stay roughly flat?",
  criteria: {
    bull: "The news is positive for the company or asset and likely to support a higher price.",
    bear: "The news is negative for the company or asset and likely to pressure the price lower.",
    neu: "The news is neutral, mixed, routine, or unlikely to move the price meaningfully either way.",
  },
};

export const CONVICTION = {
  type: "score",
  instructions:
    "How significant and market-moving is `headline` about `ticker`, independent of whether it is " +
    "positive or negative?",
  criteria: [
    "Routine or minor news with little expected price impact.",
    "Notable news likely to draw investor attention but not decisive on its own.",
    "Major, market-moving news likely to have a significant, direct impact on the price.",
  ],
};

export const REGULATORY = {
  type: "noul",
  instructions:
    "Does `headline` mention a regulatory action, government investigation, lawsuit, or enforcement " +
    "action affecting `ticker` (`company`)?",
};
