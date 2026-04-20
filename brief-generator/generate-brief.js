#!/usr/bin/env node
/**
 * generate-brief.js — Génère /srv/brief/data.json pour brief.delaale.fr
 *
 * Sources :
 *   - Open-Meteo      (météo, public, aucune clé requise)
 *   - Todoist REST v2 (tâches du jour + en retard)
 *   - Notion API      (tâches Bayard + tâches Telemann)
 *
 * Variables d'environnement (chargées depuis ~/vps-stack/.env) :
 *   TODOIST_TOKEN            – token API Todoist (Settings > Integrations > API token)
 *   NOTION_TOKEN             – déjà utilisé par le script Telemann
 *   NOTION_BAYARD_TASKS_DB   – ID de la base de données Notion "Tâches Bayard"
 *   NOTION_TELEMANN_TASKS_DB – ID de la base de données Notion "Tâches Telemann"
 *   NOTION_PROP_NAME         – nom de la propriété "titre" dans Notion (défaut: "Nom")
 *   NOTION_PROP_STATUS       – nom de la propriété "statut"             (défaut: "Statut")
 *   NOTION_PROP_DUE          – nom de la propriété "échéance"           (défaut: "Échéance")
 *   BRIEF_OUTPUT_PATH        – chemin de sortie (défaut: /home/node/brief-output/data.json)
 */

const fs = require('fs');

// ── Configuration ──────────────────────────────────────────────────────────────

const TODOIST_TOKEN      = process.env.TODOIST_TOKEN;
const NOTION_TOKEN       = process.env.NOTION_TOKEN;
const NOTION_BAYARD_DB   = process.env.NOTION_BAYARD_TASKS_DB;
const NOTION_TELEMANN_DB = process.env.NOTION_TELEMANN_TASKS_DB;

const NOTION_PROP_NAME   = process.env.NOTION_PROP_NAME   || 'Nom';
const NOTION_PROP_STATUS = process.env.NOTION_PROP_STATUS || 'Statut';
const NOTION_PROP_DUE    = process.env.NOTION_PROP_DUE    || 'Échéance';

const OUTPUT_PATH = process.env.BRIEF_OUTPUT_PATH || '/home/node/brief-output/data.json';

// Coordonnées : La Garenne-Colombes
const LAT = 48.9034;
const LON = 2.2414;

// ── WMO codes ─────────────────────────────────────────────────────────────────

const WMO_ICON = {
  0:'☀️',1:'🌤',2:'⛅',3:'☁️',
  45:'🌫',48:'🌫',
  51:'🌦',53:'🌦',55:'🌧',
  61:'🌧',63:'🌧',65:'🌧',
  71:'🌨',73:'🌨',75:'❄️',
  80:'🌦',81:'🌧',82:'⛈',
  95:'⛈',96:'⛈',99:'⛈',
};
const WMO_DESC = {
  0:'Ciel clair',1:'Peu nuageux',2:'Partiellement nuageux',3:'Couvert',
  45:'Brouillard',48:'Brouillard givrant',
  51:'Bruine légère',53:'Bruine',55:'Bruine forte',
  61:'Pluie légère',63:'Pluie',65:'Pluie forte',
  71:'Neige légère',73:'Neige',75:'Neige forte',
  80:'Averses légères',81:'Averses',82:'Averses violentes',
  95:'Orage',96:'Orage avec grêle',99:'Orage fort',
};

// ── Météo (Open-Meteo) ────────────────────────────────────────────────────────

async function fetchWeather() {
  const params = new URLSearchParams({
    latitude:     LAT,
    longitude:    LON,
    hourly:       'temperature_2m,precipitation_probability,weathercode',
    current:      'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weathercode',
    forecast_days: 1,
    timezone:     'Europe/Paris',
  });

  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) throw new Error(`Open-Meteo: ${res.status}`);
  const d = await res.json();

  const cur = d.current;
  const current = {
    temp:        Math.round(cur.temperature_2m),
    feels_like:  Math.round(cur.apparent_temperature),
    humidity:    cur.relative_humidity_2m,
    wind_kmh:    Math.round(cur.wind_speed_10m),
    wmo_code:    cur.weathercode,
    description: WMO_DESC[cur.weathercode] ?? '',
  };

  // Créneaux horaires 8h–00h
  const SHOW_HOURS = [8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,0];
  const hours  = d.hourly.time.map(t => new Date(t).getHours());
  const temps  = d.hourly.temperature_2m;
  const rains  = d.hourly.precipitation_probability;
  const codes  = d.hourly.weathercode;

  const hourly = [];
  for (const h of SHOW_HOURS) {
    const idx = hours.indexOf(h);
    if (idx === -1) continue;
    hourly.push({
      hour:     h,
      icon:     WMO_ICON[codes[idx]] ?? '🌡',
      temp:     Math.round(temps[idx]),
      rain_pct: rains[idx] ?? 0,
      wmo_code: codes[idx],
    });
  }

  return { current, hourly };
}

// ── Todoist ───────────────────────────────────────────────────────────────────

async function fetchTodoist() {
  const headers = { Authorization: `Bearer ${TODOIST_TOKEN}` };

  // On récupère toutes les tâches actives et on filtre côté script
  // (le paramètre filter=today nécessite un compte premium Todoist)
  const res = await fetch('https://api.todoist.com/rest/v2/tasks', { headers });
  if (!res.ok) throw new Error(`Todoist: ${res.status}`);

  const tasks = await res.json();
  const today = new Date().toISOString().split('T')[0];

  return tasks
    .filter(t => t.due?.date && t.due.date <= today)
    .map(t => ({
      name:     t.content,
      priority: t.priority, // 4=P1 (highest), 3=P2, 2=P3, 1=P4 (none)
      due:      t.due.date,
      overdue:  t.due.date < today,
    }))
    .sort((a, b) => {
      // Tâches en retard d'abord, puis par priorité décroissante
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      return b.priority - a.priority;
    });
}

// ── Notion ────────────────────────────────────────────────────────────────────

async function fetchNotionTasks(databaseId) {
  const today = new Date().toISOString().split('T')[0];

  // Filtre : échéance <= aujourd'hui OU pas de date
  const notionHeaders = {
    Authorization:    `Bearer ${NOTION_TOKEN}`,
    'Notion-Version': '2022-06-28',
    'Content-Type':   'application/json',
  };

  const filter = {
    or: [
      { property: NOTION_PROP_DUE, date: { on_or_before: today } },
      { property: NOTION_PROP_DUE, date: { is_empty: true } },
    ],
  };

  // Tentative avec tri par date d'échéance
  let res = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
    method: 'POST',
    headers: notionHeaders,
    body: JSON.stringify({
      filter,
      sorts: [{ property: NOTION_PROP_DUE, direction: 'ascending' }],
    }),
  });

  // Si le tri échoue (propriété introuvable), on réessaie sans tri
  if (!res.ok) {
    const errText = await res.text();
    if (res.status === 400 && errText.includes('sort property')) {
      res = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
        method: 'POST',
        headers: notionHeaders,
        body: JSON.stringify({ filter }),
      });
    }
    if (!res.ok) {
      const err = res.bodyUsed ? errText : await res.text();
      throw new Error(`Notion DB ${databaseId}: ${res.status} ${err.slice(0, 200)}`);
    }
  }

  const data = await res.json();

  // Noms de statuts considérés "terminé" (on exclut ces tâches)
  const DONE_STATUSES = new Set([
    'done','terminé','terminée','completed','fermé','fermée','closed','archivé',
  ]);

  return data.results
    .map(page => {
      const props = page.properties;

      // Titre (toujours une property de type "title")
      const titleProp = props[NOTION_PROP_NAME] ?? Object.values(props).find(p => p.type === 'title');
      const name = titleProp?.title?.map(t => t.plain_text).join('') ?? '(sans titre)';

      // Statut (type "status" ou "select")
      const statusProp = props[NOTION_PROP_STATUS];
      const status = statusProp?.status?.name ?? statusProp?.select?.name ?? null;

      // Échéance
      const dueProp = props[NOTION_PROP_DUE];
      const due = dueProp?.date?.start ?? null;

      const overdue = due ? due < today : false;

      return { name, status, due, overdue };
    })
    .filter(t => !DONE_STATUSES.has((t.status ?? '').toLowerCase()));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Vérification des variables requises
  const missing = [];
  if (!TODOIST_TOKEN)      missing.push('TODOIST_TOKEN');
  if (!NOTION_TOKEN)       missing.push('NOTION_TOKEN');
  if (!NOTION_BAYARD_DB)   missing.push('NOTION_BAYARD_TASKS_DB');
  if (!NOTION_TELEMANN_DB) missing.push('NOTION_TELEMANN_TASKS_DB');

  if (missing.length) {
    console.log(JSON.stringify({ ok: false, error: `Variables manquantes : ${missing.join(', ')}` }));
    process.exit(1);
  }

  // Appels parallèles — chaque source est indépendante
  const [weather, todoist, bayard, telemann] = await Promise.allSettled([
    fetchWeather(),
    fetchTodoist(),
    fetchNotionTasks(NOTION_BAYARD_DB),
    fetchNotionTasks(NOTION_TELEMANN_DB),
  ]);

  const warnings = [];
  if (weather.status  === 'rejected') warnings.push('Météo: '   + weather.reason?.message);
  if (todoist.status  === 'rejected') warnings.push('Todoist: ' + todoist.reason?.message);
  if (bayard.status   === 'rejected') warnings.push('Bayard: '  + bayard.reason?.message);
  if (telemann.status === 'rejected') warnings.push('Telemann: '+ telemann.reason?.message);

  const data = {
    generated_at: new Date().toISOString(),
    weather:      weather.status  === 'fulfilled' ? weather.value  : null,
    tasks: {
      todoist:  todoist.status  === 'fulfilled' ? todoist.value  : [],
      bayard:   bayard.status   === 'fulfilled' ? bayard.value   : [],
      telemann: telemann.status === 'fulfilled' ? telemann.value : [],
    },
    // Emails et agenda remplis plus tard (Gmail + Google Calendar via n8n)
    emails: [],
    agenda: [],
  };

  // Écriture du fichier
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(data, null, 2), 'utf-8');

  const result = {
    ok: true,
    generated_at: data.generated_at,
    tasks: {
      todoist:  data.tasks.todoist.length,
      bayard:   data.tasks.bayard.length,
      telemann: data.tasks.telemann.length,
    },
    weather: data.weather ? 'ok' : 'error',
  };
  if (warnings.length) result.warnings = warnings;

  console.log(JSON.stringify(result));
}

main().catch(err => {
  console.log(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
