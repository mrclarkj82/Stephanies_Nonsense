const LIVE_DATA_PATH = "data/live.json";
const LIVE_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
const MAX_ALERT_HISTORY_ITEMS = 10;

let liveDataCache = null;

const fallbackMarketService = {
  async getDailyMarketSummary() {
    return {
      rate: "6.82%",
      rateDelta: "-0.03 today",
      mbsPrice: "101-14",
      mbsDelta: "+7 bps",
      treasury: "4.31%",
      treasuryDelta: "+0.02 today",
      volatility: "Moderate",
      narrative:
        "Mortgage rates are slightly better as coupon demand holds firm and Treasury yields drift within a narrow range. Floating has room, but repricing risk rises around scheduled data and Fed commentary.",
      driver: "Treasury curve digestion",
      riskWindow: "10:00 AM ET data",
      coupon: "101-14",
      priceChange: "+0-07",
      spreadTone: "Stable",
      news: [
        {
          title: "Inflation print placeholder",
          detail: "Consensus expects monthly core inflation to stay range-bound.",
        },
        {
          title: "Fed speaker calendar placeholder",
          detail: "Policy comments may create intraday repricing pressure.",
        },
        {
          title: "Auction supply placeholder",
          detail: "Treasury supply could influence afternoon duration appetite.",
        },
      ],
      alerts: [
        {
          level: "Float",
          label: "Morning bias",
          detail: "Price action supports measured floating while MBS remain above the intraday pivot.",
        },
        {
          level: "Lock",
          label: "Risk trigger",
          detail: "Lock shorter closings if 10Y breaks above resistance or lender sheets worsen.",
        },
        {
          level: "Watch",
          label: "News window",
          detail: "Reassess guidance after economic data and Fed remarks are absorbed.",
        },
      ],
      riskTrigger: {
        active: true,
        id: "treasury-resistance-lock-risk",
        title: "Lock risk trigger",
        detail:
          "10Y yield pressure is near the mock resistance line. Lock loans closing soon if lender sheets worsen.",
      },
    };
  },
};

const marketService = {
  async getDailyMarketSummary({ fresh = false } = {}) {
    const liveData = await getLiveData({ fresh });
    if (!liveData?.dashboard) {
      return {
        ...(await fallbackMarketService.getDailyMarketSummary()),
        isLive: false,
        generatedAt: null,
        sources: {},
      };
    }

    return {
      ...liveData.dashboard,
      isLive: true,
      generatedAt: liveData.generatedAt,
      feedHealth: liveData.feedHealth,
      alertHistory: liveData.alertHistory,
      sources: liveData.sources,
    };
  },
};

const riskAlertService = {
  evaluate(summary) {
    if (!summary.riskTrigger?.active) return null;
    return {
      ...summary.riskTrigger,
      triggeredAt: summary.generatedAt ? new Date(summary.generatedAt) : new Date(),
    };
  },
};

const realEstateReportApi = {
  async getReport({ marketType, query }) {
    const normalized = query.trim().toLowerCase();
    const liveData = await getLiveData();
    const liveMarket = liveData?.reports?.markets?.[normalized];
    const selected = liveMarket ?? mockHousingMarkets[normalized] ?? buildSyntheticMarket(marketType, query);
    return {
      ...selected,
      source: liveMarket ? "live" : "mock",
      requestedMarketType: marketType,
    };
  },
};

const mockHousingMarkets = {
  "90210": {
    name: "Beverly Hills, CA 90210",
    medianHomePrice: 1740000,
    appreciation1Y: 4.8,
    appreciation5Y: 32.4,
    inventoryMonths: 2.6,
    affordabilityIndex: 71,
    jobGrowth: "Entertainment and professional services placeholder",
    demographics: "High-income households, luxury inventory mix placeholder",
    history: [
      { year: "2019", value: 100 },
      { year: "2020", value: 106 },
      { year: "2021", value: 118 },
      { year: "2022", value: 126 },
      { year: "2023", value: 128 },
      { year: "2024", value: 132 },
      { year: "2025", value: 136 },
    ],
    forecast: [
      { year: "2026", value: 3.1 },
      { year: "2027", value: 3.6 },
      { year: "2028", value: 4.0 },
    ],
  },
  "78704": {
    name: "Austin, TX 78704",
    medianHomePrice: 812000,
    appreciation1Y: 2.2,
    appreciation5Y: 41.6,
    inventoryMonths: 3.8,
    affordabilityIndex: 84,
    jobGrowth: "Technology and healthcare expansion placeholder",
    demographics: "Millennial-heavy renter-to-owner transition placeholder",
    history: [
      { year: "2019", value: 100 },
      { year: "2020", value: 111 },
      { year: "2021", value: 132 },
      { year: "2022", value: 148 },
      { year: "2023", value: 142 },
      { year: "2024", value: 139 },
      { year: "2025", value: 142 },
    ],
    forecast: [
      { year: "2026", value: 2.4 },
      { year: "2027", value: 3.0 },
      { year: "2028", value: 3.4 },
    ],
  },
  "orange county": {
    name: "Orange County, CA",
    medianHomePrice: 1225000,
    appreciation1Y: 5.1,
    appreciation5Y: 38.9,
    inventoryMonths: 2.2,
    affordabilityIndex: 76,
    jobGrowth: "Healthcare, tourism, and logistics placeholder",
    demographics: "Coastal and suburban household mix placeholder",
    history: [
      { year: "2019", value: 100 },
      { year: "2020", value: 107 },
      { year: "2021", value: 121 },
      { year: "2022", value: 134 },
      { year: "2023", value: 135 },
      { year: "2024", value: 139 },
      { year: "2025", value: 144 },
    ],
    forecast: [
      { year: "2026", value: 3.7 },
      { year: "2027", value: 4.1 },
      { year: "2028", value: 4.3 },
    ],
  },
};

function buildSyntheticMarket(marketType, query) {
  const seed = [...query].reduce((sum, char) => sum + char.charCodeAt(0), 0) || 42;
  const medianHomePrice = 360000 + (seed % 900) * 1150;
  const appreciation1Y = roundOne(1.4 + (seed % 56) / 10);
  const appreciation5Y = roundOne(18 + (seed % 310) / 10);
  const inventoryMonths = roundOne(1.6 + (seed % 42) / 10);
  const affordabilityIndex = 62 + (seed % 42);
  const base = 100;
  const history = Array.from({ length: 7 }, (_, index) => ({
    year: String(2019 + index),
    value: Math.round(base + index * (appreciation5Y / 6) + ((seed + index * 7) % 6)),
  }));
  const forecast = Array.from({ length: 3 }, (_, index) => ({
    year: String(2026 + index),
    value: roundOne(appreciation1Y + index * 0.4 - 0.2),
  }));

  return {
    name: `${formatMarketName(query)} ${marketType === "zip" ? "ZIP" : "County"} Market`,
    medianHomePrice,
    appreciation1Y,
    appreciation5Y,
    inventoryMonths,
    affordabilityIndex,
    jobGrowth: "Regional employment data placeholder",
    demographics: "Population, household income, and migration placeholder",
    history,
    forecast,
  };
}

function formatMarketName(value) {
  return value
    .trim()
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function roundOne(value) {
  return Math.round(value * 10) / 10;
}

const formatCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 2,
});

const state = {
  currentReport: null,
  currentRiskAlert: null,
  riskAlertDismissed: false,
  liveRefreshTimer: null,
  lastGeneratedAt: null,
};

document.addEventListener("DOMContentLoaded", async () => {
  setDateStamp();
  bindNavigation();
  bindReportForm();
  bindRefresh();
  bindRiskAlertControls();
  await renderDashboard();
  await renderReport({ marketType: "zip", query: "90210" });
  startLiveDataRefresh();
  if (window.lucide) {
    window.lucide.createIcons();
  }
});

async function getLiveData({ fresh = false } = {}) {
  if (liveDataCache && !fresh) return liveDataCache;

  try {
    const cacheBust = fresh ? `?t=${Date.now()}` : "";
    const response = await fetch(`${LIVE_DATA_PATH}${cacheBust}`, { cache: fresh ? "no-store" : "default" });
    if (!response.ok) throw new Error(`Live data unavailable: ${response.status}`);
    liveDataCache = await response.json();
    return liveDataCache;
  } catch (error) {
    console.warn(error);
    return liveDataCache;
  }
}

function setDateStamp() {
  const stamp = document.querySelector("#todayStamp");
  stamp.textContent = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date());
}

function bindNavigation() {
  document.querySelectorAll(".nav-link").forEach((link) => {
    link.addEventListener("click", () => {
      document.querySelectorAll(".nav-link").forEach((item) => item.classList.remove("active"));
      link.classList.add("active");
    });
  });
}

function bindRefresh() {
  document.querySelector("#refreshButton").addEventListener("click", async () => {
    state.riskAlertDismissed = false;
    await renderDashboard();
  });
}

function bindRiskAlertControls() {
  document.querySelector("#dismissRiskToast").addEventListener("click", () => {
    state.riskAlertDismissed = true;
    hideRiskAlert();
  });

  document.querySelector("#testLockAlertButton").addEventListener("click", () => {
    state.riskAlertDismissed = false;
    showRiskAlert({
      id: "manual-lock-risk-test",
      title: "Lock risk trigger",
      detail: "Manual test: protect shorter closings if pricing deteriorates or the 10Y breaks higher.",
      triggeredAt: new Date(),
    });
  });
}

function bindReportForm() {
  document.querySelector("#reportForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    await renderReport({
      marketType: formData.get("marketType"),
      query: formData.get("marketQuery"),
    });
  });

  document.querySelector("#downloadReportButton").addEventListener("click", () => {
    if (!state.currentReport) return;
    const snapshot = {
      generatedAt: new Date().toISOString(),
      report: state.currentReport,
    };
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${state.currentReport.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-market-report.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  });
}

async function renderDashboard() {
  const data = await marketService.getDailyMarketSummary({ fresh: true });
  const hasNewSnapshot = data.generatedAt && data.generatedAt !== state.lastGeneratedAt;
  if (hasNewSnapshot && state.lastGeneratedAt) {
    state.riskAlertDismissed = false;
  }
  state.lastGeneratedAt = data.generatedAt ?? state.lastGeneratedAt;

  updateDataStatus(data);
  setText("rateMetric", data.rate);
  setText("rateDelta", data.rateDelta);
  setText("mbsMetric", data.mbsPrice);
  setText("mbsDelta", data.mbsDelta);
  setText("treasuryMetric", data.treasury);
  setText("treasuryDelta", data.treasuryDelta);
  setText("volMetric", data.volatility);
  setText("marketNarrative", data.narrative);
  setText("driverMetric", data.driver);
  setText("riskWindowMetric", data.riskWindow);
  setText("couponMetric", data.coupon);
  setText("priceChangeMetric", data.priceChange);
  setText("spreadMetric", data.spreadTone);
  if (data.trend?.length) {
    drawLineChart(
      "rateTrendChart",
      data.trend.map((point) => ({
        year: formatShortDate(point.date),
        value: point.value,
      })),
      {
        line: "#117c8b",
        fill: "rgba(17, 124, 139, 0.12)",
        suffix: "%",
      },
    );
  }

  renderNewsList(data.news);
  renderAlertStack(data.alerts);
  renderAlertHistory(data.alertHistory, data);

  const riskAlert = riskAlertService.evaluate(data);
  state.currentRiskAlert = riskAlert;
  if (riskAlert && !state.riskAlertDismissed) {
    window.setTimeout(() => {
      if (!state.riskAlertDismissed) showRiskAlert(riskAlert);
    }, 900);
  }
}

function updateDataStatus(data) {
  const label = data.isLive ? "Live data feed" : "Fallback data";
  let detail = data.generatedAt ? `Updated ${formatRelativeDate(data.generatedAt)}` : "Mock fallback active";
  if (data.feedHealth?.fallbackCount) {
    detail += " with source fallbacks";
  }
  setText("dataStatusLabel", label);
  setText("dataStatusDetail", detail);
}

function startLiveDataRefresh() {
  if (state.liveRefreshTimer) return;
  state.liveRefreshTimer = window.setInterval(async () => {
    await renderDashboard();
  }, LIVE_REFRESH_INTERVAL_MS);
}

function renderNewsList(news = []) {
  const newsList = document.querySelector("#newsList");
  newsList.replaceChildren(
    ...news.map((item) => {
      const listItem = document.createElement("li");
      const title = document.createElement("strong");
      const detail = document.createElement("span");

      title.textContent = item.title;
      detail.textContent = item.detail;
      listItem.append(title, detail);
      return listItem;
    }),
  );
}

function renderAlertStack(alerts = []) {
  const alertStack = document.querySelector("#alertStack");
  alertStack.replaceChildren(
    ...alerts.map((item) => {
      const alertItem = document.createElement("section");
      const title = document.createElement("strong");
      const level = document.createElement("span");
      const detail = document.createElement("small");

      alertItem.className = "alert-item";
      title.textContent = item.label;
      level.textContent = item.level;
      detail.textContent = item.detail;
      title.append(level);
      alertItem.append(title, detail);
      return alertItem;
    }),
  );
}

function renderAlertHistory(history = [], data) {
  const historyList = document.querySelector("#alertHistoryList");
  const savedHistory = Array.isArray(history) ? history : [];
  const items = (savedHistory.length ? savedHistory : buildCurrentAlertHistory(data)).slice(
    0,
    MAX_ALERT_HISTORY_ITEMS,
  );

  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "alert-history-empty";
    empty.textContent = "No refresh alerts have been recorded yet.";
    historyList.replaceChildren(empty);
    return;
  }

  historyList.replaceChildren(...items.map(createAlertHistoryItem));
}

function buildCurrentAlertHistory(data) {
  const primaryAlert = data.alerts?.[0];
  if (!primaryAlert) return [];
  return [
    {
      generatedAt: data.generatedAt,
      level: primaryAlert.level,
      label: primaryAlert.label,
      detail: primaryAlert.detail,
      metrics: {
        rate: data.rate,
        treasury: data.treasury,
        mbsPrice: data.mbsPrice,
      },
    },
  ];
}

function createAlertHistoryItem(item) {
  const entry = document.createElement("article");
  const timeBlock = document.createElement("div");
  const timestamp = document.createElement("strong");
  const level = document.createElement("span");
  const detailBlock = document.createElement("div");
  const title = document.createElement("strong");
  const detail = document.createElement("p");
  const metrics = document.createElement("div");

  entry.className = "alert-history-item";
  timeBlock.className = "alert-history-time";
  level.className = item.riskActive ? "history-level lock" : "history-level";
  detailBlock.className = "alert-history-detail";
  metrics.className = "alert-history-metrics";

  timestamp.textContent = item.generatedAt ? formatRelativeDate(item.generatedAt) : "Time unavailable";
  level.textContent = item.level ?? "Watch";
  title.textContent = item.label ?? "Refresh check";
  detail.textContent = item.detail ?? "Live data refresh completed.";

  timeBlock.append(timestamp, level);
  detailBlock.append(title, detail);
  addMetricPill(metrics, "30Y", item.metrics?.rate);
  addMetricPill(metrics, "10Y", item.metrics?.treasury);
  addMetricPill(metrics, "MBS", item.metrics?.mbsPrice);
  entry.append(timeBlock, detailBlock, metrics);
  return entry;
}

function addMetricPill(container, label, value) {
  if (!value) return;
  const pill = document.createElement("span");
  pill.textContent = `${label} ${value}`;
  container.append(pill);
}

function showRiskAlert(alert) {
  const toast = document.querySelector("#riskToast");
  const timestamp = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(alert.triggeredAt);

  setText("riskToastTitle", `${alert.title} - ${timestamp}`);
  setText("riskToastDetail", alert.detail);
  toast.hidden = false;

  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function hideRiskAlert() {
  document.querySelector("#riskToast").hidden = true;
}

async function renderReport(criteria) {
  const report = await realEstateReportApi.getReport(criteria);
  state.currentReport = report;

  setText("reportMarketName", report.name);
  setText("medianPrice", formatCurrency.format(report.medianHomePrice));
  setText("appreciation1Y", `${report.appreciation1Y}%`);
  setText("appreciation5Y", `${report.appreciation5Y}%`);
  setText("inventoryLevel", report.inventoryLevel ?? `${report.inventoryMonths} mo`);
  setText("affordabilityIndex", report.affordabilityIndex ?? "N/A");
  setText("jobGrowth", report.jobGrowth);
  setText("demographics", report.demographics);
  setText("historyRange", `${report.history[0].year}-${report.history.at(-1).year}`);
  setText("forecastRange", `${report.forecast[0].year}-${report.forecast.at(-1).year}`);
  setText("reportSourcePill", report.source === "live" ? "Live public feeds" : "Mock fallback");

  drawLineChart("historicalChart", report.history, {
    line: "#117c8b",
    fill: "rgba(17, 124, 139, 0.12)",
    suffix: "",
  });
  drawLineChart("forecastChart", report.forecast, {
    line: "#b5532d",
    fill: "rgba(181, 83, 45, 0.12)",
    suffix: "%",
  });
}

function setText(id, value) {
  document.querySelector(`#${id}`).textContent = value;
}

function drawLineChart(canvasId, points, theme) {
  const canvas = document.querySelector(`#${canvasId}`);
  const containerWidth = canvas.parentElement.clientWidth - 32;
  const pixelRatio = window.devicePixelRatio || 1;
  canvas.width = Math.max(320, containerWidth) * pixelRatio;
  canvas.height = 220 * pixelRatio;
  const ctx = canvas.getContext("2d");
  ctx.scale(pixelRatio, pixelRatio);

  const width = canvas.width / pixelRatio;
  const height = canvas.height / pixelRatio;
  const padding = { top: 18, right: 18, bottom: 34, left: 42 };
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = "#d8e0dc";
  ctx.lineWidth = 1;
  ctx.font = "12px system-ui, sans-serif";
  ctx.fillStyle = "#64706d";

  for (let i = 0; i < 4; i += 1) {
    const y = padding.top + ((height - padding.top - padding.bottom) / 3) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
    const labelValue = max - (range / 3) * i;
    ctx.fillText(`${formatChartAxisValue(labelValue)}${theme.suffix}`, 8, y + 4);
  }

  const getX = (index) =>
    padding.left + ((width - padding.left - padding.right) / Math.max(points.length - 1, 1)) * index;
  const getY = (value) =>
    padding.top + (1 - (value - min) / range) * (height - padding.top - padding.bottom);

  const path = new Path2D();
  points.forEach((point, index) => {
    const x = getX(index);
    const y = getY(point.value);
    if (index === 0) path.moveTo(x, y);
    else path.lineTo(x, y);
  });

  const fillPath = new Path2D(path);
  fillPath.lineTo(getX(points.length - 1), height - padding.bottom);
  fillPath.lineTo(getX(0), height - padding.bottom);
  fillPath.closePath();

  ctx.fillStyle = theme.fill;
  ctx.fill(fillPath);
  ctx.strokeStyle = theme.line;
  ctx.lineWidth = 3;
  ctx.stroke(path);

  points.forEach((point, index) => {
    const x = getX(index);
    const y = getY(point.value);
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = theme.line;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#64706d";
    ctx.fillText(point.year, x - 15, height - 10);
  });
}

window.addEventListener("resize", () => {
  if (!state.currentReport) return;
  marketService.getDailyMarketSummary().then((data) => {
    if (!data.trend?.length) return;
    drawLineChart(
      "rateTrendChart",
      data.trend.map((point) => ({
        year: formatShortDate(point.date),
        value: point.value,
      })),
      {
        line: "#117c8b",
        fill: "rgba(17, 124, 139, 0.12)",
        suffix: "%",
      },
    );
  });
  drawLineChart("historicalChart", state.currentReport.history, {
    line: "#117c8b",
    fill: "rgba(17, 124, 139, 0.12)",
    suffix: "",
  });
  drawLineChart("forecastChart", state.currentReport.forecast, {
    line: "#b5532d",
    fill: "rgba(181, 83, 45, 0.12)",
    suffix: "%",
  });
});

function formatRelativeDate(date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(date));
}

function formatShortDate(date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "numeric",
    day: "numeric",
  }).format(new Date(`${date}T00:00:00`));
}

function formatChartAxisValue(value) {
  if (Math.abs(value) >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (Math.abs(value) >= 1000) return `${Math.round(value / 1000)}K`;
  return value.toFixed(1);
}
