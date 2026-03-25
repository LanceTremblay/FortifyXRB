// FortifyXRB (X Region Blocker) v1.0 - MAIN World Injector
// Runs at document_start in the page's JS context
// Passively captures AboutAccountQuery and timeline responses
// that X's own app makes, extracting country data for free

(function () {
  'use strict';

  // Shared channel between MAIN world and content script
  const CHANNEL = '__xrb_data__';

  function emit(type, payload) {
    window.dispatchEvent(new CustomEvent(CHANNEL, { detail: { type, payload } }));
  }

  // ── Monkey-patch fetch ──────────────────────────────────────────────────────
  // Note: non-JSON responses (blobs, streams) are silently ignored via .catch()

  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await _fetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      if (isGraphQL(url)) {
        res.clone().json().then(data => handleJSON(url, data)).catch(() => {});
      }
    } catch (_) {}
    return res;
  };

  // ── Monkey-patch XHR ───────────────────────────────────────────────────────
  // Use a wrapper that returns the real XHR instance so that instanceof checks
  // against XMLHttpRequest.prototype inside X's own code continue to work

  const OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function (...args) {
    const xhr = new OrigXHR(...args);
    let _url = '';
    const _open = xhr.open.bind(xhr);
    xhr.open = function (m, u, ...rest) { _url = u; return _open(m, u, ...rest); };
    xhr.addEventListener('load', function () {
      try {
        if (isGraphQL(_url) && xhr.responseText) {
          handleJSON(_url, JSON.parse(xhr.responseText));
        }
      } catch (_) {}
    });
    return xhr;
  };
  // Preserve prototype so instanceof XMLHttpRequest checks still pass
  Object.defineProperty(window.XMLHttpRequest, 'prototype', {
    get: () => OrigXHR.prototype
  });

  // ── URL filter ─────────────────────────────────────────────────────────────

  function isGraphQL(url) {
    return url && (url.includes('/i/api/graphql/') || url.includes('api.x.com/graphql/'));
  }

  // ── JSON parser — extract user + country data ──────────────────────────────

  function handleJSON(url, data) {
    if (!data || typeof data !== 'object') return;

    // AboutAccountQuery response — direct country data
    if (url.includes('AboutAccountQuery')) {
      const result = data?.data?.user_result_by_screen_name?.result;
      if (result) {
        const screenName = result?.legacy?.screen_name || result?.core?.name;
        const country    = result?.about_profile?.account_based_in || '';
        if (screenName && country) {
          emit('about_country', { username: screenName.toLowerCase(), country });
          console.log('[XRB-INJECT] AboutAccountQuery:', screenName, '->', country);
        }
      }
      return;
    }

    // Timeline / UserByScreenName — extract all user legacy.location fields
    // Use a per-response seen set to avoid emitting the same username multiple
    // times when the same user appears in multiple tweets on the timeline
    const seen = new Set();
    walkForUsers(data, 0, seen);
  }

  // Depth limit of 20 to handle deeply nested GraphQL shapes:
  // timeline → entries → content → itemContent → tweet → core → user_results → result → legacy
  function walkForUsers(obj, depth, seen) {
    if (!obj || typeof obj !== 'object' || depth > 20) return;

    if (obj.rest_id && obj.legacy?.screen_name) {
      const username = obj.legacy.screen_name.toLowerCase();
      if (!seen.has(username)) {
        seen.add(username);
        const location = obj.legacy.location || '';
        emit('legacy_location', { username, location });
      }
    }

    if (Array.isArray(obj)) {
      for (const item of obj) walkForUsers(item, depth + 1, seen);
    } else {
      for (const val of Object.values(obj)) {
        if (val && typeof val === 'object') walkForUsers(val, depth + 1, seen);
      }
    }
  }

  console.log('[XRB-INJECT] v1.0 fetch+XHR interceptors installed');

})();
