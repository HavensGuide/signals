import { XMLParser } from "fast-xml-parser";
import { fetchJson, fetchText } from "../lib/httpJson.js";
import {
  SEC_USER_AGENT,
  MAX_FILINGS_PER_TICKER,
  FILING_LOOKBACK_DAYS,
  RELEVANT_FILING_FORMS,
} from "../config.js";

const secHeaders = { "User-Agent": SEC_USER_AGENT, Accept: "application/json" };
const xmlParser = new XMLParser({ ignoreAttributes: false });

let tickerCikMapPromise = null;

// SEC's official ticker->CIK map, refreshed periodically on their end.
// Cached in-process for the lifetime of one pipeline run.
function loadTickerCikMap() {
  if (!tickerCikMapPromise) {
    tickerCikMapPromise = fetchJson("https://www.sec.gov/files/company_tickers.json", {
      headers: secHeaders,
    }).then((data) => {
      const map = new Map();
      for (const entry of Object.values(data)) {
        map.set(String(entry.ticker).toUpperCase(), String(entry.cik_str).padStart(10, "0"));
      }
      return map;
    });
  }
  return tickerCikMapPromise;
}

const TRANSACTION_CODE_LABELS = {
  P: "open-market purchase",
  S: "open-market sale",
  A: "award/grant",
  M: "option exercise",
  G: "gift",
  F: "tax withholding",
  C: "conversion",
};

function asArray(value) {
  return Array.isArray(value) ? value : value != null ? [value] : [];
}

// Form 4s report insider trades; the submissions API only gives us "a Form
// 4 was filed", so we fetch the filing's own XML for the actual buy/sell
// detail — much sharper signal than the bare form type.
async function describeForm4(cikNumeric, accessionNumber, primaryDocument) {
  const accessionNoDashes = accessionNumber.replace(/-/g, "");
  // The primaryDocument path may point at an XSLT-rendering folder
  // (e.g. "xslF345X06/foo.xml"); the raw data file lives at the same name
  // directly under the accession folder.
  const fileName = primaryDocument.split("/").pop();
  const url = `https://www.sec.gov/Archives/edgar/data/${cikNumeric}/${accessionNoDashes}/${fileName}`;
  const xml = await fetchText(url, { headers: secHeaders });
  const doc = xmlParser.parse(xml)?.ownershipDocument;
  if (!doc) return null;

  const ownerName = asArray(doc.reportingOwner)[0]?.reportingOwnerId?.rptOwnerName || "An insider";
  const relationship = asArray(doc.reportingOwner)[0]?.reportingOwnerRelationship;
  const title = Number(relationship?.isOfficer) === 1 ? relationship.officerTitle || "officer" : Number(relationship?.isDirector) === 1 ? "director" : "insider";

  const transactions = asArray(doc.nonDerivativeTable?.nonDerivativeTransaction);
  if (transactions.length === 0) return null;

  let acquired = 0;
  let disposed = 0;
  const codes = new Set();
  for (const t of transactions) {
    const shares = Number(t.transactionAmounts?.transactionShares?.value) || 0;
    const code = t.transactionAmounts?.transactionAcquiredDisposedCode?.value;
    const txnCode = t.transactionCoding?.transactionCode;
    if (txnCode) codes.add(TRANSACTION_CODE_LABELS[txnCode] || txnCode);
    if (code === "A") acquired += shares;
    else if (code === "D") disposed += shares;
  }

  const net = acquired - disposed;
  const direction = net > 0 ? `net acquired ${net.toLocaleString()} shares` : net < 0 ? `net disposed of ${Math.abs(net).toLocaleString()} shares` : "reported an offsetting transaction";
  const codeLabel = codes.size ? ` (${[...codes].join(", ")})` : "";

  return `${ownerName} (${title}) ${direction}${codeLabel}`;
}

// Submissions JSON per CIK. Live runs fetch it fresh each time; the backfill
// passes `cache` so one download serves every replayed date.
// `recent` holds only a filer's latest ~1000 filings, which for heavy Form 4
// filers can stop short of the backfill window; with `sinceMs`, older pages
// (filings.files) overlapping the window are fetched and appended in order.
async function loadSubmissions(cik, cache, sinceMs = null) {
  if (cache?.has(cik)) return cache.get(cik);
  const data = await fetchJson(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: secHeaders });
  const recent = data?.filings?.recent;
  if (recent && sinceMs !== null) {
    const since = new Date(sinceMs).toISOString().slice(0, 10);
    const oldest = recent.filingDate.at(-1);
    if (oldest && oldest > since) {
      for (const page of data.filings.files ?? []) {
        if (page.filingTo < since) continue;
        const older = await fetchJson(`https://data.sec.gov/submissions/${page.name}`, { headers: secHeaders });
        for (const key of ["form", "filingDate", "accessionNumber", "primaryDocument"]) recent[key].push(...(older[key] ?? []));
      }
    }
  }
  cache?.set(cik, data);
  return data;
}
const form4Cache = new Map(); // accession -> description (filings never change)

// `asOfMs` (backfill only): return the filings as they stood just before
// that moment. filingDate is a calendar day, so a filing counts only if its
// day is strictly before asOfMs's UTC day.
export async function getRecentFilings(ticker, { asOfMs = null, cache = null, sinceMs = null } = {}) {
  const cikMap = await loadTickerCikMap();
  const cik = cikMap.get(ticker.toUpperCase());
  if (!cik) return [];
  const cikNumeric = String(Number(cik));

  const data = await loadSubmissions(cik, cache, sinceMs);
  const recent = data?.filings?.recent;
  if (!recent) return [];

  const now = asOfMs ?? Date.now();
  const cutoff = now - FILING_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const dayStart = asOfMs === null ? Infinity : Date.UTC(new Date(asOfMs).getUTCFullYear(), new Date(asOfMs).getUTCMonth(), new Date(asOfMs).getUTCDate());
  const filerName = data.name || ticker;
  const filings = [];
  for (let i = 0; i < recent.form.length && filings.length < MAX_FILINGS_PER_TICKER; i++) {
    const form = recent.form[i];
    const filedAt = new Date(recent.filingDate[i]);
    if (!RELEVANT_FILING_FORMS.has(form) || filedAt.getTime() < cutoff || filedAt.getTime() >= dayStart) continue;

    let headline = `${filerName} filed Form ${form}`;
    if (form === "4") {
      try {
        const acc = recent.accessionNumber[i];
        if (!form4Cache.has(acc)) form4Cache.set(acc, await describeForm4(cikNumeric, acc, recent.primaryDocument[i]));
        const detail = form4Cache.get(acc);
        if (detail) headline = `${filerName} insider filing: ${detail}`;
      } catch (err) {
        console.warn(`[secFilings] Form 4 detail failed for ${ticker}: ${err.message}`);
      }
    }

    filings.push({ headline, source: "SEC EDGAR", publishedAt: filedAt, isFiling: true, formType: form });
  }
  return filings;
}
