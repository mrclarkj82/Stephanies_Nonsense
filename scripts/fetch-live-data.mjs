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

const fallbackLiveData = await readPreviousLiveData();

async function main() {
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
    getFredSeries(SOURCES.fredMortgage30, "MORTGAGE30US"),
    getFredSeries(SOURCES.fredTreasury10, "DGS10"),
    getFedNews(),
    getMbbQuote(),
    getZillowRows(SOURCES.zillowZipZhvi, TRACKED_MARKETS.filter((market) => market.type === "zip")),
    getZillowRows(SOURCES.zillowCountyZhvi, TRACKED_MARKETS.filter((market) => market.type === "county")),
    getZillowRows(SOURCES.zillowZipInventory, TRACKED_MARKETS.filter((market) => market.type === "zip")),
    getZillowRows(SOURCES.zillowCountyInventory, TRACKED_MARKETS.filter((market) => market.type === "county")),
    getZillowRows(SOURCES.zillowZipForecast, TRACKED_MARKETS.filter((market) => market.type === "zip")),
  ]);

  const reports = {};
  for (const market of TRACKED_MARKETS) {
    const zhviRow = market.type === "zip" ? zipZhviRows[market.key] : countyZhviRows[market.key];
    const inventoryRow = market.type === "zip" ? zipInventoryRows[market.key] : countyInventoryRows[market.key];
    const forecastRow = market.type === "zip" ? zipForecastRows[market.key] : null;
    const census = await getCensusProfile(market);
    reports[market.key] = buildHousingReport(market, zhviRow, inventoryRow, forecastRow, census, mortgageSeries.latest);
  }

  const liveData = {
    generatedAt: new Date().toISOString(),
    mode: "live-public-feeds",
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
    dashboard: buildDashboard(mortgageSeries, treasurySeries, mbbQuote, fedNews),
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
    const open = Number.parseFloat(quote.open);
    const close = Number.parseFloat(quote.close);
    return {
      symbol: quote.symbol,
      date: quote.date,
      time: quote.time,
      open,
      high: Number.parseFloat(quote.high),
      low: Number.parseFloat(quote.low),
      close,
      volume: Number.parseInt(quote.volume, 10),
      delta: round(close - open, 2),
      deltaPercent: round(((close - open) / open) * 100, 2),
    };
  } catch {
    return fallbackLiveData?.dashboard?.mbsProxyRaw ?? null;
  }
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
  const rateDelta = mortgageSeries.delta;
  const treasuryDelta = treasurySeries.delta;
  const mbsDelta = mbbQuote?.deltaPercent ?? 0;
  const riskActive = treasuryDelta >= 0.05 || rateDelta >= 0.05 || mbsDelta <= -0.2;
  const alertLevel = riskActive ? "Lock" : treasuryDelta > 0 ? "Watch" : "Float";

  return {
    rate: `${mortgageSeries.latest.value.toFixed(2)}%`,
    rateDelta: formatDelta(rateDelta, " vs prior week"),
    mbsPrice: mbbQuote ? `$${mbbQuote.close.toFixed(2)}` : "Unavailable",
    mbsDelta: mbbQuote ? formatDelta(mbbQuote.deltaPercent, "% intraday") : "No quote",
    treasury: `${treasurySeries.latest.value.toFixed(2)}%`,
    treasuryDelta: formatDelta(treasuryDelta, " today"),
    volatility: riskActive ? "Elevated" : Math.abs(treasuryDelta) >= 0.03 ? "Moderate" : "Calm",
    narrative: buildNarrative(mortgageSeries, treasurySeries, mbbQuote, riskActive),
    driver: treasuryDelta >= 0 ? "Treasury yield pressure" : "Treasury yield relief",
    riskWindow: "Refreshes from public feeds on the scheduled GitHub Action",
    coupon: "MBB ETF proxy",
    priceChange: mbbQuote ? formatDelta(mbbQuote.delta, " today") : "No quote",
    spreadTone: mbsDelta < -0.2 ? "Worse" : mbsDelta > 0.2 ? "Better" : "Stable",
    news: fedNews.map((item) => ({
      title: item.title,
      detail: `${item.category} - ${formatDate(item.publishedAt)}`,
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
    mbsProxyRaw: mbbQuote,
    latestObservationDates: {
      mortgageRate: mortgageSeries.latest.date,
      treasury10Y: treasurySeries.latest.date,
      mbsProxy: mbbQuote?.date ?? null,
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
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(date));
}

function round(value, digits = 2) {
  return Math.round(value * 10 ** digits) / 10 ** digits;
}

await main();
