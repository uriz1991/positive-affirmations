// Popular-list and Gemini style examples may only use catalog lines.
// A favorite stored as a catalog id resolves to that line's text.
// A legacy favorite stored as the exact catalog sentence (or its textF)
// is kept. Anything else — a personal affirmation, an AI-coach line, or
// text someone typed into the favorites array — is dropped.
const index = require('./catalog-index.json');

function catalogDisplayText(entry) {
  if (typeof entry !== 'string') return null;
  const value = entry.trim();
  if (!value) return null;
  if (Object.prototype.hasOwnProperty.call(index.byId, value)) return index.byId[value];
  if (Object.prototype.hasOwnProperty.call(index.texts, value)) return value;
  return null;
}

function countCatalogFavorites(favoriteLists) {
  const counts = new Map();
  (favoriteLists || []).forEach((favorites) => {
    if (!Array.isArray(favorites)) return;
    const seen = new Set();
    favorites.forEach((entry) => {
      const text = catalogDisplayText(entry);
      if (!text || seen.has(text)) return;
      seen.add(text);
      counts.set(text, (counts.get(text) || 0) + 1);
    });
  });
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, 50)
    .map(([text, count]) => ({ text, count }));
}

// Re-check a stored popular list before it is pasted into a Gemini prompt,
// so a document written before this filter cannot leak personal text.
function catalogTextsForPrompt(top, limit) {
  const cap = limit || 8;
  const out = [];
  (top || []).forEach((row) => {
    if (!row || out.length >= cap) return;
    const text = catalogDisplayText(row.text) || (row.id ? catalogDisplayText(row.id) : null);
    if (!text || out.includes(text)) return;
    out.push(text);
  });
  return out;
}

module.exports = {
  catalogDisplayText,
  countCatalogFavorites,
  catalogTextsForPrompt
};
