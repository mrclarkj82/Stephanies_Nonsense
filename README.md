# RateBridge MBS

RateBridge MBS is a browser-based mortgage market and real estate reporting app with mock data behind replaceable API service objects.

## Run Locally

```powershell
node server.mjs
```

Then open:

```text
http://127.0.0.1:4173/
```

## Lock Risk Alert

The dashboard evaluates the live public data feed for a lock-risk trigger. When active, it displays an in-window alert while the app is open. The Alerts panel also includes a `Test` button for manually firing the lock-risk notification.

## Live Data

The site is hosted on GitHub Pages, so it does not run a traditional backend server. Instead, `.github/workflows/refresh-live-data.yml` refreshes `data/live.json` from public feeds on a schedule.

Current public sources:

- FRED `MORTGAGE30US` for the 30-year mortgage average
- FRED `DGS10` for the 10-year Treasury yield
- Stooq `MBB.US` quote as a public agency-MBS market proxy
- Federal Reserve Board RSS for monetary/economic news
- Zillow Research public CSVs for ZHVI, for-sale inventory, and ZIP-level ZHVF where available
- U.S. Census ACS profile data for population, income, and labor-force context

Run a manual refresh locally:

```powershell
node scripts/fetch-live-data.mjs
```

## Permanent Deployment With GitHub Pages

This repo includes `.github/workflows/pages.yml`. After the repository is published to GitHub:

1. Open the repository on GitHub.
2. Go to `Settings` > `Pages`.
3. Set `Source` to `GitHub Actions`.
4. Push to `main`.

GitHub Actions will publish the static website and show the final Pages URL in the workflow run.
