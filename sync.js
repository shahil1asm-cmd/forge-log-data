// sync.js
// Reads tagged Habitica Dailies/To Do's, converts completions into XP for
// five custom stats, and writes stats.json (public, for the mobile display)
// and state.json (private bookkeeping, so nothing gets double-counted).
//
// Run via GitHub Actions on a schedule. Needs Node 18+ (built-in fetch).
// Required env vars: HABITICA_USER_ID, HABITICA_API_TOKEN

const fs = require('fs');
const path = require('path');

const USER_ID = process.env.HABITICA_USER_ID;
const API_TOKEN = process.env.HABITICA_API_TOKEN;
const BASE = 'https://habitica.com/api/v3';
const STATE_PATH = path.join(__dirname, 'state.json');
const STATS_PATH = path.join(__dirname, 'stats.json');

const STAT_TAGS = ['vitality', 'strength', 'mentalAgility', 'focus', 'spiritualEssence'];

const DIFFICULTY_XP = { 0.1: 10, 1: 20, 1.5: 30, 2: 40 };

if (!USER_ID || !API_TOKEN) {
  console.error('Missing HABITICA_USER_ID or HABITICA_API_TOKEN env vars.');
  process.exit(1);
}

const headers = {
  'x-api-user': USER_ID,
  'x-api-key': API_TOKEN,
  'x-client': `${USER_ID}-ForgeLogSync`,
  'Content-Type': 'application/json',
};

async function habitica(pathSuffix, opts = {}) {
  const res = await fetch(`${BASE}${pathSuffix}`, { headers, ...opts });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Habitica API ${res.status} on ${pathSuffix}: ${body}`);
  }
  const json = await res.json();
  return json.data;
}

function xpNeeded(level) {
  return level * 50;
}

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function loadJSON(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function defaultState() {
  const stats = {};
  STAT_TAGS.forEach((id) => (stats[id] = { level: 1, xp: 0 }));
  return { stats, awardedDaily: {}, awardedTodo: {} };
}

async function ensureTags() {
  const existing = await habitica('/tags');
  const existingByName = {};
  existing.forEach((t) => (existingByName[t.name] = t.id));

  const result = {}; // only ever holds the 5 stat tags, never the user's other tags
  for (const name of STAT_TAGS) {
    if (existingByName[name]) {
      result[name] = existingByName[name];
    } else {
      const created = await habitica('/tags', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      result[name] = created.id;
      console.log(`Created missing tag: ${name}`);
    }
  }
  return result; // { vitality: 'tag-uuid', ... } — exactly 5 entries, always
}

function awardXP(state, statId, amount) {
  const st = state.stats[statId];
  st.xp += amount;
  let leveled = false;
  while (st.xp >= xpNeeded(st.level)) {
    st.xp -= xpNeeded(st.level);
    st.level += 1;
    leveled = true;
  }
  return leveled;
}

async function main() {
  const tagIds = await ensureTags();
  const idToStat = {};
  Object.entries(tagIds).forEach(([name, id]) => (idToStat[id] = name));

  const state = loadJSON(STATE_PATH, defaultState());
  // Backfill in case new stat tags were added after state.json was first created
  STAT_TAGS.forEach((id) => {
    if (!state.stats[id]) state.stats[id] = { level: 1, xp: 0 };
  });

  const today = todayStr();
  const tasks = await habitica('/tasks/user');

  let gains = [];

  for (const task of tasks) {
    const taggedStats = (task.tags || []).map((id) => idToStat[id]).filter(Boolean);
    if (taggedStats.length === 0) continue;

    const xp = DIFFICULTY_XP[task.priority] ?? 20;

    if (task.type === 'daily') {
      const already = state.awardedDaily[task.id] === today;
      if (task.completed && !already) {
        taggedStats.forEach((statId) => {
          const leveled = awardXP(state, statId, xp);
          gains.push(`${task.text} -> +${xp} ${statId}${leveled ? ' (LEVEL UP)' : ''}`);
        });
        state.awardedDaily[task.id] = today;
      }
    } else if (task.type === 'todo') {
      const already = !!state.awardedTodo[task.id];
      if (task.completed && !already) {
        taggedStats.forEach((statId) => {
          const leveled = awardXP(state, statId, xp);
          gains.push(`${task.text} -> +${xp} ${statId}${leveled ? ' (LEVEL UP)' : ''}`);
        });
        state.awardedTodo[task.id] = true;
      }
    }
  }

  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  fs.writeFileSync(
    STATS_PATH,
    JSON.stringify({ stats: state.stats, lastSynced: new Date().toISOString() }, null, 2)
  );

  if (gains.length) {
    console.log('Gains this run:\n' + gains.join('\n'));
  } else {
    console.log('No new tagged completions since last run.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
