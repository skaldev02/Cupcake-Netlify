/**
 * k6 load test – Railways (4 regions/replicas), 1000+ total VUs.
 *
 * Analysis (why errors often happen with 4 replicas):
 * - Without replica awareness, each of 4 replicas runs 0→1200 VUs = 4800 total VUs and 4x load.
 * - That can cause OOM, "too many open files", and timeouts on the k6 process or target.
 * - Logging every request at 1200 VUs floods stdout and can break or slow Railways logs.
 *
 * Solution in this script:
 * - Set K6_REPLICA_COUNT=4 and give each instance a unique K6_REPLICA_INDEX (0–3).
 *   Then each replica runs ~300 VUs (1200/4), so total load stays at 1200.
 * - Logging is sampled (every K6_LOG_EVERY_ITER iteration) and every failure, to reduce log volume.
 * - Safe reading of response.timings to avoid undefined errors in logs.
 *
 * Railway env (recommended):
 *   BASE_URL=https://startling-cheesecake-58af04.netlify.app
 *   K6_REPLICA_COUNT=4
 *   K6_REPLICA_INDEX=0   (use 0, 1, 2, 3 for each replica – set per region/deployment if needed)
 *   K6_LOG_EVERY_ITER=100
 */
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'https://brilliant-cupcake-576d17.netlify.app';

const REPLICA_COUNT = parseInt(__ENV.K6_REPLICA_COUNT || '1', 10);
const REPLICA_INDEX = parseInt(__ENV.K6_REPLICA_INDEX || '0', 10);

// Total target VUs across all replicas; per-replica target is derived below.
const TOTAL_TARGET_VUS = 1200;
const perReplica = Math.max(1, Math.ceil(TOTAL_TARGET_VUS / REPLICA_COUNT));

export function setup() {
  console.log(
    `[K6] Script started | BASE_URL=${BASE_URL} | replica ${REPLICA_INDEX + 1}/${REPLICA_COUNT} | target VUs per replica=${perReplica}`
  );
  return {};
}

const PAGES = ['/'];

// Stages scaled per replica so total load ≈ TOTAL_TARGET_VUS across all replicas.
const baseStages = [
  { duration: '2m', target: 100 },
  { duration: '3m', target: 400 },
  { duration: '3m', target: 800 },
  { duration: '2m', target: 1000 },
  { duration: '5m', target: 1250 },
  { duration: '10m', target: 1250 },
  { duration: '3m', target: 600 },
  { duration: '2m', target: 200 },
  { duration: '2m', target: 0 },
];

const scaledStages =
  REPLICA_COUNT > 1
    ? baseStages.map((s) => ({
        duration: s.duration,
        target:
          s.target === 0
            ? 0
            : Math.max(1, Math.min(perReplica, Math.ceil((s.target / TOTAL_TARGET_VUS) * perReplica))),
      }))
    : baseStages;

export const options = {
  stages: scaledStages,
  thresholds: {
    http_req_duration: ['p(95)<5000'],
    http_req_failed: ['rate<0.05'],
    checks: ['rate>0.90'],
  },
};

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Safari/605.1.15',
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Log only a sample + every failure to avoid log flood and OOM on Railways.
const LOG_EVERY_ITER = parseInt(__ENV.K6_LOG_EVERY_ITER || '100', 10);

function safeDurationMs(response) {
  const t = response.timings;
  return t && typeof t.duration === 'number' ? t.duration : 0;
}

export default function () {
  const page = PAGES[Math.floor(Math.random() * PAGES.length)];
  const url = `${BASE_URL}${page}`;

  const shouldLogStart = __ITER % LOG_EVERY_ITER === 0;
  if (shouldLogStart) console.log(`[VU ${__VU}] REQUEST START | URL=${url}`);

  const response = http.get(url, {
    headers: {
      'User-Agent': getRandomUserAgent(),
      Accept: 'text/html,*/*',
    },
    timeout: '20s',
  });

  const statusOk = response.status === 200 || response.status === 304;
  const hasContent = response.body && response.body.length > 0;
  const checkPassed = statusOk && hasContent;

  check(response, {
    'status OK': (r) => statusOk,
    'has content': (r) => hasContent,
  });

  const durationMs = safeDurationMs(response);
  const bodyLen = response.body ? response.body.length : 0;
  const shouldLogComplete = shouldLogStart || !checkPassed;
  if (shouldLogComplete) {
    console.log(
      `[VU ${__VU}] REQUEST COMPLETE | URL=${url} | status=${response.status} | duration=${durationMs}ms | body_length=${bodyLen} | check=${checkPassed ? 'PASS' : 'FAIL'}`
    );
  }

  sleep(3 + Math.random() * 2);
}
