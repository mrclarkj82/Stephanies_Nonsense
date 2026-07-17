import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outputPath = join(root, "data", "live.json");

const SOURCES = {
  fredMortgage30: "https://fred.stlouisfed.org/graph/fredgraph.csv?id=MORTGAGE30US",
  fredTreasury10: "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10",
  fedPress: "https://www.federalreserve.gov/feeds/press_all.xml",
  mbbQuote: "https://stooq.com/q/l/?s=mbb.us&i=d",
  zillowZipZhvi:
    "https://files.zillowstatic.com/research/public_csvs/zhvi/Zip_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv",
  zillowCountyZhvi:
    "https://files.zillowstatic.com/research/public_csvs/zhvi/County_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv",
  zillowZipInventory:
    "https://files.zillowstatic.com/research/public_csvs/invt_fs/Zip_invt_fs_uc_sfrcondo_sm_month.csv",
  zillowCountyInventory:
    "https://files.zillowstatic.com/research/public_csvs/invt_fs/County_invt_fs_uc_sfrcondo_sm_month.csv",
  zillowZipForecast:
    "https://files.zillowstatic.com/research/public_csvs/zhvf_growth/Zip_zhvf_growth_uc_sfrcondo_tier_0.33_0.67_month.csv",
};

const TRACKED_MARKETS = [
  { key: "90210", type: "zip", zip: "90210" },
  { key: "78704", type: "zip", zip: "78704" },
  { key: "orange county", type: "county", stateFips: "06", countyFips: "059", name: "Orange County" },
];

const ALERT_HISTORY_LIMIT = 10;
const ALERT_HISTORY_MIN_SPACING_MS = 30 * 60 * 1000;

const fallbackLiveData = await readPreviousLiveData();
const fetchWarnings = [];

async function main() {
  const generatedAt = new Date().toISOString();
  const zipMarkets = TRACKED_MARKETS.filter((market) => market.type === "zip");
  const countyMarkets = TRACKED_MARKETS.filter((market) => market.type === "county");
  const [
    mortgageSeries,
    treasurySeries,
    fedNews,
    mbbQuote,
    zipZhviRows,
    countyZhviRows,
    zipInventoryRows,
    countyInventoryRows,
    zipForecastRows,
  ] = await Promise.all([
    withFallback("FRED mortgage rate", () => getFredSeries(SOURCES.fredMortgage30, "MORTGAGE30US"), () =>
      buildFallbackRateSeries("MORTGAGE30US", "rate", "rateDelta", "mortgageRate", 6.82),
    ),
    withFallback("FRED 10-year Treasury", () => getFredSeries(SOURCES.fredTreasury10, "DGS10"), () =>
      buildFallbackRateSeries("DGS10", "treasury", "treasuryDelta", "treasury10Y", 4.31),
    ),
    withFallback("Federal Reserve RSS", () => getFedNews(), () => fallbackLiveData?.dashboard?.news ?? []),
    getMbbQuote(),
    withFallback("Zillow ZIP home values", () => getZillowRows(SOURCES.zillowZipZhvi, zipMarkets), () => ({})),
    withFallback("Zillow county home values", () => getZillowRows(SOURCES.zillowCountyZhvi, countyMarkets), () => ({})),
    withFallback("Zillow ZIP inventory", () => getZillowRows(SOURCES.zillowZipInventory, zipMarkets), () => ({})),
    withFallback("Zillow county inventory", () => getZillowRows(SOURCES.zillowCountyInventory, countyMarkets), () => ({})),
    withFallback("Zillow ZIP forecast", () => getZillowRows(SOURCES.zillowZipForecast, zipMarkets), () => ({})),
  ]);

  const reports = {};
  for (const market of TRACKED_MARKETS) {
    const zhviRow = market.type === "zip" ? zipZhviRows[market.key] : countyZhviRows[market.key];
    const inventoryRow = market.type === "zip" ? zipInventoryRows[market.key] : countyInventoryRows[market.key];
    const forecastRow = market.type === "zip" ? zipForecastRows[market.key] : null;
    const census = await getCensusProfile(market);
    reports[market.key] =
      zhviRow || inventoryRow
        ? buildHousingReport(market, zhviRow, inventoryRow, forecastRow, census, mortgageSeries.latest)
        : buildFallbackHousingReport(market, generatedAt) ??
          buildHousingReport(market, zhviRow, inventoryRow, forecastRow, census, mortgageSeries.latest);
  }

  const dashboard = buildDashboard(mortgageSeries, treasurySeries, mbbQuote, fedNews);

  const liveData = {
    generatedAt,
    mode: "live-public-feeds",
    feedHealth: {
      refreshedAt: generatedAt,
      fallbackCount: fetchWarnings.length,
      warnings: fetchWarnings.slice(0, 8),
    },
    sources: {
      mortgageRate: "FRED MORTGAGE30US",
      treasury10Y: "FRED DGS10",
      mbsProxy: "Stooq quote for iShares MBS ETF (MBB.US), used as an agency MBS market proxy",
      economicNews: "Federal Reserve Board RSS feed",
      homeValues: "Zillow Research ZHVI public CSV",
      inventory: "Zillow Research For-Sale Inventory public CSV",
      forecast: "Zillow Research ZHVF ZIP growth public CSV where available",
      demographics: "U.S. Census ACS 5-year profile",
    },
    dashboard,
    alertHistory: buildAlertHistory(fallbackLiveData?.alertHistory, dashboard, generatedAt),
    reports: {
      markets: reports,
      trackedMarkets: TRACKED_MARKETS.map((market) => market.key),
    },
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(liveData, null, 2)}\n`);
  console.log(`Wrote ${outputPath}`);
}

async function readPreviousLiveData() {
  try {
    return JSON.parse(await readFile(outputPath, "utf8"));
  } catch {
    return null;
  }
}

async function withFallback(label, task, fallbackFactory) {
  try {
    return await task();
  } catch (error) {
    fetchWarnings.push(`${label}: ${error.message}`);
    return fallbackFactory();
  }
}

function buildFallbackRateSeries(id, valueKey, deltaKey, observationKey, defaultValue) {
  const dashboard = fallbackLiveData?.dashboard;
  const latestDate =
    dashboard?.latestObservationDates?.[observationKey] ?? dashboard?.trend?.at(-1)?.date ?? currentDateKey();
  const latestValue = parseLeadingNumber(dashboard?.[valueKey], defaultValue);
  const delta = parseLeadingNumber(dashboard?.[deltaKey], 0);
  const observations =
    valueKey === "rate" && Array.isArray(dashboard?.trend) && dashboard.trend.length
      ? dashboard.trend
      : [{ date: latestDate, value: latestValue }];

  return {
    id,
    latest: { date: latestDate, value: latestValue },
    previous: { date: latestDate, value: round(latestValue - delta, 2) },
    delta,
    observations,
  };
}

function buildFallbackHousingReport(market, generatedAt) {
  const previous = fallbackLiveData?.reports?.markets?.[market.key];
  if (!previous) return null;

  return {
    ...previous,
    source: "Last known public feeds",
    lastCheckedAt: generatedAt,
  };
}

function buildAlertHistory(previousHistory, dashboard, generatedAt) {
  const primaryAlert = dashboard.alerts?.[0] ?? {
    level: dashboard.riskTrigger?.active ? "Lock" : "Watch",
    label: dashboard.riskTrigger?.title ?? "Refresh check",
    detail: dashboard.riskTrigger?.detail ?? "Live data refresh completed.",
  };
  const currentEntry = {
    generatedAt,
    level: primaryAlert.level,
    label: primaryAlert.label,
    detail: primaryAlert.detail,
    riskActive: Boolean(dashboard.riskTrigger?.active),
    metrics: {
      rate: dashboard.rate,
      rateDelta: dashboard.rateDelta,
      treasury: dashboard.treasury,
      treasuryDelta: dashboard.treasuryDelta,
      mbsPrice: dashboard.mbsPrice,
      mbsDelta: dashboard.mbsDelta,
    },
  };
  const normalizedPrevious = Array.isArray(previousHistory)
    ? previousHistory.map(normalizeAlertHistoryItem).filter(Boolean)
    : [];
  const currentTime = Date.parse(generatedAt);
  const spacedPrevious = normalizedPrevious.filter((item) => {
    const itemTime = Date.parse(item.generatedAt);
    if (!Number.isFinite(currentTime) || !Number.isFinite(itemTime)) {
      return item.generatedAt !== generatedAt;
    }
    return Math.abs(currentTime - itemTime) >= ALERT_HISTORY_MIN_SPACING_MS;
  });

  return [currentEntry, ...spacedPrevious].slice(0, ALERT_HISTORY_LIMIT);
}

function normalizeAlertHistoryItem(item) {
  if (!item?.generatedAt) return null;
  return {
    generatedAt: item.generatedAt,
    level: item.level ?? "Watch",
    label: item.label ?? "Refresh check",
    detail: item.detail ?? "Live data refresh completed.",
    riskActive: Boolean(item.riskActive),
    metrics: item.metrics ?? {},
  };
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "RateBridgeMBS/0.1 live-data-refresh",
    },
  });
  if (!response.ok) {
    throw new Error(`Fetch failed ${response.status} for ${url}`);
  }
  return response.text();
}

async function getFredSeries(url, columnName) {
  const csv = await fetchText(url);
  const rows = csv
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => {
      const [date, rawValue] = line.split(",");
      const value = Number.parseFloat(rawValue);
      return Number.isFinite(value) ? { date, value } : null;
    })
    .filter(Boolean);

  const latest = rows.at(-1);
  const previous = rows.at(-2) ?? latest;
  return {
    id: columnName,
    latest,
    previous,
    delta: round(latest.value - previous.value, 2),
    observations: rows.slice(-16),
  };
}

async function getFedNews() {
  try {
    const xml = await fetchText(SOURCES.fedPress);
    return [...xml.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<category>([\s\S]*?)<\/category>[\s\S]*?<pubDate><!\[CDATA\[([\s\S]*?)\]\]><\/pubDate>[\s\S]*?<\/item>/g)]
      .slice(0, 4)
      .map((match) => ({
        title: decodeXml(stripCdata(match[1])).trim(),
        category: decodeXml(stripCdata(match[2])).trim(),
        publishedAt: new Date(stripCdata(match[3]).trim()).toISOString(),
      }));
  } catch {
    return fallbackLiveData?.dashboard?.news ?? [];
  }
}

async function getMbbQuote() {
  try {
    const csv = await fetchText(SOURCES.mbbQuote);
    const lines = csv.trim().split(/\r?\n/);
    const hasHeader = lines[0]?.toLowerCase().startsWith("symbol,");
    const headers = hasHeader
      ? lines[0].split(",")
      : ["Symbol", "Date", "Time", "Open", "High", "Low", "Close", "Volume", "OpenInt"];
    const values = (hasHeader ? lines[1] : lines[0]).split(",");
    const quote = Object.fromEntries(headers.map((header, index) => [header.toLowerCase(), values[index]]));
    const normalizedQuote = normalizeMbbQuote(quote);
    if (!normalizedQuote) {
      throw new Error("MBB quote response did not contain a valid MBB.US price");
    }
    return normalizedQuote;
  } catch (error) {
    const fallbackQuote = normalizeMbbQuote(fallbackLiveData?.dashboard?.mbsProxyRaw);
    fetchWarnings.push(
      fallbackQuote
        ? `MBB quote: ${error.message}; using the last valid quote.`
        : `MBB quote: ${error.message}; no valid cached quote is available.`,
    );
    return fallbackQuote;
  }
}

function normalizeMbbQuote(quote) {
  if (!quote || typeof quote !== "object") return null;

  const symbol = String(quote.symbol ?? "").trim().toUpperCase();
  const open = Number.parseFloat(quote.open);
  const close = Number.parseFloat(quote.close);
  if (symbol !== "MBB.US" || !Number.isFinite(open) || !Number.isFinite(close) || open <= 0 || close <= 0) {
    return null;
  }

  const high = Number.parseFloat(quote.high);
  const low = Number.parseFloat(quote.low);
  const volume = Number.parseInt(quote.volume, 10);
  return {
    symbol,
    date: quote.date ?? null,
    time: quote.time ?? null,
    open,
    high: Number.isFinite(high) ? high : null,
    low: Number.isFinite(low) ? low : null,
    close,
    volume: Number.isFinite(volume) ? volume : null,
    delta: round(close - open, 2),
    deltaPercent: round(((close - open) / open) * 100, 2),
  };
}

async function getZillowRows(url, markets) {
  if (!markets.length) return {};
  const csv = await fetchText(url);
  const lines = csv.trim().split(/\r?\n/);
  const header = parseCsvRow(lines[0]);
  const matched = {};

  for (const line of lines.slice(1)) {
    if (!line) continue;
    const row = parseCsvRow(line);
    const record = Object.fromEntries(header.map((column, index) => [column, row[index] ?? ""]));

    for (const market of markets) {
      if (market.type === "zip" && record.RegionName === market.zip) {
        matched[market.key] = { header, row, record };
      }

      if (
        market.type === "county" &&
        record.RegionName === market.name &&
        record.StateCodeFIPS === market.stateFips &&
        record.MunicipalCodeFIPS === market.countyFips
      ) {
        matched[market.key] = { header, row, record };
      }
    }

    if (Object.keys(matched).length === markets.length) break;
  }

  return matched;
}

async function getCensusProfile(market) {
  try {
    const url =
      market.type === "zip"
        ? `https://api.census.gov/data/2023/acs/acs5/profile?get=NAME,DP05_0001E,DP03_0062E,DP03_0009PE&for=zip%20code%20tabulation%20area:${market.zip}`
        : `https://api.census.gov/data/2023/acs/acs5/profile?get=NAME,DP05_0001E,DP03_0062E,DP03_0009PE&for=county:${market.countyFips}&in=state:${market.stateFips}`;
    const data = JSON.parse(await fetchText(url));
    const [headers, values] = data;
    const record = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
    return {
      name: record.NAME,
      population: Number.parseInt(record.DP05_0001E, 10),
      householdIncome: Number.parseInt(record.DP03_0062E, 10),
      unemploymentRate: Number.parseFloat(record.DP03_0009PE),
    };
  } catch {
    return null;
  }
}

function buildDashboard(mortgageSeries, treasurySeries, mbbQuote, fedNews) {
  const validMbbQuote = normalizeMbbQuote(mbbQuote);
  const rateDelta = mortgageSeries.delta;
  const treasuryDelta = treasurySeries.delta;
  const mbsDelta = validMbbQuote?.deltaPercent ?? 0;
  const riskActive = treasuryDelta >= 0.05 || rateDelta >= 0.05 || mbsDelta <= -0.2;
  const alertLevel = riskActive ? "Lock" : treasuryDelta > 0 ? "Watch" : "Float";

  return {
    rate: `${mortgageSeries.latest.value.toFixed(2)}%`,
    rateDelta: formatDelta(rateDelta, " vs prior week"),
    mbsPrice: validMbbQuote ? `$${validMbbQuote.close.toFixed(2)}` : "Unavailable",
    mbsDelta: validMbbQuote ? formatDelta(validMbbQuote.deltaPercent, "% intraday") : "No quote",
    treasury: `${treasurySeries.latest.value.toFixed(2)}%`,
    treasuryDelta: formatDelta(treasuryDelta, " today"),
    volatility: riskActive ? "Elevated" : Math.abs(treasuryDelta) >= 0.03 ? "Moderate" : "Calm",
    narrative: buildNarrative(mortgageSeries, treasurySeries, validMbbQuote, riskActive),
    driver: treasuryDelta >= 0 ? "Treasury yield pressure" : "Treasury yield relief",
    riskWindow: "Refreshes from public feeds on the scheduled GitHub Action",
    coupon: "MBB ETF proxy",
    priceChange: validMbbQuote ? formatDelta(validMbbQuote.delta, " today") : "No quote",
    spreadTone: mbsDelta < -0.2 ? "Worse" : mbsDelta > 0.2 ? "Better" : "Stable",
    news: fedNews.map((item) => ({
      title: item.title,
      detail: item.detail ?? `${item.category ?? "Federal Reserve"} - ${formatDate(item.publishedAt)}`,
    })),
    alerts: [
      {
        level: alertLevel,
        label: riskActive ? "Risk trigger" : "Live bias",
        detail: riskActive
          ? "Live public feeds show rate or MBS proxy pressure. Consider locking near-term closings."
          : "No live lock trigger is active from the public feed rules.",
      },
      {
        level: "Watch",
        label: "10Y Treasury",
        detail: `Latest DGS10 is ${treasurySeries.latest.value.toFixed(2)}%, ${formatDelta(treasuryDelta, " from prior observation")}.`,
      },
      {
        level: "Watch",
        label: "Mortgage rate",
        detail: `Freddie/FRED 30-year average is ${mortgageSeries.latest.value.toFixed(2)}%, ${formatDelta(rateDelta, " from prior week")}.`,
      },
    ],
    riskTrigger: {
      active: riskActive,
      id: "live-public-feed-lock-risk",
      title: riskActive ? "Lock risk trigger" : "No lock trigger",
      detail: riskActive
        ? "Live public data crossed the lock-risk rule: rising rates/yields or weaker MBS proxy pricing."
        : "Live public data does not currently meet the lock-risk rule.",
    },
    trend: mortgageSeries.observations.map((point) => ({
      date: point.date,
      value: point.value,
    })),
    mbsProxyRaw: validMbbQuote,
    latestObservationDates: {
      mortgageRate: mortgageSeries.latest.date,
      treasury10Y: treasurySeries.latest.date,
      mbsProxy: validMbbQuote?.date ?? null,
    },
  };
}

function buildHousingReport(market, zhviData, inventoryData, forecastData, census, mortgageLatest) {
  const zhviRecord = zhviData?.record ?? {};
  const inventoryRecord = inventoryData?.record ?? {};
  const values = extractDateValues(zhviRecord);
  const inventoryValues = extractDateValues(inventoryRecord);
  const latest = latestValue(values);
  const yearAgo = valueMonthsBack(values, 12);
  const fiveYearsAgo = valueMonthsBack(values, 60);
  const latestInventory = latestValue(inventoryValues);
  const history = annualHistory(values);
  const forecast = buildForecast(forecastData?.record, history);
  const marketName = market.type === "zip" ? `${zhviRecord.City || "ZIP"} ${market.zip}, ${zhviRecord.State || ""}` : `${market.name}, ${zhviRecord.State || "CA"}`;
  const affordabilityIndex = computeAffordability(latest?.value, census?.householdIncome, mortgageLatest?.value);

  return {
    name: marketName.trim(),
    marketType: market.type,
    source: "Live public feeds",
    medianHomePrice: Math.round(latest?.value ?? 0),
    latestHomeValueDate: latest?.date ?? null,
    appreciation1Y: percentChange(latest?.value, yearAgo?.value),
    appreciation5Y: percentChange(latest?.value, fiveYearsAgo?.value),
    inventoryMonths: null,
    inventoryLevel: latestInventory ? `${Math.round(latestInventory.value).toLocaleString("en-US")} active listings` : "Unavailable",
    latestInventoryDate: latestInventory?.date ?? null,
    affordabilityIndex,
    jobGrowth: census
      ? `ACS unemployment ${census.unemploymentRate?.toFixed(1)}% (job-growth API pending)`
      : "Census labor profile unavailable",
    demographics: census
      ? `Population ${census.population.toLocaleString("en-US")}; median household income $${census.householdIncome.toLocaleString("en-US")}`
      : "Census profile unavailable",
    history,
    forecast,
    sourceNotes: [
      "Median home price uses Zillow ZHVI typical home value, not MLS closed-sale median.",
      "Inventory uses Zillow for-sale inventory count, not months of supply.",
      "Forecast uses Zillow ZHVF for tracked ZIPs where available; county fallback is a simple trend projection.",
    ],
  };
}

function extractDateValues(record) {
  return Object.entries(record)
    .filter(([key, value]) => /^\d{4}-\d{2}-\d{2}$/.test(key) && Number.isFinite(Number.parseFloat(value)))
    .map(([date, value]) => ({ date, value: Number.parseFloat(value) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function latestValue(values) {
  return values.at(-1) ?? null;
}

function valueMonthsBack(values, months) {
  return values.at(-(months + 1)) ?? values[0] ?? null;
}

function annualHistory(values) {
  const byYear = new Map();
  for (const point of values) {
    byYear.set(point.date.slice(0, 4), point);
  }
  return [...byYear.entries()]
    .slice(-7)
    .map(([year, point]) => ({ year, value: Math.round(point.value) }));
}

function buildForecast(record, history) {
  if (record) {
    return Object.entries(record)
      .filter(([key, value]) => /^\d{4}-\d{2}-\d{2}$/.test(key) && Number.isFinite(Number.parseFloat(value)))
      .map(([date, value]) => ({ year: date.slice(0, 7), value: round(Number.parseFloat(value), 1) }));
  }

  const last = history.at(-1)?.value ?? 100;
  const prior = history.at(-2)?.value ?? last;
  const trend = prior ? ((last - prior) / prior) * 100 : 0;
  return [1, 2, 3].map((step) => ({
    year: String(new Date().getFullYear() + step),
    value: round(Math.max(-5, Math.min(8, trend * (1 - step * 0.12))), 1),
  }));
}

function computeAffordability(homeValue, householdIncome, mortgageRate) {
  if (!homeValue || !householdIncome || !mortgageRate) return null;
  const downPayment = homeValue * 0.2;
  const loanAmount = homeValue - downPayment;
  const monthlyRate = mortgageRate / 100 / 12;
  const months = 360;
  const payment =
    (loanAmount * monthlyRate * (1 + monthlyRate) ** months) / ((1 + monthlyRate) ** months - 1);
  const monthlyIncome = householdIncome / 12;
  const paymentRatio = payment / monthlyIncome;
  return Math.max(1, Math.min(160, Math.round(100 - (paymentRatio - 0.28) * 180)));
}

function percentChange(current, previous) {
  if (!current || !previous) return null;
  return round(((current - previous) / previous) * 100, 1);
}

function parseCsvRow(line) {
  const values = [];
  let value = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      values.push(value);
      value = "";
    } else {
      value += char;
    }
  }

  values.push(value);
  return values;
}

function stripCdata(value) {
  return value.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function decodeXml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function buildNarrative(mortgageSeries, treasurySeries, mbbQuote, riskActive) {
  const ratePart = `The latest FRED 30-year mortgage average is ${mortgageSeries.latest.value.toFixed(2)}%, ${formatDelta(mortgageSeries.delta, " from the prior reading")}.`;
  const treasuryPart = `The 10-year Treasury is ${treasurySeries.latest.value.toFixed(2)}%, ${formatDelta(treasurySeries.delta, " from the prior observation")}.`;
  const mbsPart = mbbQuote
    ? `The MBB proxy closed at $${mbbQuote.close.toFixed(2)}, ${formatDelta(mbbQuote.deltaPercent, "% intraday")}.`
    : "The public MBS proxy quote is unavailable.";
  const guidance = riskActive
    ? "Lock risk is active for near-term closings."
    : "No lock trigger is active from the live public-feed rule.";
  return `${ratePart} ${treasuryPart} ${mbsPart} ${guidance}`;
}

function formatDelta(value, suffix) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}${suffix}`;
}

function formatDate(date) {
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return "date unavailable";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(parsed);
}

function round(value, digits = 2) {
  return Math.round(value * 10 ** digits) / 10 ** digits;
}

function parseLeadingNumber(value, fallbackValue) {
  const parsed = Number.parseFloat(String(value ?? "").replace(/[^0-9.+-]/g, ""));
  return Number.isFinite(parsed) ? parsed : fallbackValue;
}

function currentDateKey() {
  return new Date().toISOString().slice(0, 10);
}

await main();
