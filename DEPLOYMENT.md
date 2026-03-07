# How to Use Your k6 Deployment on Railway

Quick reference once the service is deployed.

---

## What “deployed” means

- The service **builds** from the Dockerfile and **runs** the container.
- The container **starts** → k6 runs `test.js` once → container **exits**.
- There is **no long-running server**. To run another test, you trigger a **new deployment**.

---

## Trigger a test run

1. **Railway dashboard**  
   Open your project → select the k6 service → **Deploy** / **Redeploy**. Each deploy = one full k6 run.

2. **Railway CLI** (from your machine, in the project directory and linked to the same project):
   ```powershell
   railway up
   ```
   This deploys and runs the test.

3. **Git push**  
   If the service is connected to a GitHub repo, push a commit to the linked branch. Railway will deploy and run the test.

4. **Scheduled (Railway Cron)**  
   If your plan supports it, add a Cron job that deploys this service on a schedule (e.g. daily). Each run = one test.

---

## Where to see results

- **Deployment logs:** In Railway, open the **latest deployment** for the k6 service → **Logs**.  
  k6 prints progress and the final summary (iterations, RPS, latency, pass/fail) to stdout, so everything appears there.

- **Different target or duration:** Change **Variables** (`BASE_URL`, `TARGET_VUS`, `DURATION_MINUTES`) in the Railway project/service, then trigger a new deploy. No code change needed.

---

## Variables to set (Railway → Variables)

| Variable | Recommended | Description |
|----------|-------------|-------------|
| `BASE_URL` | Your Netlify/GCP URL | Base URL to load test |
| `TARGET_VUS` | `100` | Number of virtual users |
| `DURATION_MINUTES` | `10` | Total test duration (minutes) |
| `DISCARD_RESPONSE_BODIES` | `false` (or `true` if 500+ VUs) | Reduces RAM use |

---

## One-line summary

**To run a test:** trigger a new deployment (Redeploy, `railway up`, or Cron).  
**To see results:** open that deployment’s logs in Railway.
