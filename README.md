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

The dashboard evaluates the mock market summary for a lock-risk trigger. When active, it displays an in-window alert while the app is open. The Alerts panel also includes a `Test` button for manually firing the lock-risk notification.

## Permanent Deployment With GitHub Pages

This repo includes `.github/workflows/pages.yml`. After the repository is published to GitHub:

1. Open the repository on GitHub.
2. Go to `Settings` > `Pages`.
3. Set `Source` to `GitHub Actions`.
4. Push to `main`.

GitHub Actions will publish the static website and show the final Pages URL in the workflow run.
