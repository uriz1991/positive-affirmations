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
    textFor
  };
});
