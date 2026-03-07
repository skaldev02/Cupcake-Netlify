import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// Metrics
const errorRate = new Rate('errors');
const responseTime = new Trend('response_time');
const requestCounter = new Counter('total_requests');
const pageLoadTime = new Trend('page_load_time');

// Configuration
// Prefer BASE_URL (common in Grafana Cloud), but keep VERCEL_URL for backwards-compatibility
const BASE_URL = __ENV.BASE_URL || __ENV.VERCEL_URL || 'https://www.caakus.com';
const TARGET_USERS = parseInt(__ENV.TARGET_USERS || '10000', 10);

// Grafana Cloud k6: load zone configuration (used only when running in the Cloud)
// Example: K6_CLOUD_ZONE="amazon:us:ashburn" K6_CLOUD_ZONE_PERCENT="100"
const K6_CLOUD_ZONE = __ENV.K6_CLOUD_ZONE || 'amazon:us:ashburn';
const K6_CLOUD_ZONE_PERCENT = parseInt(__ENV.K6_CLOUD_ZONE_PERCENT || '100', 10);

// All page routes to test
const PAGES = [
  '/',
  '/quantum-clicker',
  '/about',
  '/about-founder',
  '/contact',
  '/privacy',
  '/terms-of-service',
  '/support',
  '/settings',
  '/chat',
  '/voice',
  '/finance-analysis',
];

// Dynamic routes (with random IDs)
const DYNAMIC_ROUTES = [
  '/voice/12345', // Example dynamic route
];

export const options = {
  stages: [
    // Very slow initial ramp-up to avoid triggering bot protection
    { duration: '1m', target: 50 },   // Start with just 50 users
    { duration: '2m', target: 200 },  // Gradually increase to 200
    { duration: '3m', target: 500 },  // Then 500
    { duration: '5m', target: 1000 }, // Then 1000
    // Continue gradual ramp-up
    { duration: '5m', target: 2500 }, // Then 2500
    { duration: '5m', target: 5000 }, // Then 5000
    { duration: '10m', target: TARGET_USERS }, // Finally reach target
    // Stay at peak for 15 minutes (sustained load)
    { duration: '15m', target: TARGET_USERS },
    // Gradual ramp down
    { duration: '5m', target: 5000 },
    { duration: '3m', target: 2000 },
    { duration: '2m', target: 500 },
    { duration: '1m', target: 0 },
  ],
  thresholds: {
    // 95% of requests should complete within 8 seconds (more lenient due to delays)
    http_req_duration: ['p(95)<8000', 'p(99)<15000'],
    // Allow up to 10% failures (403s are expected, especially early in test)
    http_req_failed: ['rate<0.10'],
    // Page load times should be reasonable
    page_load_time: ['p(95)<10000'],
    // Error rate - allow higher due to 403s from bot protection
    errors: ['rate<0.10'],
  },
  // Grafana Cloud k6 options (ignored by local `k6 run`)
  // Docs: https://grafana.com/docs/k6/latest/using-k6/k6-options/reference/#cloud
  cloud: {
    distribution: {
      [K6_CLOUD_ZONE]: { loadZone: K6_CLOUD_ZONE, percent: K6_CLOUD_ZONE_PERCENT },
    },
  },
};

/**
 * Get headers for requests
 */
// Rotate User-Agents to appear more like real browsers
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

// Option to bypass cache for testing actual server load
const BYPASS_CACHE = __ENV.BYPASS_CACHE === 'true' || false;

function getHeaders(bypassCache = false) {
  // Randomly select a User-Agent for each request
  const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  
  const headers = {
    'User-Agent': userAgent,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'DNT': '1', // Do Not Track
  };
  
  // Add cache-busting headers if requested (tests actual server, not cache)
  if (bypassCache || BYPASS_CACHE) {
    headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    headers['Pragma'] = 'no-cache';
    headers['X-Request-ID'] = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  } else {
    headers['Cache-Control'] = 'max-age=0'; // Check cache but revalidate
  }
  
  return headers;
}

// Track consecutive 403s per VU to implement circuit breaker
let consecutive403s = 0;
const MAX_CONSECUTIVE_403S = 3; // After 3 consecutive 403s, back off significantly

/**
 * Test a single page with smart handling
 */
function testPage(url) {
  const fullUrl = `${BASE_URL}${url}`;
  
  // Circuit breaker: If we've had too many 403s, wait longer before making request
  if (consecutive403s >= MAX_CONSECUTIVE_403S) {
    const longBackoff = Math.random() * 20 + 15; // 15-35 seconds
    sleep(longBackoff);
    consecutive403s = Math.max(0, consecutive403s - 1); // Gradually reduce counter
    // Still make the request, but after long backoff
  }
  
  const startTime = Date.now();
  
  // Test with cache-busting 30% of the time for homepage to hit actual server
  const bypassCache = (url === '/' && Math.random() < 0.3) || (url !== '/' && Math.random() < 0.2);
  
  const res = http.get(fullUrl, {
    headers: getHeaders(bypassCache),
    tags: { name: `Page: ${url}` },
  });
  
  const loadTime = Date.now() - startTime;
  pageLoadTime.add(loadTime);
  
  // Check if response came from cache (very fast responses < 50ms are likely cached)
  const likelyCached = loadTime < 50 && res.status === 200;
  
  // Log every 50 requests or on errors (more frequent logging)
  if (__ITER % 50 === 0 || res.status !== 200) {
    const cacheStatus = likelyCached ? ' (CACHED)' : bypassCache ? ' (NO-CACHE)' : '';
    const statusEmoji = res.status === 200 ? '✅' : res.status === 403 || res.status === 429 ? '⚠️' : '❌';
    console.log(`${statusEmoji} ${url}: ${res.status}${cacheStatus} - ${loadTime}ms`);
  }
  
  // Handle different status codes
  const isSuccess = res.status === 200;
  const isBlocked = res.status === 403 || res.status === 429; // 403 = Forbidden (bot protection), 429 = Rate limit
  
  const success = check(res, {
    [`${url} status is 200`]: (r) => r.status === 200,
    [`${url} has content`]: (r) => r.body && r.body.length > 0,
    [`${url} response time < 10s`]: (r) => r.timings.duration < 10000,
    [`${url} not blocked`]: (r) => r.status !== 403, // Track 403s separately
  });
  
  if (isBlocked) {
    consecutive403s++;
    // 403/429 are expected at high load - don't count as critical errors
    errorRate.add(0.5); // Half error (expected but not ideal)
    if (__ITER % 100 === 0) {
      console.log(`⚠️  ${url}: Status ${res.status} (Blocked) - Consecutive: ${consecutive403s}`);
    }
    
    // Exponential backoff - longer each time we get blocked
    const backoffDelay = Math.min(Math.pow(2, Math.min(consecutive403s, 4)) * (Math.random() * 3 + 2), 30);
    sleep(backoffDelay);
    
    // Log occasionally to track blocking patterns
    if (__ITER % 50 === 0) {
      console.log(`⏸️  Backing off for ${backoffDelay.toFixed(1)}s after 403 (consecutive: ${consecutive403s})`);
    }
  } else {
    // Success! Reset consecutive 403 counter
    consecutive403s = 0;
    
    if (!success) {
      errorRate.add(1);
      if (__ITER % 100 === 0) {
        console.log(`❌ ${url}: Status ${res.status}, Size: ${res.body ? res.body.length : 0} bytes`);
      }
    } else {
      errorRate.add(0);
      if (__ITER % 1000 === 0) {
        console.log(`✅ ${url}: ${res.status} (${(res.timings.duration / 1000).toFixed(2)}s)`);
      }
    }
  }
  
  responseTime.add(res.timings.duration);
  requestCounter.add(1);
  
  return res;
}

/**
 * Test static assets (CSS, JS, images)
 */
function testStaticAssets() {
  const assets = [
    '/favicon.ico',
    '/manifest.json',
  ];
  
  assets.forEach(asset => {
    const res = http.get(`${BASE_URL}${asset}`, {
      headers: getHeaders(),
      tags: { name: `Asset: ${asset}` },
    });
    
    check(res, {
      [`${asset} accessible`]: (r) => r.status === 200 || r.status === 404, // 404 is OK for optional assets
    });
    
    requestCounter.add(1);
  });
}

/**
 * Simulate user browsing behavior
 */
export default function () {
  const vuId = __VU;
  const iteration = __ITER;
  
  // Add initial random delay to stagger VU starts (prevents all VUs hitting at once)
  // This helps avoid triggering bot protection immediately
  if (iteration === 0) {
    sleep(Math.random() * 10 + 5); // 5-15 seconds initial delay for new VU
  }
  
  // Simulate realistic user behavior with random delays
  // 1. Visit homepage first
  const homeResult = testPage('/');
  
  // If we got blocked, wait longer and maybe skip some requests
  if (homeResult && (homeResult.status === 403 || homeResult.status === 429)) {
    sleep(Math.random() * 20 + 15); // 15-35 seconds if blocked
    // Skip some requests if heavily blocked
    if (Math.random() > 0.5) {
      return; // Skip this iteration entirely
    }
  } else {
    sleep(Math.random() * 4 + 3); // 3-7 seconds (more realistic, longer delays)
  }
  
  // 2. Visit a random page (only if not heavily blocked)
  if (consecutive403s < MAX_CONSECUTIVE_403S) {
    const randomPage = PAGES[Math.floor(Math.random() * PAGES.length)];
    const pageResult = testPage(randomPage);
    
    if (pageResult && (pageResult.status === 403 || pageResult.status === 429)) {
      sleep(Math.random() * 15 + 10); // 10-25 seconds if blocked
    } else {
      sleep(Math.random() * 5 + 3); // 3-8 seconds (longer delays to appear more human)
    }
    
    // 3. Visit another random page (50% chance - reduced further)
    if (Math.random() > 0.5 && consecutive403s < MAX_CONSECUTIVE_403S) {
      const anotherPage = PAGES[Math.floor(Math.random() * PAGES.length)];
      if (anotherPage !== randomPage) {
        testPage(anotherPage);
        sleep(Math.random() * 4 + 3); // 3-7 seconds (more realistic)
      }
    }
  }
  
  // 4. Test dynamic route (30% chance)
  if (Math.random() > 0.7 && DYNAMIC_ROUTES.length > 0) {
    const dynamicRoute = DYNAMIC_ROUTES[Math.floor(Math.random() * DYNAMIC_ROUTES.length)];
    testPage(dynamicRoute);
    sleep(Math.random() * 2 + 1);
  }
  
  // 5. Load static assets (30% chance - reduced to be more realistic)
  if (Math.random() > 0.7) {
    testStaticAssets();
    sleep(Math.random() * 2 + 1); // 1-3 seconds after assets
  }
  
  // Add a longer pause between iterations to simulate real user behavior
  // Real users don't continuously browse - they take breaks
  if (Math.random() > 0.7) {
    sleep(Math.random() * 10 + 5); // 5-15 seconds break (30% chance)
  }
  
  // Log progress every 200 iterations (more frequent)
  if (iteration % 200 === 0 && iteration > 0) {
    console.log(`📊 VU ${vuId}, Iteration ${iteration}: Testing ${BASE_URL}`);
  }
  
  // Periodic status update every 500 iterations
  if (iteration % 500 === 0 && iteration > 0) {
    console.log(`📈 VU ${vuId}: Completed ${iteration} iterations`);
  }
}

/**
 * Summary handler
 */
export function handleSummary(data) {
  const summary = {
    timestamp: new Date().toISOString(),
    baseUrl: BASE_URL,
    totalRequests: data.metrics.http_reqs.values.count,
    totalErrors: data.metrics.http_req_failed.values.rate * data.metrics.http_reqs.values.count,
    avgResponseTime: data.metrics.http_req_duration.values.avg,
    p95ResponseTime: data.metrics.http_req_duration.values['p(95)'],
    p99ResponseTime: data.metrics.http_req_duration.values['p(99)'],
    errorRate: data.metrics.http_req_failed.values.rate,
    avgPageLoadTime: data.metrics.page_load_time ? data.metrics.page_load_time.values.avg : null,
    p95PageLoadTime: data.metrics.page_load_time ? data.metrics.page_load_time.values['p(95)'] : null,
  };
  
  console.log('\n📊 Load Test Summary:');
  console.log(`   Total Requests: ${summary.totalRequests}`);
  console.log(`   Total Errors: ${summary.totalErrors.toFixed(0)}`);
  console.log(`   Error Rate: ${(summary.errorRate * 100).toFixed(2)}%`);
  console.log(`   Avg Response Time: ${summary.avgResponseTime.toFixed(2)}ms`);
  console.log(`   P95 Response Time: ${summary.p95ResponseTime.toFixed(2)}ms`);
  console.log(`   P99 Response Time: ${summary.p99ResponseTime.toFixed(2)}ms`);
  if (summary.avgPageLoadTime) {
    console.log(`   Avg Page Load Time: ${summary.avgPageLoadTime.toFixed(2)}ms`);
    console.log(`   P95 Page Load Time: ${summary.p95PageLoadTime.toFixed(2)}ms`);
  }
  
  return {
    'stdout': JSON.stringify(summary, null, 2),
  };
}

