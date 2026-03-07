# Research: Self-Hosting k6 on Railway for Production & Large-Scale Tests

## 1. Is Your Current Setup Production-Ready?

| Aspect | Current state | Production note |
|--------|----------------|-----------------|
| **k6 image** | `grafana/k6:latest` | ✅ HTTP/protocol tests only. Pin a version in production (e.g. `grafana/k6:0.52.0`) to avoid surprise breakage. |
| **Script** | HTTP-only (no browser) | ✅ Fits Railway well: low memory per VU (~1–5 MB), scales to hundreds/thousands of VUs on one container. |
| **Multi-region** | `options.cloud.distribution` | ✅ Used only when run on **Grafana Cloud k6**. On Railway you get a **single region** (Railway’s deploy region). |
| **Run model** | One run on container start, then exit | ✅ Matches Railway: deploy or cron triggers one test run; container exits when k6 finishes. |

**Verdict:** Your setup is suitable for **production HTTP load tests** on Railway. Add version pinning and optional script tweaks for large VU counts (see below).

---

## 2. Self-Hosting k6 on Railway – Feasibility

**Fits well:**
- Railway runs your Docker image once per deploy (or per cron). k6 runs the script and exits → no long-lived process.
- HTTP-only tests are light: **~1–5 MB RAM per VU** (Grafana docs). So 100–500 VUs is fine on a small container; 1k–2k VUs need more RAM.
- You can pass `BASE_URL`, `TARGET_VUS`, `DURATION_MINUTES` via Railway env vars and keep one image for many targets (Netlify, GCP, etc.).

**Limits to be aware of:**
- **Single region:** One Railway service = one region. To simulate multiple regions you’d need either **Grafana Cloud k6** (real multi-region) or **multiple Railway services in different regions** (if Railway supports that for your plan) and orchestration.
- **Resource caps (Railway):** Per [Railway scaling](https://docs.railway.app/reference/scaling):
  - **Hobby:** up to 48 vCPU / 48 GB per project (shared across services).
  - **Pro:** e.g. up to 24 vCPU and 24 GB per replica; multiple replicas possible.
- **No built-in scheduling:** Railway doesn’t have CronJobs. You’d use **Railway Cron** (if on your plan), or an external scheduler (e.g. GitHub Actions, cron elsewhere) that triggers a deploy or an HTTP endpoint that runs the test.

So: **yes, self-hosting k6 on Railway is a valid approach** for HTTP load tests at moderate scale (hundreds to low thousands of VUs, depending on plan and script).

---

## 3. Large-Scale Tests (HTTP) – What “Large” Means

From [Grafana: Running large tests](https://grafana.com/docs/k6/latest/testing-guides/running-large-tests/):

- A **single k6 process** can run on the order of **30k–40k VUs** on a powerful machine with proper OS tuning.
- **Rough RAM:** Simple HTTP tests ~1–5 MB per VU → 1,000 VUs ≈ 1–5 GB, 5,000 VUs ≈ 5–25 GB.
- **Single instance** is often enough up to ~100k–300k RPS (6–12M req/min) unless you need more.

**On Railway:**
- With **8–16 GB RAM** you can target **~2k–4k VUs** for simple HTTP scripts (ballpark).
- For **10k+ VUs** or very high RPS, a single Railway container is not the right tool; you’d use **distributed k6** (e.g. k6-operator on Kubernetes) or **Grafana Cloud k6** (auto-scaled workers, multi-region).

**Conclusion:** Railway is good for “medium” large-scale (e.g. hundreds to a few thousand VUs). True “large scale” (tens of thousands of VUs, many regions) is better handled by Grafana Cloud k6 or self-hosted k6-operator on K8s.

---

## 4. Browser Tests (k6 Browser) – Important Difference

Your current **Dockerfile uses `grafana/k6:latest`**, which **does not** include the browser module. So you are **not** running real browser tests today.

- **Browser module** = real Chromium, real JS rendering, real user-like behavior. It’s much heavier:
  - **Much higher RAM and CPU per VU** than HTTP-only.
  - Official images: `grafana/k6:latest-with-browser` (or `X.Y.Z-with-browser`). Image size is much larger (Chromium included).
- Grafana’s guidance: use **HTTP/protocol tests for bulk load** and **a small number of browser VUs** for real user metrics, or run browser tests at lower scale.

**If you want browser tests on Railway:**
- Use **`grafana/k6:latest-with-browser`** (or a versioned tag) and a script that uses `k6/browser`.
- Expect **far fewer concurrent browser VUs** per container (e.g. tens, not thousands) and higher memory/CPU.
- “Large-scale browser tests” on a single Railway service is not realistic; keep browser tests to smaller concurrency or use Grafana Cloud / dedicated infra.

---

## 5. Summary Table

| Goal | Railway self-hosted | Better alternative |
|------|---------------------|---------------------|
| HTTP load tests, 100–2k VUs, Netlify/GCP | ✅ Good fit | — |
| HTTP load tests, 10k+ VUs or multi-region | ⚠️ Limited by one container/region | Grafana Cloud k6 or k6-operator (K8s) |
| Browser tests, small scale (e.g. &lt; 50 VUs) | ✅ Possible with `-with-browser` image | — |
| Browser tests, “large scale” | ❌ Not practical on one Railway service | Grafana Cloud k6 or dedicated runners |

---

## 6. Recommended Production Tweaks (Your Repo)

1. **Pin k6 image version** in `Dockerfile` (e.g. `grafana/k6:0.52.0`) so builds are reproducible.
2. **For higher VU counts**, in `test.js` add to `options`:  
   `noConnectionReuse: false` (default; reuse is good), and for **very high VU** runs consider `discardResponseBodies: true` if you don’t need response bodies (saves RAM).
3. **Browser tests:** Add a second Dockerfile (e.g. `Dockerfile.browser`) using `grafana/k6:0.52.0-with-browser` and a separate script for browser scenarios; keep the current image for HTTP-only and scale.

---

## References

- [Grafana k6 – Running large tests](https://grafana.com/docs/k6/latest/testing-guides/running-large-tests/)
- [Grafana k6 – Running distributed tests](https://grafana.com/docs/k6/latest/testing-guides/running-distributed-tests/)
- [Grafana k6 – Use load zones](https://grafana.com/docs/grafana-cloud/testing/k6/author-run/use-load-zones)
- [Grafana k6 – Running browser tests](https://grafana.com/docs/k6/latest/using-k6-browser/running-browser-tests)
- [Railway – Scaling](https://docs.railway.app/reference/scaling)
- [Railway – Pricing / plans](https://docs.railway.com/reference/pricing/plans)
