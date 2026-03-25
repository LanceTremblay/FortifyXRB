// FortifyXRB (X Region Blocker) v1.0

(function () {
  'use strict';

  const CHANNEL   = '__xrb_data__';
  const CACHE_KEY = 'xrb_location_cache_v2';
  const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
  const NEG_TTL   =  3 * 24 * 60 * 60 * 1000;

  // ── State ──────────────────────────────────────────────────────────────────

  let blockedRegions   = [];
  let blockMode        = 'overlay';
  let memCache         = new Map();
  let blockedUsernames = new Set();
  let pendingUsernames = new Set();

  let rateLimitedUntil = 0;
  let lastRequestTime  = 0;
  let backoffMs        = 800;      // starts at 800ms, doubles on 429
  const MAX_BACKOFF    = 60000;    // cap at 60s
  const MAX_CONCURRENT = 2;
  let   activeRequests = 0;

  let aboutQueryHash = 'XRqGa7EeokUU5kppkh13EA';
  const HASH_FALLBACKS = [
    'XRqGa7EeokUU5kppkh13EA',
    'G3KGOASz96M-Qu0nwmGXNg',
    'qW5u-DAuXpMEG0zA1F7UGQ',
    'SAMkL5y_N9pmahSw8yy6gA',
  ];

  const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

  const SKIP = new Set(['home','explore','notifications','messages','search',
    'settings','i','compose','intent','hashtag','about','following',
    'followers','lists','bookmarks','verified_followers','super_follows',
    'who_to_follow','topics','connect_people']);

  let lastPath = '';

  // ── Init ───────────────────────────────────────────────────────────────────

  async function init() {
    await loadDiskCache();
    loadSettings(async () => {
      listenToInjector();
      startObserver();
      startIntersectionObserver();
      startIntervalScan();
      discoverQueryHash();
      // Retry scanAll multiple times to catch late-rendering articles
      scanAll();
      setTimeout(scanAll, 500);
      setTimeout(scanAll, 1500);
      setTimeout(scanAll, 3000);
      setTimeout(checkProfilePage, 1000);
      setTimeout(checkProfilePage, 2500);
      setTimeout(checkProfilePage, 4000);
    });
    console.log('[XRB] v1.0 ready');
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  function loadSettings(cb) {
    chrome.storage.sync.get(['blockedRegions', 'blockMode'], data => {
      blockedRegions = (data.blockedRegions || []).map(r => r.toLowerCase().trim());
      blockMode      = data.blockMode || 'overlay';
      console.log('[XRB] Settings:', blockedRegions, blockMode);
      if (cb) cb();
    });
  }

  chrome.storage.onChanged.addListener(changes => {
    if (changes.blockedRegions || changes.blockMode) {
      loadSettings(() => {
        blockedUsernames.clear();
        pendingUsernames.clear();
        clearVisualTreatments();
        memCache.forEach((val, username) => {
          if (val.country && isBlocked(val.country)) blockedUsernames.add(username);
        });
        scanAll();
        checkProfilePage();
      });
    }
  });

  function isBlocked(text) {
    if (!text || !blockedRegions.length) return false;
    const t = text.toLowerCase().trim();
    return blockedRegions.some(r => t.includes(r));
  }

  // ── Disk cache ─────────────────────────────────────────────────────────────

  async function loadDiskCache() {
    try {
      const stored = await chrome.storage.local.get(CACHE_KEY);
      const raw = stored[CACHE_KEY] || {};
      const now = Date.now();
      let loaded = 0;
      for (const [username, entry] of Object.entries(raw)) {
        const ttl = entry.country ? CACHE_TTL : NEG_TTL;
        if (now - entry.ts < ttl) {
          memCache.set(username, entry);
          if (entry.country && isBlocked(entry.country)) {
            blockedUsernames.add(username);
          }
          loaded++;
        }
      }
      console.log('[XRB] Cache loaded:', loaded, 'entries,', blockedUsernames.size, 'blocked');
    } catch (e) {}
  }

  async function saveToDiskCache(username, country) {
    try {
      const stored = await chrome.storage.local.get(CACHE_KEY);
      const raw = stored[CACHE_KEY] || {};
      raw[username] = { country: country || '', ts: Date.now() };
      if (Object.keys(raw).length > 8000) {
        const sorted = Object.entries(raw).sort((a,b) => b[1].ts - a[1].ts).slice(0, 6000);
        await chrome.storage.local.set({ [CACHE_KEY]: Object.fromEntries(sorted) });
      } else {
        await chrome.storage.local.set({ [CACHE_KEY]: raw });
      }
    } catch (e) {}
  }

  function cacheResult(username, country) {
    const lower = username.toLowerCase();
    memCache.set(lower, { country: country || '', ts: Date.now() });
    saveToDiskCache(lower, country);
    if (country && isBlocked(country)) {
      blockedUsernames.add(lower);
      rescanDOM();
      checkProfilePage();
    }
  }

  // ── Discover GraphQL hash ──────────────────────────────────────────────────

  async function discoverQueryHash() {
    try {
      const scripts = [...document.querySelectorAll('script[src*="main."]')];
      for (const script of scripts.slice(0, 3)) {
        const res = await fetch(script.src);
        if (!res.ok) continue;
        const text = await res.text();
        const m1 = text.match(/["']([A-Za-z0-9_-]{20,})["'][^"']{0,80}AboutAccountQuery/);
        const m2 = text.match(/AboutAccountQuery[^"']{0,80}["']([A-Za-z0-9_-]{20,})["']/);
        const hash = (m1 || m2)?.[1];
        if (hash) {
          aboutQueryHash = hash;
          console.log('[XRB] Discovered hash:', hash);
          return;
        }
      }
    } catch (e) {}
  }

  // ── GraphQL lookup ─────────────────────────────────────────────────────────

  async function lookupViaGraphQL(username) {
    const lower = username.toLowerCase();

    if (Date.now() < rateLimitedUntil) return null;

    const cached = memCache.get(lower);
    if (cached) {
      const ttl = cached.country ? CACHE_TTL : NEG_TTL;
      if (Date.now() - cached.ts < ttl) return cached.country || null;
    }

    if (pendingUsernames.has(lower)) return null;
    if (activeRequests >= MAX_CONCURRENT) return null;

    const elapsed = Date.now() - lastRequestTime;
    if (elapsed < backoffMs) await sleep(backoffMs - elapsed);

    pendingUsernames.add(lower);
    activeRequests++;
    lastRequestTime = Date.now();

    const hashes = [aboutQueryHash, ...HASH_FALLBACKS.filter(h => h !== aboutQueryHash)];

    for (const hash of hashes) {
      try {
        const variables = encodeURIComponent(JSON.stringify({ screenName: lower }));
        const features  = encodeURIComponent(JSON.stringify({
          hidden_profile_subscriptions_enabled: true,
          responsive_web_graphql_exclude_directive_enabled: true,
          verified_phone_label_enabled: false
        }));
        const url = `https://x.com/i/api/graphql/${hash}/AboutAccountQuery?variables=${variables}&features=${features}`;

        const res = await fetch(url, {
          headers: {
            'authorization': `Bearer ${BEARER}`,
            'x-csrf-token': getCsrfToken(),
            'x-twitter-active-user': 'yes',
            'x-twitter-auth-type': 'OAuth2Session',
          },
          credentials: 'include'
        });

        if (res.status === 429) {
          backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF);
          rateLimitedUntil = Date.now() + (15 * 60 * 1000);
          console.log('[XRB] 429 — backing off until', new Date(rateLimitedUntil).toLocaleTimeString(), '| next interval:', backoffMs, 'ms');
          activeRequests--;
          pendingUsernames.delete(lower);
          return null;
        }

        if (res.status === 403 || res.status === 401) {
          activeRequests--;
          pendingUsernames.delete(lower);
          cacheResult(lower, '');
          return null;
        }

        if (!res.ok) continue;

        const data = await res.json();
        if (data.errors) continue;

        const result  = data?.data?.user_result_by_screen_name?.result
                     || data?.data?.user?.result;
        let country   = result?.about_profile?.account_based_in || '';

        // Fallback: if AboutAccountQuery gave no country (e.g. govt accounts),
        // use the profile location field from the same response
        if (!country) {
          country = result?.legacy?.location || '';
        }

        // Second fallback: call UserByScreenName which always returns legacy.location
        if (!country) {
          try {
            const ubsnVars = encodeURIComponent(JSON.stringify({ screen_name: lower, withSafetyModeUserFields: true }));
            const ubsnFeatures = encodeURIComponent(JSON.stringify({ hidden_profile_subscriptions_enabled: true, responsive_web_graphql_exclude_directive_enabled: true, verified_phone_label_enabled: false }));
            const ubsnHashes = ['G3KGOASz96M-Qu0nwmGXNg', 'qW5u-DAuXpMEG0zA1F7UGQ', 'SAMkL5y_N9pmahSw8yy6gA'];
            for (const ubsnHash of ubsnHashes) {
              const ubsnUrl = `https://x.com/i/api/graphql/${ubsnHash}/UserByScreenName?variables=${ubsnVars}&features=${ubsnFeatures}`;
              const ubsnRes = await fetch(ubsnUrl, {
                headers: {
                  'authorization': `Bearer ${BEARER}`,
                  'x-csrf-token': getCsrfToken(),
                  'x-twitter-active-user': 'yes',
                  'x-twitter-auth-type': 'OAuth2Session',
                },
                credentials: 'include'
              });
              if (!ubsnRes.ok) continue;
              const ubsnData = await ubsnRes.json();
              const ubsnLoc = ubsnData?.data?.user?.result?.legacy?.location || '';
              if (ubsnLoc) { country = ubsnLoc; break; }
            }
          } catch(e) {}
        }

        console.log('[XRB] Lookup:', lower, '->', country || '(none)');
        if (hash !== aboutQueryHash) {
          aboutQueryHash = hash;
          console.log('[XRB] Updated working hash to:', hash);
        }
        // On success, slowly reduce backoff
        backoffMs = Math.max(800, backoffMs * 0.8);

        cacheResult(lower, country);
        activeRequests--;
        pendingUsernames.delete(lower);
        return country || null;

      } catch (e) { continue; }
    }

    cacheResult(lower, '');
    activeRequests--;
    pendingUsernames.delete(lower);
    return null;
  }

  function getCsrfToken() {
    const match = document.cookie.match(/ct0=([^;]+)/);
    return match ? match[1] : '';
  }

  // ── Injector listener ──────────────────────────────────────────────────────

  function listenToInjector() {
    window.addEventListener(CHANNEL, (e) => {
      const { type, payload } = e.detail || {};
      if (type === 'about_country') {
        console.log('[XRB] Free data from X:', payload.username, '->', payload.country);
        cacheResult(payload.username, payload.country);
      }
      if (type === 'legacy_location') {
        const { username, location } = payload;
        if (location && isBlocked(location)) {
          cacheResult(username, location);
        } else if (!memCache.has(username)) {
          queueLookup(username);
        }
      }
    });
  }

  // ── Lookup queue ───────────────────────────────────────────────────────────

  const lookupQueue    = [];
  const lookupQueueSet = new Set(); // O(1) duplicate check
  const MAX_QUEUE_SIZE = 100;       // prevent unbounded growth on heavy pages
  let   queueRunning   = false;

  function queueLookup(username) {
    const lower = username.toLowerCase();
    if (memCache.has(lower) || pendingUsernames.has(lower) || blockedUsernames.has(lower)) return;
    if (lookupQueueSet.has(lower)) return;
    if (Date.now() < rateLimitedUntil) return;
    if (lookupQueue.length >= MAX_QUEUE_SIZE) return;
    lookupQueue.push(lower);
    lookupQueueSet.add(lower);
    if (!queueRunning) drainQueue();
  }

  async function drainQueue() {
    if (queueRunning) return;
    queueRunning = true;
    while (lookupQueue.length > 0) {
      if (Date.now() < rateLimitedUntil) {
        console.log('[XRB] Queue paused — rate limited');
        break;
      }
      if (activeRequests >= MAX_CONCURRENT) {
        await sleep(200);
        continue;
      }
      const username = lookupQueue.shift();
      if (!username) continue;
      lookupQueueSet.delete(username);
      if (memCache.has(username) || blockedUsernames.has(username)) continue;
      lookupViaGraphQL(username);
      await sleep(backoffMs);
    }
    queueRunning = false;
  }

  // ── Visual treatment on tweets ─────────────────────────────────────────────

  function escapeHtml(s) {
    return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function applyTreatment(article, locationText) {
    if (article.dataset.xrbDone) return;
    article.dataset.xrbDone = 'true';

    if (blockMode === 'hide') {
      article.style.display = 'none';
      return;
    }
    if (blockMode === 'blur') {
      article.style.filter = 'blur(7px)';
      article.style.opacity = '0.3';
      article.style.pointerEvents = 'none';
      return;
    }

    // Overlay mode
    const tweetCell = article.querySelector('[data-testid="tweet"]') || article;
    tweetCell.style.position = 'relative';

    // Red circle on avatar — above overlay
    const avatar = article.querySelector('img[src*="profile_images"]');
    if (avatar) {
      const wrap = avatar.closest('a') || avatar.parentElement;
      if (wrap && !wrap.dataset.xrbCircle) {
        wrap.style.cssText += 'position:relative!important;display:inline-block!important;z-index:9998!important;';
        const circle = document.createElement('div');
        circle.className = 'xrb-red-circle';
        circle.title = `Blocked: ${locationText}`;
        wrap.appendChild(circle);
        wrap.dataset.xrbCircle = 'true';
      }
    }

    // Dark overlay with centered no-symbol and country
    if (!tweetCell.querySelector('.xrb-overlay')) {
      const overlay = document.createElement('div');
      overlay.className = 'xrb-overlay';
      overlay.style.cssText = [
        'position:absolute!important',
        'top:0!important','left:0!important',
        'width:100%!important','height:100%!important',
        'background:rgba(0,0,0,0.90)!important',
        'z-index:9990!important',
        'pointer-events:none!important',
        'display:flex!important',
        'flex-direction:column!important',
        'align-items:center!important',
        'justify-content:center!important',
        'gap:6px!important',
        'border-radius:inherit!important',
      ].join(';');
      overlay.innerHTML = `
        <div style="width:30px;height:30px;border-radius:50%;border:3px solid #ff3333;position:relative;flex-shrink:0;">
          <div style="position:absolute;top:50%;left:50%;width:130%;height:3px;background:#ff3333;transform:translate(-50%,-50%) rotate(-45deg);border-radius:2px;"></div>
        </div>
        <span style="font-size:11px;font-weight:600;color:rgba(255,255,255,0.7);letter-spacing:0.08em;text-transform:uppercase;font-family:-apple-system,sans-serif;">Blocked Region</span>
        <span style="font-size:12px;color:rgba(255,90,90,0.95);font-weight:500;font-family:-apple-system,sans-serif;">${escapeHtml(locationText)}</span>
      `;
      tweetCell.appendChild(overlay);
    }
  }

  // ── Profile page big no-symbol ─────────────────────────────────────────────

  function checkProfilePage() {
    const pathname = window.location.pathname;
    const pageMatch = pathname.match(/^\/([A-Za-z0-9_]+)(?:\/|$)/);
    if (!pageMatch) return;

    const username = pageMatch[1].toLowerCase();
    if (SKIP.has(username)) return;

    if (blockedUsernames.has(username)) {
      applyProfileBlock(username);
    } else if (!memCache.has(username) && !pendingUsernames.has(username)) {
      queueLookup(username);
    }
  }

  function applyProfileBlock(username) {
    const entry   = memCache.get(username);
    const country = entry?.country || 'blocked region';

    // ── Big no-symbol on the profile header avatar ─────────────────────────
    // Try multiple selectors X uses for the large profile avatar
    const avatarSelectors = [
      '[data-testid="UserProfileHeader_Items"] ~ * a[href$="/photo"] img[src*="profile_images"]',
      'a[href$="/photo"] img[src*="profile_images"]',
      'a[href*="/photo"] img[src*="profile_images"]',
      '[data-testid="UserAvatar"] img[src*="profile_images"]',
      'img[src*="profile_images"][alt]:not([src*="_normal"])',
    ];

    let profileAvatar = null;
    for (const sel of avatarSelectors) {
      profileAvatar = document.querySelector(sel);
      if (profileAvatar) break;
    }

    if (profileAvatar) {
      const wrap = profileAvatar.closest('a, [data-testid="UserAvatar"]') || profileAvatar.parentElement;
      if (wrap && !wrap.dataset.xrbProfileCircle) {
        wrap.style.cssText += 'position:relative!important;display:inline-block!important;';
        wrap.dataset.xrbProfileCircle = 'true';

        // Large no-symbol — sized to the avatar
        const noSymbol = document.createElement('div');
        noSymbol.className = 'xrb-profile-no-symbol';
        noSymbol.title = `Blocked: ${country}`;
        noSymbol.style.cssText = [
          'position:absolute!important',
          'inset:0!important',
          'border-radius:50%!important',
          'border:4px solid #ff2222!important',
          'z-index:9999!important',
          'pointer-events:none!important',
          'box-sizing:border-box!important',
          'animation:xrb-pulse 2s ease-in-out infinite!important',
        ].join(';');

        // Diagonal slash
        const slash = document.createElement('div');
        slash.style.cssText = [
          'position:absolute!important',
          'top:50%!important','left:50%!important',
          'width:135%!important','height:4px!important',
          'background:#ff2222!important',
          'transform:translate(-50%,-50%) rotate(-45deg)!important',
          'border-radius:2px!important',
        ].join(';');
        noSymbol.appendChild(slash);
        wrap.appendChild(noSymbol);

        // Dark tint over the avatar image
        const tint = document.createElement('div');
        tint.style.cssText = [
          'position:absolute!important',
          'inset:0!important',
          'border-radius:50%!important',
          'background:rgba(0,0,0,0.45)!important',
          'z-index:9998!important',
          'pointer-events:none!important',
        ].join(';');
        wrap.appendChild(tint);
      }
    }

    // ── Banner below profile name ──────────────────────────────────────────
    if (!document.querySelector('.xrb-profile-banner')) {
      const headerItems = document.querySelector('[data-testid="UserProfileHeader_Items"]');
      if (headerItems) {
        const banner = document.createElement('div');
        banner.className = 'xrb-banner xrb-profile-banner';
        banner.style.cssText = 'margin:8px 0;border-radius:0;';
        banner.innerHTML = `<span class="xrb-banner-icon">🚫</span><span class="xrb-banner-text">Blocked region: <strong>${escapeHtml(country)}</strong></span>`;
        headerItems.parentElement.insertBefore(banner, headerItems);
      }
    }
  }

  // ── Username extraction ────────────────────────────────────────────────────

  function getUsernameFromArticle(article) {
    // Try UserName testid first
    const nameEl = article.querySelector('[data-testid="UserName"] a[href^="/"]');
    if (nameEl) {
      const m = nameEl.getAttribute('href').match(/^\/([A-Za-z0-9_]+)(?:\/|\?|$)/);
      if (m && !SKIP.has(m[1].toLowerCase())) return m[1].toLowerCase();
    }
    // Fallback to first non-skip profile link
    for (const link of article.querySelectorAll('a[href^="/"]')) {
      const m = (link.getAttribute('href')||'').match(/^\/([A-Za-z0-9_]+)(?:\/|\?|$)/);
      if (m && !SKIP.has(m[1].toLowerCase())) return m[1].toLowerCase();
    }
    return null;
  }

  // ── Process single article ─────────────────────────────────────────────────

  function processArticle(article) {
    if (article.dataset.xrbDone) return;
    const username = getUsernameFromArticle(article);
    if (!username) return;

    if (blockedUsernames.has(username)) {
      const entry = memCache.get(username);
      applyTreatment(article, entry?.country || 'blocked region');
      return;
    }

    const cached = memCache.get(username);
    if (cached) {
      const ttl = cached.country ? CACHE_TTL : NEG_TTL;
      if (Date.now() - cached.ts < ttl) {
        if (cached.country && isBlocked(cached.country)) applyTreatment(article, cached.country);
        return;
      }
    }

    article.dataset.xrbQueued = 'true';
    queueLookup(username);
  }

  // ── Rescan DOM ─────────────────────────────────────────────────────────────

  function rescanDOM() {
    document.querySelectorAll('article[data-testid="tweet"], article[role="article"]').forEach(art => {
      if (art.dataset.xrbDone) return;
      const username = getUsernameFromArticle(art);
      if (username && blockedUsernames.has(username)) {
        const entry = memCache.get(username);
        applyTreatment(art, entry?.country || 'blocked region');
      }
    });
  }

  // ── Scan all articles on page ──────────────────────────────────────────────

  function scanAll() {
    const articles = document.querySelectorAll('article[data-testid="tweet"], article[role="article"]');
    console.log('[XRB] scanAll found', articles.length, 'articles on', window.location.pathname);
    articles.forEach(processArticle);
  }

  // ── Clear all visual treatments ────────────────────────────────────────────

  function clearVisualTreatments() {
    document.querySelectorAll('.xrb-banner, .xrb-red-circle, .xrb-overlay, .xrb-profile-no-symbol').forEach(el => el.remove());
    document.querySelectorAll('[data-xrb-circle], [data-xrb-profile-circle]').forEach(el => {
      delete el.dataset.xrbCircle;
      delete el.dataset.xrbProfileCircle;
    });
    document.querySelectorAll('article[data-testid="tweet"], article[role="article"]').forEach(el => {
      el.style.filter = '';
      el.style.opacity = '';
      el.style.display = '';
      el.style.pointerEvents = '';
      delete el.dataset.xrbDone;
      delete el.dataset.xrbQueued;
    });
  }

  // ── MutationObserver ───────────────────────────────────────────────────────

  function startObserver() {
    new MutationObserver(mutations => {
      const newArticles = [];
      let urlChanged = false;

      mutations.forEach(m => {
        m.addedNodes.forEach(node => {
          if (node.nodeType !== 1) return;
          if (node.matches?.('article[data-testid="tweet"], article[role="article"]')) newArticles.push(node);
          node.querySelectorAll?.('article[data-testid="tweet"], article[role="article"]').forEach(a => newArticles.push(a));
          if (node.matches?.('[role="dialog"]')) setTimeout(() => checkAboutPopup(node), 400);
        });
      });

      // Detect SPA navigation
      if (lastPath !== window.location.pathname) {
        lastPath = window.location.pathname;
        urlChanged = true;
        console.log('[XRB] Navigation to:', lastPath);
        // Remove profile treatments and re-check
        document.querySelectorAll('.xrb-profile-banner, .xrb-profile-no-symbol').forEach(el => el.remove());
        document.querySelectorAll('[data-xrb-profile-circle]').forEach(el => delete el.dataset.xrbProfileCircle);
        setTimeout(checkProfilePage, 800);
        setTimeout(scanAll, 300);
        setTimeout(scanAll, 1200);
      }

      if (newArticles.length) {
        clearTimeout(window._xrbObsTimer);
        window._xrbObsTimer = setTimeout(() => newArticles.forEach(processArticle), 150);
      }
    }).observe(document.body, { childList: true, subtree: true });

    lastPath = window.location.pathname;
  }

  // ── IntersectionObserver ───────────────────────────────────────────────────

  function startIntersectionObserver() {
    const io = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const art = entry.target;
          if (!art.dataset.xrbDone) processArticle(art);
        }
      });
    }, { rootMargin: '500px 0px', threshold: 0 });

    function observe() {
      document.querySelectorAll('article[data-testid="tweet"], article[role="article"]').forEach(art => {
        if (!art.dataset.xrbObserved) { art.dataset.xrbObserved = 'true'; io.observe(art); }
      });
    }
    observe();
    new MutationObserver(observe).observe(document.body, { childList: true, subtree: true });
  }

  // ── Interval scan ──────────────────────────────────────────────────────────
  // Every 2s: rescan DOM, re-queue missed users, resume queue after rate limit

  function startIntervalScan() {
    setInterval(() => {
      // Rescan for newly blocked users
      if (blockedUsernames.size > 0) rescanDOM();

      // Re-check profile page
      checkProfilePage();

      // Find articles that were queued but never got a result — re-queue them
      document.querySelectorAll('article[data-testid="tweet"][data-xrb-queued]:not([data-xrb-done])').forEach(art => {
        const username = getUsernameFromArticle(art);
        if (!username) return;
        if (!memCache.has(username) && !pendingUsernames.has(username)) {
          delete art.dataset.xrbQueued;
          queueLookup(username);
        }
      });

      // Resume queue if rate limit has lifted
      if (Date.now() >= rateLimitedUntil && lookupQueue.length > 0 && !queueRunning) {
        console.log('[XRB] Rate limit lifted, resuming queue of', lookupQueue.length);
        drainQueue();
      }
    }, 2000);
  }

  // ── About popup watcher ────────────────────────────────────────────────────

  function checkAboutPopup(root) {
    const text = root?.innerText || root?.textContent || '';
    const match = text.match(/[Aa]ccount\s+based\s+in\s+([^\n\r,<]{2,50})/);
    if (!match) return;
    const country = match[1].trim();
    if (!isBlocked(country)) return;
    console.log('[XRB] About popup detected:', country);
    const pageM = window.location.pathname.match(/^\/([A-Za-z0-9_]+)/);
    if (pageM && !SKIP.has(pageM[1].toLowerCase())) cacheResult(pageM[1].toLowerCase(), country);
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  init();

})();
