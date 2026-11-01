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

  function favoriteDisplayText(entry, affirmations, addressForm) {
    const list = Array.isArray(affirmations) ? affirmations : [];
    const match = list.find((item) => item && item.id === entry)
      || list.find((item) => item && (item.text === entry || item.textF === entry));
    if (!match) return entry;
    return textFor(match, addressForm);
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
    favoriteDisplayText
  };
});
