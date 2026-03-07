# Self-Hosted k6 on Railway

Production-ready setup to run **~100 virtual users** HTTP load tests from Railway. One deploy = one test run; results go to Railway logs. Optional multi-region when run on **Grafana Cloud k6**.

---

## Project structure

```
k6-testing/
├── test.js           # k6 script (100 VUs, 10 min, config via env)
├── Dockerfile        # grafana/k6:0.52.0, runs test.js on start
├── railway.toml      # Railway: Dockerfile build
├── .env.example      # Env vars template (BASE_URL, TARGET_VUS, etc.)
├── run-local.ps1           # Local: build + run in Docker
├── trigger-railway-test.ps1 # Trigger a test on Railway (railway up)
├── DEPLOYMENT.md            # How to use the k6 server after deploy
├── RESEARCH.md       # Notes on scale, regions, browser vs HTTP
└── README.md         # This file
```

---

## 1. Run locally (before deploy)

**Prerequisites:** Docker Desktop.

```powershell
.\run-local.ps1
```

Override target or users/duration:

```powershell
docker run --rm -e BASE_URL=https://your-site.netlify.app -e TARGET_VUS=100 -e DURATION_MINUTES=10 k6-railway
```

Use `.env.example` as reference; copy to `.env` and load it if you want (e.g. `Get-Content .env` and pass to `docker run -e`).

---

## 2. Deploy to Railway

1. **Create project:** [railway.app](https://railway.app) → New Project → Deploy from GitHub repo (or push this folder).
2. **Configure build:** Railway will use `railway.toml` and build the `Dockerfile`.
3. **Set variables** (Project → Variables or Service → Variables):

   | Variable            | Example                    | Description                    |
   |---------------------|----------------------------|--------------------------------|
   | `BASE_URL`          | `https://your-app.netlify.app` | Site/API to load test (Netlify, GCP, etc.) |
   | `TARGET_VUS`        | `100`                      | Virtual users (default 100)   |
   | `DURATION_MINUTES`  | `10`                       | Full test length in minutes   |
   | `DISCARD_RESPONSE_BODIES` | `false`           | Set `true` for 500+ VUs to save RAM |

4. **Deploy:** Push to the linked branch or click Deploy. The container starts, runs k6 once, then exits.

---

## 3. How to use the k6 deploy server after it’s live

Your “k6 server” on Railway is **not** an HTTP server. It’s a **one-shot runner**: each deployment runs the test once and stops.

### Run a test (trigger a run)

- **Manual:** In Railway dashboard → your service → **Redeploy** (or push a commit to the connected repo). Each new deploy = one full k6 run.
- **CLI:** From your machine (with [Railway CLI](https://docs.railway.app/develop/cli) installed and project linked):
  ```powershell
  .\trigger-railway-test.ps1
  ```
  Or run `railway up` directly. That creates a new deployment and runs the test.
- **Scheduled:** Use **Railway Cron** (if on your plan) to deploy on a schedule (e.g. daily). Each cron trigger = one test run.

### View results

- **Railway:** Open the deployment → **Logs**. k6 prints the full run (progress, summary, thresholds) to stdout, so all results are in the deployment logs.
- **Grafana/InfluxDB/etc.:** To send metrics elsewhere, add `--out` flags to the k6 command in the Dockerfile (e.g. `--out influxdb=...`) and set credentials via env.

### Change what gets tested (Netlify vs GCP, etc.)

- Update **Variables** in Railway (e.g. `BASE_URL`, `TARGET_VUS`, `DURATION_MINUTES`) and **Redeploy**. No code change needed for different targets.

---

## 4. Regions (self-hosted vs Grafana Cloud)

- **Self-hosted on Railway:** All VUs run from **one region** (the region where Railway runs your container). There is no built-in multi-region.
- **Multi-region:** For load from **multiple regions** (US, EU, APAC), run the same script on **Grafana Cloud k6** (`k6 cloud test.js`). The script already configures `options.cloud.distribution` for 4 regions; that only applies when run in Grafana Cloud.

So: use **Railway for a single-region, ~100 VU, self-hosted run**; use **Grafana Cloud k6** when you need real multi-region.

---

## 5. Final approach summary

| Step | Action |
|------|--------|
| **Build** | Railway builds the Dockerfile and runs the container. |
| **Config** | Set `BASE_URL`, `TARGET_VUS`, `DURATION_MINUTES` (and optional vars) in Railway. |
| **Trigger test** | Redeploy (dashboard or `railway up`) or schedule with Railway Cron. |
| **Results** | View deployment logs in Railway. Optionally add `--out` for Prometheus/InfluxDB/Grafana. |
| **Scale** | 100 VUs is safe. For 500+ VUs set `DISCARD_RESPONSE_BODIES=true` and ensure enough RAM. |

For more on scale, browser tests, and alternatives, see **RESEARCH.md**. For a short “after deploy” checklist, see **DEPLOYMENT.md**.
