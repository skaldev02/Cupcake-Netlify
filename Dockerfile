# Production self-hosted k6 for ~100 VUs, HTTP load tests.
# Pin version for reproducible builds.
FROM grafana/k6:0.52.0
WORKDIR /scripts
COPY test.js .
# All config via env (BASE_URL, TARGET_VUS, DURATION_MINUTES, etc.)
ENTRYPOINT ["k6", "run", "test.js"]
