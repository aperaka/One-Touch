const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const root = __dirname;

const feeds = {
  Soccer: [
    'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/scoreboard'
  ],
  Basketball: ['https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard'],
  Football: ['https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard'],
  Baseball: ['https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard'],
  Tennis: [
    'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/tennis/wta/scoreboard'
  ]
};

const playerSources = {
  Soccer: [
    { label: 'Premier League', sport: 'soccer', league: 'eng.1', mode: 'teams' },
    { label: 'La Liga', sport: 'soccer', league: 'esp.1', mode: 'teams' },
    { label: 'Serie A', sport: 'soccer', league: 'ita.1', mode: 'teams' },
    { label: 'Bundesliga', sport: 'soccer', league: 'ger.1', mode: 'teams' },
    { label: 'Ligue 1', sport: 'soccer', league: 'fra.1', mode: 'teams' }
  ],
  Basketball: [{ label: 'NBA', sport: 'basketball', league: 'nba', mode: 'teams' }],
  Football: [{ label: 'NFL', sport: 'football', league: 'nfl', mode: 'teams' }],
  Baseball: [{ label: 'MLB', sport: 'baseball', league: 'mlb', mode: 'teams' }],
  Tennis: [
    { label: 'ATP', sport: 'tennis', league: 'atp', mode: 'athletes' },
    { label: 'WTA', sport: 'tennis', league: 'wta', mode: 'athletes' }
  ]
};

const cache = new Map();
const CACHE_MS = 60 * 60 * 1000;

function send(res, code, body, type='application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

async function getJson(url) {
  const sep = url.includes('?') ? '&' : '?';
  const freshUrl = `${url}${sep}_=${Date.now()}`;
  const r = await fetch(freshUrl, { headers: { 'User-Agent': 'OneTouchFantasy/1.1', 'Accept': 'application/json', 'Cache-Control': 'no-cache' } });
  if (!r.ok) throw new Error(`Feed returned ${r.status}`);
  return r.json();
}

async function scores(req, res, url) {
  const sport = url.searchParams.get('sport') || 'Soccer';
  if (!feeds[sport]) return send(res, 400, JSON.stringify({ error: 'Unknown sport' }));
  try {
    const results = await Promise.allSettled(feeds[sport].map(getJson));
    const good = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    const failedFeeds = results.length - good.length;
    if (!good.length) throw results.find(r => r.status === 'rejected')?.reason || new Error('All score sources failed');
    const events = good.flatMap(d => d.events || []);
    send(res, 200, JSON.stringify({ sport, updatedAt: new Date().toISOString(), failedFeeds, events }));
  } catch (e) {
    send(res, 502, JSON.stringify({ error: 'Could not load live scores', detail: e.message }));
  }
}

function extractTeams(data) {
  const leagues = data?.sports?.flatMap(s => s.leagues || []) || [];
  return leagues.flatMap(l => l.teams || []).map(x => x.team || x).filter(Boolean);
}

function flattenRoster(data, teamName, leagueLabel) {
  const groups = Array.isArray(data?.athletes) ? data.athletes : [];
  const raw = [];
  for (const g of groups) {
    if (Array.isArray(g?.items)) raw.push(...g.items.map(a => ({...a, _group:g.position||g.name||''})));
    else if (g?.fullName || g?.displayName || g?.id) raw.push(g);
  }
  if (Array.isArray(data?.items)) raw.push(...data.items);
  return raw.map(a => ({
    id: String(a.id || a.uid || `${teamName}-${a.displayName || a.fullName || Math.random()}`),
    name: a.displayName || a.fullName || a.shortName || a.name || 'Unknown player',
    team: teamName,
    league: leagueLabel,
    position: a.position?.abbreviation || a.position?.displayName || a.position?.name || a._group || 'Player',
    headshot: a.headshot?.href || a.headshot || ''
  })).filter(p => p.name !== 'Unknown player');
}

async function loadTeamLeague(source) {
  const teamsUrl = `https://site.api.espn.com/apis/site/v2/sports/${source.sport}/${source.league}/teams?limit=100`;
  const teams = extractTeams(await getJson(teamsUrl));
  const results = await Promise.allSettled(teams.map(async t => {
    const rosterUrl = `https://site.api.espn.com/apis/site/v2/sports/${source.sport}/${source.league}/teams/${t.id}/roster`;
    const data = await getJson(rosterUrl);
    return flattenRoster(data, t.displayName || t.name || t.shortDisplayName || 'Team', source.label);
  }));
  return results.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
}

function refId(ref='') {
  const m = String(ref).match(/\/athletes\/(\d+)/);
  return m ? m[1] : '';
}

async function loadAthleteLeague(source) {
  const url = `https://sports.core.api.espn.com/v2/sports/${source.sport}/leagues/${source.league}/athletes?active=true&limit=1000`;
  const data = await getJson(url);
  const items = Array.isArray(data?.items) ? data.items : [];
  const direct = items.filter(x => x && !x.$ref).map(a => ({
    id: String(a.id || ''), name: a.displayName || a.fullName || a.name || 'Unknown player', team: source.label,
    league: source.label, position: a.position?.abbreviation || 'Player', headshot: a.headshot?.href || ''
  }));
  const refs = items.filter(x => x?.$ref).slice(0, 1000);
  if (!refs.length) return direct.filter(p => p.name !== 'Unknown player');
  const out = [...direct];
  for (let i=0; i<refs.length; i+=40) {
    const batch = refs.slice(i,i+40);
    const got = await Promise.allSettled(batch.map(x => getJson(x.$ref)));
    for (const r of got) if (r.status === 'fulfilled') {
      const a = r.value;
      out.push({
        id: String(a.id || refId(a.$ref) || ''),
        name: a.displayName || a.fullName || a.name || 'Unknown player',
        team: source.label,
        league: source.label,
        position: a.position?.abbreviation || 'Player',
        headshot: a.headshot?.href || ''
      });
    }
  }
  return out.filter(p => p.name !== 'Unknown player');
}

function uniqPlayers(players) {
  const seen = new Set();
  return players.filter(p => {
    const k = `${p.league}|${p.team}|${p.id || p.name}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }).sort((a,b) => a.name.localeCompare(b.name));
}

async function players(req, res, url) {
  const sport = url.searchParams.get('sport') || 'Soccer';
  const league = url.searchParams.get('league') || 'All';
  const sources = playerSources[sport];
  if (!sources) return send(res, 400, JSON.stringify({error:'Unknown sport'}));
  const selected = league === 'All' ? sources : sources.filter(s => s.label === league);
  if (!selected.length) return send(res, 400, JSON.stringify({error:'Unknown league'}));
  const key = `${sport}|${league}`;
  const saved = cache.get(key);
  if (saved && Date.now() - saved.time < CACHE_MS) return send(res, 200, JSON.stringify({...saved.value, cached:true}));
  try {
    const results = await Promise.allSettled(selected.map(s => s.mode === 'teams' ? loadTeamLeague(s) : loadAthleteLeague(s)));
    const good = results.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
    if (!good.length) throw results.find(r => r.status === 'rejected')?.reason || new Error('No player sources returned data');
    const value = { sport, league, updatedAt:new Date().toISOString(), failedSources:results.filter(r=>r.status==='rejected').length, players:uniqPlayers(good) };
    cache.set(key,{time:Date.now(),value});
    send(res,200,JSON.stringify(value));
  } catch(e) {
    send(res,502,JSON.stringify({error:'Could not load players',detail:e.message}));
  }
}

function staticFile(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(root, pathname));
  if (!file.startsWith(root)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    const ext = path.extname(file);
    const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8' };
    send(res, 200, data, types[ext] || 'application/octet-stream');
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/scores') return scores(req, res, url);
  if (url.pathname === '/api/players') return players(req, res, url);
  return staticFile(req, res, url);
}).listen(PORT, () => console.log(`One Touch is running at http://localhost:${PORT}`));
