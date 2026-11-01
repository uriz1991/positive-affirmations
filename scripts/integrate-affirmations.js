#!/usr/bin/env node
// Merges the approved wealth-additions file into data/affirmations.json,
// adds female forms for existing Hebrew lines, and writes the shared
// notification pool used by the client and by Cloud Functions.
const fs = require('fs');
const path = require('path');
const { stableId } = require('../shared/notification-select');

const ROOT = path.join(__dirname, '..');
const SOURCE = process.argv[2] || path.join(__dirname, 'sources', 'wealth-additions-gendered.json');
const AFF_PATH = path.join(ROOT, 'data', 'affirmations.json');

const TOKEN = {
  מאמין: 'מאמינה',
  ראוי: 'ראויה',
  מסוגל: 'מסוגלת',
  בוחר: 'בוחרת',
  חזק: 'חזקה',
  חושב: 'חושבת',
  נותן: 'נותנת',
  אומר: 'אומרת',
  עומד: 'עומדת',
  איתן: 'איתנה',
  הופך: 'הופכת',
  פועל: 'פועלת',
  פתוח: 'פתוחה',
  עובד: 'עובדת',
  מושך: 'מושכת',
  מגדיר: 'מגדירה',
  חוגג: 'חוגגת',
  אוהב: 'אוהבת',
  סולח: 'סולחת',
  מדבר: 'מדברת',
  מתייחס: 'מתייחסת',
  מקבל: 'מקבלת',
  מסתכל: 'מסתכלת',
  מתקדם: 'מתקדמת',
  מתאים: 'מתאימה',
  גמיש: 'גמישה',
  מפחד: 'מפחדת',
  סקרן: 'סקרנית',
  נושם: 'נושמת',
  מוציא: 'מוציאה',
  מגיב: 'מגיבה',
  נוכח: 'נוכחת',
  אסיר: 'אסירת',
  מכיר: 'מכירה',
  מוצא: 'מוצאת',
  מעריך: 'מעריכה',
  מפנק: 'מפנקת',
  מקדיש: 'מקדישה',
  תומך: 'תומכת',
  יוצר: 'יוצרת',
  מקשיב: 'מקשיבה',
  בריא: 'בריאה',
  מחוטב: 'מחוטבת',
  יוצא: 'יוצאת',
  גר: 'גרה',
  רגוע: 'רגועה',
  נינוח: 'נינוחה',
  פורש: 'פורשת',
  מצליח: 'מצליחה',
  משגשג: 'משגשגת',
  מאפשר: 'מאפשרת',
  צועד: 'צועדת',
  מדמיין: 'מדמיינת',
  מוותר: 'מוותרת',
  מתקרב: 'מתקרבת',
  יכול: 'יכולה',
  צריך: 'צריכה',
  יודע: 'יודעת',
  מבין: 'מבינה',
  סומך: 'סומכת',
  משחרר: 'משחררת',
  נרגע: 'נרגעת',
  מניח: 'מניחה',
  חי: 'חיה',
  מובל: 'מובלת',
  מוקף: 'מוקפת',
  מזמין: 'מזמינה',
  מנהל: 'מנהלת',
  מייצר: 'מייצרת',
  לוקח: 'לוקחת',
  בוטח: 'בוטחת',
  מרוויח: 'מרוויחה',
  שולט: 'שולטת',
  פותח: 'פותחת',
  מקרין: 'מקרינה',
  משדר: 'משדרת',
  שם: 'שמה',
  שלם: 'שלמה',
  טוב: 'טובה',
  שואף: 'שואפת',
  מתחיל: 'מתחילה'
};

const TRIGGERS = new Set([
  'אני', 'ואני', 'שאני', 'כשאני', 'וכשאני', 'ושאני',
  'איני', 'שאיני', 'ואיני',
  'הייתי', 'שהייתי',
  'להיות'
]);

const CONNECTORS = new Set([
  'לא', 'גם', 'יותר', 'מאוד', 'כל', 'כך', 'מדי', 'הכי', 'בדיוק',
  'עדיין', 'תמיד', 'כבר', 'רק', 'מספיק', 'עוד', 'שוב'
]);

function bare(token) {
  return token.replace(/^[^\u0590-\u05FF]+/, '').replace(/[^\u0590-\u05FF]+$/, '');
}

function feminize(text) {
  let value = text;
  value = value.replace(
    'אני מסתכל במראה ורואה מישהו ששווה להיאהב',
    'אני מסתכלת במראה ורואה מישהי ששווה להיאהב'
  );
  value = value.replace('אני בעלים של עסק', 'אני בעלת עסק');
  // Coordinated "אני … ו־verb" where a noun in between breaks the token chain.
  value = value.replace('ונותן לאמונה להוביל', 'ונותנת לאמונה להוביל');
  value = value.replace('ומוציא החוצה', 'ומוציאה החוצה');
  value = value.replace('ופותח דף חדש', 'ופותחת דף חדש');
  value = value.replace('ומנהל את זמני', 'ומנהלת את זמני');

  const parts = value.split(/(\s+)/);
  let speaker = false;
  for (let i = 0; i < parts.length; i++) {
    if (/^\s+$/.test(parts[i])) continue;
    const word = bare(parts[i]);
    if (TRIGGERS.has(word)) {
      speaker = true;
      continue;
    }
    if (!speaker) continue;
    if (CONNECTORS.has(word)) continue;

    const match = parts[i].match(/^([^\u0590-\u05FF]*)(\u05D5?)([\u0590-\u05FF]+)([^\u0590-\u05FF]*)$/);
    if (!match) {
      speaker = false;
      continue;
    }
    let vav = match[2];
    let core = match[3];
    if (vav && !TOKEN[core] && TOKEN[vav + core]) {
      core = vav + core;
      vav = '';
    }
    if (!TOKEN[core]) {
      speaker = false;
      continue;
    }
    parts[i] = match[1] + vav + TOKEN[core] + match[4];
  }
  return parts.join('');
}

function isActionOriented(text) {
  return /^(לכתוב|לבחור|לשלוח|לקרוא|להעביר|לרשום|לקבל|לשריין|לעשות|לספר|להתחיל|להציע)/.test(text)
    || /(אעשה|אבחר|אפעל|אתחיל|אשאל|אכוון|אבנה|אזהה|אברך|אצור|אספר|אציע|אגדל|אשקיע|אמדוד|אסתכל|אפריש|אלמד|אבדוק|אתמיד|אמשיך|אפקיד|אחלום|אעזור|אקח|אקבל|אברח|אתמודד)/.test(text)
    || /היום א/.test(text)
    || /צעד/.test(text)
    || /פעולה/.test(text)
    || /לפעול/.test(text);
}

function item(text, textF, category, step, stepF) {
  const row = {
    id: stableId('a', text),
    text,
    textF: textF || text,
    category
  };
  if (step) {
    row.todayStep = step;
    row.todayStepF = stepF || step;
  }
  return row;
}

function main() {
  const current = JSON.parse(fs.readFileSync(AFF_PATH, 'utf8'));
  const approved = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
  const principles = new Map(approved.principles.map((p) => [p.id, p]));
  const stepByText = new Map();
  for (const principle of approved.principles) {
    for (const line of principle.affirmations) {
      stepByText.set(line, principle);
    }
  }

  const drop = new Set(approved.wealthReview.drop.map((row) => row.text));
  const rewriteByOld = new Map(approved.wealthReview.rewrite.map((row) => [row.old, row]));
  const keepByText = new Map(approved.wealthReview.keep.map((row) => [row.text, row]));

  let dropped = 0;
  let rewritten = 0;
  let keptTagged = 0;
  const missing = [];

  const next = [];
  for (const row of current.affirmations) {
    if (drop.has(row.text)) {
      dropped++;
      drop.delete(row.text);
      continue;
    }
    if (rewriteByOld.has(row.text)) {
      const change = rewriteByOld.get(row.text);
      const principle = principles.get(change.principle);
      next.push(item(
        change.new,
        change.newF || change.new,
        row.category,
        principle && principle.todayStep,
        principle && principle.todayStepF
      ));
      rewritten++;
      rewriteByOld.delete(row.text);
      continue;
    }
    const keep = keepByText.get(row.text);
    if (keep) {
      next.push(item(keep.text, keep.textF || keep.text, row.category));
      keptTagged++;
      keepByText.delete(row.text);
      continue;
    }
    const textF = (row.category === 'torah' || row.category === 'nachman')
      ? row.text
      : feminize(row.text);
    next.push(item(row.text, textF, row.category));
  }

  if (drop.size || rewriteByOld.size || keepByText.size) {
    for (const text of drop) missing.push('drop not found: ' + text);
    for (const text of rewriteByOld.keys()) missing.push('rewrite not found: ' + text);
    for (const text of keepByText.keys()) missing.push('keep not found: ' + text);
    throw new Error(missing.join('\n'));
  }

  const have = new Set(next.map((row) => row.text));
  let added = 0;
  for (const row of approved.affirmations) {
    if (have.has(row.text)) continue;
    const principle = stepByText.get(row.text);
    const built = item(
      row.text,
      row.textF || row.text,
      row.category,
      principle && principle.todayStep,
      principle && principle.todayStepF
    );
    let insertAt = next.length;
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i].category === row.category) {
        insertAt = i + 1;
        break;
      }
    }
    next.splice(insertAt, 0, built);
    have.add(row.text);
    added++;
  }

  const gendered = next.filter((row) => row.textF !== row.text);
  const withStep = next.filter((row) => row.todayStep);

  const output = {
    categories: current.categories,
    affirmations: next
  };
  fs.writeFileSync(AFF_PATH, JSON.stringify(output, null, 2) + '\n');

  const pool = [];
  const seenSteps = new Set();
  for (const row of next) {
    if (isActionOriented(row.text)) {
      pool.push({
        id: stableId('m', row.text),
        slot: 'morning',
        kind: 'affirmation',
        text: row.text,
        textF: row.textF || row.text
      });
    }
    if (row.todayStep && !seenSteps.has(row.todayStep)) {
      seenSteps.add(row.todayStep);
      pool.push({
        id: stableId('n', row.todayStep),
        slot: 'noon',
        kind: 'step',
        text: row.todayStep,
        textF: row.todayStepF || row.todayStep
      });
    }
  }
  const question = approved.journal.journalDescRecommended;
  const questionF = approved.journal.journalDescRecommendedF || question;
  pool.push({
    id: stableId('e', question),
    slot: 'evening',
    kind: 'question',
    text: question,
    textF: questionF
  });

  const poolDoc = { version: 1, items: pool };
  const poolJson = JSON.stringify(poolDoc, null, 2) + '\n';
  fs.writeFileSync(path.join(ROOT, 'data', 'notification-pool.json'), poolJson);
  fs.writeFileSync(path.join(ROOT, 'functions', 'notification-pool.json'), poolJson);
  fs.copyFileSync(
    path.join(ROOT, 'shared', 'notification-select.js'),
    path.join(ROOT, 'functions', 'notification-select.js')
  );

  const bySlot = pool.reduce((acc, row) => {
    acc[row.slot] = (acc[row.slot] || 0) + 1;
    return acc;
  }, {});
  console.log(JSON.stringify({
    before: current.affirmations.length,
    after: next.length,
    dropped,
    rewritten,
    keptTagged,
    added,
    gendered: gendered.length,
    withStep: withStep.length,
    quotesLeftAsIs: next.filter((row) => (row.category === 'torah' || row.category === 'nachman')).length,
    pool: bySlot
  }, null, 2));
  const SUSPECT = [
  'מאמין', 'ראוי', 'מסוגל', 'בוחר', 'חזק', 'חושב', 'נותן', 'אומר', 'עומד', 'איתן',
  'הופך', 'פועל', 'פתוח', 'עובד', 'מושך', 'מגדיר', 'חוגג', 'אוהב', 'סולח', 'מדבר',
  'מתייחס', 'מקבל', 'מסתכל', 'מתקדם', 'מתאים', 'גמיש', 'מפחד', 'סקרן', 'נושם',
  'מוציא', 'מגיב', 'אסיר', 'מכיר', 'מוצא', 'מעריך', 'מפנק', 'מקדיש', 'תומך',
  'יוצר', 'מקשיב', 'בריא', 'מחוטב', 'יוצא', 'רגוע', 'נינוח', 'פורש', 'מצליח',
  'משגשג', 'מאפשר', 'צועד', 'מדמיין', 'מוותר', 'מתקרב', 'יכול', 'צריך', 'יודע',
  'מבין', 'סומך', 'משחרר', 'נרגע', 'מניח', 'מובל', 'מוקף', 'מזמין', 'מנהל',
  'מייצר', 'לוקח', 'בוטח', 'מרוויח', 'שולט', 'פותח', 'מקרין', 'משדר', 'שואף', 'מתחיל'
];
const unchangedSuspects = next.filter((row) => {
  if (row.category === 'torah' || row.category === 'nachman') return false;
  if (row.textF !== row.text) return false;
  return SUSPECT.some((word) => row.text.includes(word));
});
console.log('\n--- unchanged but still contain a masculine token (review) ---');
for (const row of unchangedSuspects) console.log('[' + row.category + '] ' + row.text);

console.log('\n--- female forms that differ ---');
  for (const row of gendered) {
    console.log('[' + row.category + '] ' + row.text);
    console.log('    → ' + row.textF);
  }
}

main();
