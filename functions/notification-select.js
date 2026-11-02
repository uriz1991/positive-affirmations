// Shared by the page, the service worker, and Cloud Functions.
// Functions deploy only the functions/ folder, so scripts/build-notification-pool.js
// copies this file to functions/notification-select.js. Edit this copy.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NotificationSelect = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const HISTORY_LIMIT = 40;
  const PERSONAL_RATE = 0.125;

  function stableId(prefix, text) {
    let h = 2166136261;
    const s = prefix + '\n' + String(text || '');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return prefix + (h >>> 0).toString(36);
  }

  function appendHistory(history, id, limit) {
    const cap = limit || HISTORY_LIMIT;
    const next = (Array.isArray(history) ? history : []).filter((item) => item && item !== id);
    next.push(id);
    return next.slice(-cap);
  }

  function slotForReminder(reminder) {
    const id = String((reminder && reminder.id) || '');
    const label = String((reminder && reminder.label) || '');
    if (/morning/.test(id) || /בוקר/.test(id) || /בוקר/.test(label)) return 'morning';
    if (/noon/.test(id) || /צהר/.test(id) || /צהר/.test(label)) return 'noon';
    if (/evening/.test(id) || /ערב/.test(id) || /ערב/.test(label)) return 'evening';
    const hour = Number(String((reminder && reminder.time) || '').split(':')[0]);
    if (!Number.isFinite(hour)) return 'morning';
    if (hour >= 5 && hour < 11) return 'morning';
    if (hour >= 11 && hour < 17) return 'noon';
    return 'evening';
  }

  function textFor(item, addressForm) {
    if (!item) return '';
    if (addressForm === 'f' && item.textF) return item.textF;
    return item.text || '';
  }

  // Local reminders stay on unless this device's token was saved on the
  // signed-in user's server document. A token that only lives in the
  // browser belongs to a guest or a signed-out session, and the server
  // will not send anything for them.
  function shouldSkipLocalReminders(state) {
    const signedIn = !!(state && state.signedIn);
    const currentUid = state && state.currentUid;
    const serverUid = state && state.serverUid;
    return !!(signedIn && currentUid && serverUid && serverUid === currentUid);
  }

  const HEBREW_RE = /[\u0590-\u05FF]/;

  function containsHebrew(text) {
    return HEBREW_RE.test(String(text || ''));
  }

  // English, French, and Spanish have no separate step pool. Build morning
  // and noon from the localized affirmations, and use the translated journal
  // question in the evening. Hebrew lines are dropped so a non-Hebrew UI
  // never shows them.
  function buildLocalizedPool(affirmations, eveningText) {
    const items = [];
    (affirmations || []).forEach((row) => {
      const text = row && typeof row.text === 'string' ? row.text.trim() : '';
      if (!text || containsHebrew(text)) return;
      items.push({
        id: stableId('m', text),
        slot: 'morning',
        kind: 'affirmation',
        text,
        textF: text
      });
      items.push({
        id: stableId('n', text),
        slot: 'noon',
        kind: 'affirmation',
        text,
        textF: text
      });
    });
    const evening = typeof eveningText === 'string' ? eveningText.trim() : '';
    if (evening && !containsHebrew(evening)) {
      items.push({
        id: stableId('e', evening),
        slot: 'evening',
        kind: 'question',
        text: evening,
        textF: evening
      });
    }
    return items;
  }

  function personalTextsForLanguage(texts, lang) {
    const list = (texts || []).filter((text) => typeof text === 'string' && text.trim());
    if (lang === 'he') return list.map((text) => text.trim());
    return list.map((text) => text.trim()).filter((text) => !containsHebrew(text));
  }

  function favoriteStorageKey(item) {
    if (!item) return '';
    if (item.id) return item.id;
    return item.text || '';
  }

  function isFavoriteEntry(favorites, item) {
    if (!item || !Array.isArray(favorites)) return false;
    if (item.id && favorites.includes(item.id)) return true;
    if (item.text && favorites.includes(item.text)) return true;
    if (item.textF && favorites.includes(item.textF)) return true;
    return false;
  }

  function withoutFavorite(favorites, item) {
    const drop = new Set([item && item.id, item && item.text, item && item.textF].filter(Boolean));
    return (Array.isArray(favorites) ? favorites : []).filter((entry) => !drop.has(entry));
  }

  function isBareFavoriteId(entry) {
    return typeof entry === 'string' && /^a[0-9a-z]{4,12}$/.test(entry);
  }

  function findFavorite(entry, affirmations) {
    const list = Array.isArray(affirmations) ? affirmations : [];
    return list.find((item) => item && item.id === entry)
      || list.find((item) => item && (item.text === entry || item.textF === entry))
      || null;
  }

  // addressForm picks text or textF. fallbackAffirmations is the Hebrew
  // catalog, used when the current UI language does not contain that id.
  // An id that still cannot be resolved is omitted so export does not show
  // a raw key such as "asmdeaj". A legacy sentence stored as text is kept.
  function favoriteDisplayText(entry, affirmations, addressForm, options) {
    const fallback = options && options.fallbackAffirmations;
    const match = findFavorite(entry, affirmations) || findFavorite(entry, fallback);
    if (!match) return isBareFavoriteId(entry) ? '' : entry;
    return textFor(match, addressForm);
  }

  // Firestore map keys cannot contain dots or slashes, and FCM tokens do.
  function tokenFieldKey(token) {
    return stableId('t', token);
  }

  // Per-token time wins. The old user-level fcmTokenBoundAt is only a
  // fallback for an account that still has exactly one token, so opening
  // the app on a laptop cannot refresh a phone token that belongs to
  // someone else.
  function tokenBoundScore(user, token) {
    const map = user && user.fcmTokenBound;
    if (map && typeof map === 'object') {
      const specific = Number(map[tokenFieldKey(token)]);
      if (Number.isFinite(specific) && specific > 0) return specific;
    }
    const tokens = (user && user.fcmTokens) || [];
    if (tokens.length === 1 && tokens[0] === token) {
      const legacy = Number(user && user.fcmTokenBoundAt);
      if (Number.isFinite(legacy) && legacy > 0) return legacy;
    }
    return 0;
  }

  // One device token can linger on an older account after someone else signs
  // in on that phone. The newest per-token time owns it. A tie goes to the
  // greater uid so the choice does not depend on document order.
  function assignTokenOwners(users) {
    const tokenOwner = new Map();
    (users || []).forEach((user) => {
      if (!user || !user.uid) return;
      (user.fcmTokens || []).forEach((token) => {
        if (!token) return;
        const score = tokenBoundScore(user, token);
        const current = tokenOwner.get(token);
        if (!current || score > current.bound || (score === current.bound && String(user.uid) > current.uid)) {
          tokenOwner.set(token, { uid: String(user.uid), bound: score });
        }
      });
    });
    return tokenOwner;
  }

  const FCM_TOKEN_LIMIT = 20;

  // The rules reject a list longer than 20. Drop the oldest bound tokens
  // (array order breaks ties) so the new token still fits.
  function fcmTokensForSave(existingTokens, boundMap, newToken, limit) {
    const cap = limit || FCM_TOKEN_LIMIT;
    const existing = (Array.isArray(existingTokens) ? existingTokens : [])
      .filter((token) => typeof token === 'string' && token);
    if (!newToken || typeof newToken !== 'string') return existing.slice(0, cap);
    if (existing.indexOf(newToken) !== -1) {
      return existing.length > cap ? newestTokens(existing, boundMap, cap) : existing.slice();
    }
    const kept = existing.length >= cap ? newestTokens(existing, boundMap, cap - 1) : existing.slice();
    kept.push(newToken);
    return kept;
  }

  function newestTokens(tokens, boundMap, keep) {
    const user = { fcmTokens: tokens, fcmTokenBound: boundMap || {} };
    const ranked = tokens.map((token, index) => ({
      token,
      index,
      score: tokenBoundScore(user, token)
    }));
    ranked.sort((a, b) => b.score - a.score || a.index - b.index);
    const chosen = new Set(ranked.slice(0, keep).map((row) => row.token));
    return tokens.filter((token) => chosen.has(token));
  }

  function tokensForUser(user, tokenOwner) {
    const owned = [];
    const stale = [];
    const uid = user && user.uid ? String(user.uid) : '';
    (user && user.fcmTokens || []).forEach((token) => {
      if (!token) return;
      const owner = tokenOwner && tokenOwner.get(token);
      if (owner && owner.uid !== uid) stale.push(token);
      else owned.push(token);
    });
    return { owned, stale };
  }

  function pickFromPool(options) {
    const pool = (options && options.pool) || [];
    const slot = (options && options.slot) || 'morning';
    const history = Array.isArray(options && options.history) ? options.history : [];
    const addressForm = options && options.addressForm === 'f' ? 'f' : 'm';
    const personalTexts = Array.isArray(options && options.personalTexts) ? options.personalTexts : [];
    const random = (options && options.random) || Math.random;
    const historyLimit = (options && options.historyLimit) || HISTORY_LIMIT;
    const personalRate = options && typeof options.personalRate === 'number' ? options.personalRate : PERSONAL_RATE;

    const recent = history.slice(-historyLimit);
    const recentSet = new Set(recent);
    const personals = personalTexts
      .filter((text) => typeof text === 'string' && text.trim())
      .map((text) => {
        const trimmed = text.trim();
        return { id: stableId('p', trimmed), text: trimmed, textF: trimmed, slot: 'personal', kind: 'personal' };
      });

    let choice = null;
    let via = slot;

    if (personals.length && random() < personalRate) {
      const freshPersonal = personals.filter((item) => !recentSet.has(item.id));
      const bag = freshPersonal.length ? freshPersonal : personals;
      choice = bag[Math.floor(random() * bag.length)];
      via = 'personal';
    } else {
      const candidates = pool.filter((item) => item && item.slot === slot && item.id && item.text);
      const fresh = candidates.filter((item) => !recentSet.has(item.id));
      if (fresh.length) {
        choice = fresh[Math.floor(random() * fresh.length)];
      } else if (candidates.length) {
        const index = new Map(recent.map((id, i) => [id, i]));
        const sorted = candidates.slice().sort((a, b) => (index.get(a.id) ?? -1) - (index.get(b.id) ?? -1));
        choice = sorted[0];
      }
    }

    if (!choice) return null;
    return {
      id: choice.id,
      text: textFor(choice, addressForm),
      slot: via,
      kind: choice.kind || via,
      history: appendHistory(history, choice.id, historyLimit)
    };
  }

  return {
    HISTORY_LIMIT,
    PERSONAL_RATE,
    stableId,
    appendHistory,
    slotForReminder,
    pickFromPool,
    textFor,
    shouldSkipLocalReminders,
    containsHebrew,
    buildLocalizedPool,
    personalTextsForLanguage,
    favoriteStorageKey,
    isFavoriteEntry,
    withoutFavorite,
    favoriteDisplayText,
    assignTokenOwners,
    tokensForUser,
    fcmTokensForSave,
    FCM_TOKEN_LIMIT,
    tokenFieldKey,
    tokenBoundScore,
    isBareFavoriteId
  };
});
