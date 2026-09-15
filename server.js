const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const root = __dirname;
const dataDir = path.join(root, 'data');
const usersFile = path.join(dataDir, 'users.json');
const localSessions = new Map();
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
}) : null;

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

function send(res, code, body, type='application/json; charset=utf-8', extraHeaders={}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(body);
}
function json(res, code, value, headers={}) { send(res, code, JSON.stringify(value), 'application/json; charset=utf-8', headers); }
function ensureDataDir(){if(!fs.existsSync(dataDir))fs.mkdirSync(dataDir,{recursive:true});if(!fs.existsSync(usersFile))fs.writeFileSync(usersFile,'[]','utf8')}
function readUsers(){ensureDataDir();try{return JSON.parse(fs.readFileSync(usersFile,'utf8'))}catch{return[]}}
function writeUsers(users){ensureDataDir();fs.writeFileSync(usersFile,JSON.stringify(users,null,2),'utf8')}
function readJsonBody(req){return new Promise((resolve,reject)=>{let body='';req.on('data',chunk=>{body+=chunk;if(body.length>1_000_000){reject(new Error('Request too large'));req.destroy()}});req.on('end',()=>{if(!body)return resolve({});try{resolve(JSON.parse(body))}catch{reject(new Error('Invalid JSON'))}});req.on('error',reject)})}

function normalizeEmail(v=''){return String(v).trim().toLowerCase()}
function publicUser(u){return{id:u.id,displayName:u.displayName,email:u.email,createdAt:u.createdAt}}
function passwordHash(password,salt){return crypto.scryptSync(password,salt,64).toString('hex')}
function tokenHash(token){return crypto.createHash('sha256').update(token).digest('hex')}
function safeEqualHex(a,b){try{const aa=Buffer.from(a,'hex'),bb=Buffer.from(b,'hex');return aa.length===bb.length&&crypto.timingSafeEqual(aa,bb)}catch{return false}}
function parseCookies(req){const out={};for(const part of String(req.headers.cookie||'').split(';')){const i=part.indexOf('=');if(i>0)out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim())}return out}
function sessionCookie(token,maxAge=60*60*24*7){const secure=process.env.NODE_ENV==='production'?'; Secure':'';return `one_touch_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`}
function dbUser(row){return row?{id:row.id,displayName:row.display_name,email:row.email,salt:row.password_salt,passwordHash:row.password_hash,createdAt:row.created_at instanceof Date?row.created_at.toISOString():row.created_at}:null}
async function findUserByEmail(email){if(!pool)return readUsers().find(u=>u.email===email)||null;const r=await pool.query('SELECT * FROM users WHERE email = $1 LIMIT 1',[email]);return dbUser(r.rows[0])}
async function findUserById(id){if(!pool)return readUsers().find(u=>u.id===id)||null;const r=await pool.query('SELECT * FROM users WHERE id = $1 LIMIT 1',[id]);return dbUser(r.rows[0])}
async function createUserRecord(user){if(!pool){const users=readUsers();if(users.some(u=>u.email===user.email))throw Object.assign(new Error('An account with that email already exists.'),{code:'DUPLICATE_EMAIL'});users.push(user);writeUsers(users);return user}try{const r=await pool.query('INSERT INTO users (id, display_name, email, password_salt, password_hash, created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',[user.id,user.displayName,user.email,user.salt,user.passwordHash,user.createdAt]);return dbUser(r.rows[0])}catch(e){if(e.code==='23505')throw Object.assign(new Error('An account with that email already exists.'),{code:'DUPLICATE_EMAIL'});throw e}}
async function newSession(userId){const token=crypto.randomBytes(32).toString('hex');if(!pool)localSessions.set(token,userId);else{const expires=new Date(Date.now()+7*24*60*60*1000);await pool.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1,$2,$3)',[tokenHash(token),userId,expires])}return token}
async function currentUser(req){const token=parseCookies(req).one_touch_session;if(!token)return null;if(!pool){const userId=localSessions.get(token);return userId?findUserById(userId):null}const r=await pool.query(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW() LIMIT 1`,[tokenHash(token)]);return dbUser(r.rows[0])}
async function removeSession(token){if(!token)return;if(!pool)localSessions.delete(token);else await pool.query('DELETE FROM sessions WHERE token_hash=$1',[tokenHash(token)])}

async function authSignup(req,res){try{const body=await readJsonBody(req);const displayName=String(body.displayName||'').trim(),email=normalizeEmail(body.email),password=String(body.password||'');if(displayName.length<2)return json(res,400,{error:'Display name must be at least 2 characters.'});if(!/^\S+@\S+\.\S+$/.test(email))return json(res,400,{error:'Enter a valid email address.'});if(password.length<8)return json(res,400,{error:'Password must be at least 8 characters.'});if(await findUserByEmail(email))return json(res,409,{error:'An account with that email already exists.'});const salt=crypto.randomBytes(16).toString('hex');const user=await createUserRecord({id:crypto.randomUUID(),displayName,email,salt,passwordHash:passwordHash(password,salt),createdAt:new Date().toISOString()});const token=await newSession(user.id);json(res,201,{user:publicUser(user),storage:pool?'postgres':'local'},{'Set-Cookie':sessionCookie(token)})}catch(e){if(e.code==='DUPLICATE_EMAIL')return json(res,409,{error:e.message});json(res,500,{error:'Could not create account.'})}}
async function authLogin(req,res){try{const body=await readJsonBody(req);const user=await findUserByEmail(normalizeEmail(body.email));const password=String(body.password||'');if(!user||!safeEqualHex(passwordHash(password,user.salt),user.passwordHash))return json(res,401,{error:'Incorrect email or password.'});const token=await newSession(user.id);json(res,200,{user:publicUser(user),storage:pool?'postgres':'local'},{'Set-Cookie':sessionCookie(token)})}catch{json(res,500,{error:'Could not log in.'})}}
async function authMe(req,res){try{const user=await currentUser(req);json(res,200,{user:user?publicUser(user):null,storage:pool?'postgres':'local'})}catch{json(res,500,{error:'Could not read account.'})}}
async function authLogout(req,res){try{await removeSession(parseCookies(req).one_touch_session)}finally{json(res,200,{ok:true},{'Set-Cookie':sessionCookie('',0)})}}

function inviteCode(){return crypto.randomBytes(5).toString('hex').slice(0,8).toUpperCase()}
async function requireUser(req,res){const user=await currentUser(req);if(!user){json(res,401,{error:'Please sign in first.'});return null}return user}
async function listLeagues(req,res){try{const user=await requireUser(req,res);if(!user)return;if(!pool)return json(res,503,{error:'Leagues require the PostgreSQL database.'});const r=await pool.query(`SELECT l.id,l.name,l.sport,l.invite_code,l.owner_user_id,l.created_at,
      COUNT(lm2.user_id)::int AS member_count,
      CASE WHEN l.owner_user_id=$1 THEN true ELSE false END AS is_owner
      FROM leagues l JOIN league_members lm ON lm.league_id=l.id AND lm.user_id=$1
      LEFT JOIN league_members lm2 ON lm2.league_id=l.id
      GROUP BY l.id ORDER BY l.created_at DESC`,[user.id]);json(res,200,{leagues:r.rows.map(x=>({id:x.id,name:x.name,sport:x.sport,inviteCode:x.invite_code,memberCount:x.member_count,isOwner:x.is_owner,createdAt:x.created_at}))})}catch(e){json(res,500,{error:'Could not load leagues.'})}}
async function createLeague(req,res){try{const user=await requireUser(req,res);if(!user)return;if(!pool)return json(res,503,{error:'Leagues require the PostgreSQL database.'});const body=await readJsonBody(req);const name=String(body.name||'').trim();const sport=String(body.sport||'').trim();if(name.length<2||name.length>100)return json(res,400,{error:'League name must be 2–100 characters.'});if(!['Soccer','Basketball','Football','Baseball','Tennis'].includes(sport))return json(res,400,{error:'Choose a valid sport.'});const id=crypto.randomUUID();let code;for(let i=0;i<5;i++){code=inviteCode();const c=await pool.query('SELECT 1 FROM leagues WHERE invite_code=$1',[code]);if(!c.rowCount)break}const client=await pool.connect();try{await client.query('BEGIN');await client.query('INSERT INTO leagues (id,owner_user_id,name,sport,invite_code) VALUES ($1,$2,$3,$4,$5)',[id,user.id,name,sport,code]);await client.query('INSERT INTO league_members (league_id,user_id) VALUES ($1,$2)',[id,user.id]);await client.query('COMMIT')}catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}json(res,201,{league:{id,name,sport,inviteCode:code,memberCount:1,isOwner:true}})}catch(e){json(res,500,{error:'Could not create league.'})}}
async function joinLeague(req,res){try{const user=await requireUser(req,res);if(!user)return;if(!pool)return json(res,503,{error:'Leagues require the PostgreSQL database.'});const body=await readJsonBody(req);const code=String(body.inviteCode||'').trim().toUpperCase();if(!code)return json(res,400,{error:'Enter an invite code.'});const r=await pool.query('SELECT * FROM leagues WHERE invite_code=$1 LIMIT 1',[code]);if(!r.rowCount)return json(res,404,{error:'Invite code not found.'});const league=r.rows[0];await pool.query('INSERT INTO league_members (league_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',[league.id,user.id]);json(res,200,{league:{id:league.id,name:league.name,sport:league.sport,inviteCode:league.invite_code}})}catch(e){json(res,500,{error:'Could not join league.'})}}
async function leagueMembers(req,res,id){try{const user=await requireUser(req,res);if(!user)return;if(!pool)return json(res,503,{error:'Leagues require the PostgreSQL database.'});const access=await pool.query('SELECT 1 FROM league_members WHERE league_id=$1 AND user_id=$2',[id,user.id]);if(!access.rowCount)return json(res,403,{error:'You are not a member of this league.'});const r=await pool.query(`SELECT u.id,u.display_name,lm.joined_at,(l.owner_user_id=u.id) AS is_owner FROM league_members lm JOIN users u ON u.id=lm.user_id JOIN leagues l ON l.id=lm.league_id WHERE lm.league_id=$1 ORDER BY is_owner DESC,lm.joined_at`,[id]);json(res,200,{members:r.rows.map(x=>({id:x.id,displayName:x.display_name,joinedAt:x.joined_at,isOwner:x.is_owner}))})}catch(e){json(res,500,{error:'Could not load league members.'})}}

async function getJson(url){const sep=url.includes('?')?'&':'?';const r=await fetch(`${url}${sep}_=${Date.now()}`,{headers:{'User-Agent':'OneTouchFantasy/1.4','Accept':'application/json','Cache-Control':'no-cache'}});if(!r.ok)throw new Error(`Feed returned ${r.status}`);return r.json()}
async function scores(req,res,url){const sport=url.searchParams.get('sport')||'Soccer';if(!feeds[sport])return json(res,400,{error:'Unknown sport'});try{const results=await Promise.allSettled(feeds[sport].map(getJson));const good=results.filter(r=>r.status==='fulfilled').map(r=>r.value);if(!good.length)throw new Error('All score sources failed');json(res,200,{sport,updatedAt:new Date().toISOString(),failedFeeds:results.length-good.length,events:good.flatMap(d=>d.events||[])})}catch(e){json(res,502,{error:'Could not load live scores',detail:e.message})}}
function extractTeams(data){const leagues=data?.sports?.flatMap(s=>s.leagues||[])||[];return leagues.flatMap(l=>l.teams||[]).map(x=>x.team||x).filter(Boolean)}
function flattenRoster(data,teamName,leagueLabel){const groups=Array.isArray(data?.athletes)?data.athletes:[],raw=[];for(const g of groups){if(Array.isArray(g?.items))raw.push(...g.items.map(a=>({...a,_group:g.position||g.name||''})));else if(g?.fullName||g?.displayName||g?.id)raw.push(g)}if(Array.isArray(data?.items))raw.push(...data.items);return raw.map(a=>({id:String(a.id||a.uid||`${teamName}-${a.displayName||a.fullName||Math.random()}`),name:a.displayName||a.fullName||a.shortName||a.name||'Unknown player',team:teamName,league:leagueLabel,position:a.position?.abbreviation||a.position?.displayName||a.position?.name||a._group||'Player',headshot:a.headshot?.href||a.headshot||''})).filter(p=>p.name!=='Unknown player')}
async function loadTeamLeague(source){const teams=extractTeams(await getJson(`https://site.api.espn.com/apis/site/v2/sports/${source.sport}/${source.league}/teams?limit=100`));const results=await Promise.allSettled(teams.map(async t=>flattenRoster(await getJson(`https://site.api.espn.com/apis/site/v2/sports/${source.sport}/${source.league}/teams/${t.id}/roster`),t.displayName||t.name||t.shortDisplayName||'Team',source.label)));return results.filter(r=>r.status==='fulfilled').flatMap(r=>r.value)}
function refId(ref=''){const m=String(ref).match(/\/athletes\/(\d+)/);return m?m[1]:''}
async function loadAthleteLeague(source){const data=await getJson(`https://sports.core.api.espn.com/v2/sports/${source.sport}/leagues/${source.league}/athletes?active=true&limit=1000`);const items=Array.isArray(data?.items)?data.items:[];const direct=items.filter(x=>x&&!x.$ref).map(a=>({id:String(a.id||''),name:a.displayName||a.fullName||a.name||'Unknown player',team:source.label,league:source.label,position:a.position?.abbreviation||'Player',headshot:a.headshot?.href||''}));const refs=items.filter(x=>x?.$ref).slice(0,1000);if(!refs.length)return direct.filter(p=>p.name!=='Unknown player');const out=[...direct];for(let i=0;i<refs.length;i+=40){const got=await Promise.allSettled(refs.slice(i,i+40).map(x=>getJson(x.$ref)));for(const r of got)if(r.status==='fulfilled'){const a=r.value;out.push({id:String(a.id||refId(a.$ref)||''),name:a.displayName||a.fullName||a.name||'Unknown player',team:source.label,league:source.label,position:a.position?.abbreviation||'Player',headshot:a.headshot?.href||''})}}return out.filter(p=>p.name!=='Unknown player')}
function uniqPlayers(players){const seen=new Set();return players.filter(p=>{const k=`${p.league}|${p.team}|${p.id||p.name}`;if(seen.has(k))return false;seen.add(k);return true}).sort((a,b)=>a.name.localeCompare(b.name))}
async function players(req,res,url){const sport=url.searchParams.get('sport')||'Soccer',league=url.searchParams.get('league')||'All',sources=playerSources[sport];if(!sources)return json(res,400,{error:'Unknown sport'});const selected=league==='All'?sources:sources.filter(s=>s.label===league);if(!selected.length)return json(res,400,{error:'Unknown league'});const key=`${sport}|${league}`,saved=cache.get(key);if(saved&&Date.now()-saved.time<CACHE_MS)return json(res,200,{...saved.value,cached:true});try{const results=await Promise.allSettled(selected.map(s=>s.mode==='teams'?loadTeamLeague(s):loadAthleteLeague(s)));const good=results.filter(r=>r.status==='fulfilled').flatMap(r=>r.value);if(!good.length)throw new Error('No player sources returned data');const value={sport,league,updatedAt:new Date().toISOString(),failedSources:results.filter(r=>r.status==='rejected').length,players:uniqPlayers(good)};cache.set(key,{time:Date.now(),value});json(res,200,value)}catch(e){json(res,502,{error:'Could not load players',detail:e.message})}}
function staticFile(req,res,url){let pathname=decodeURIComponent(url.pathname);if(pathname==='/')pathname='/index.html';const file=path.normalize(path.join(root,pathname));if(!file.startsWith(root))return send(res,403,'Forbidden','text/plain');fs.readFile(file,(err,data)=>{if(err)return send(res,404,'Not found','text/plain');const ext=path.extname(file),types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8'};send(res,200,data,types[ext]||'application/octet-stream')})}

http.createServer(async(req,res)=>{
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  if(url.pathname==='/api/health')return json(res,200,{ok:true,database:pool?'postgres':'local'});
  if(url.pathname==='/api/auth/signup'&&req.method==='POST')return authSignup(req,res);
  if(url.pathname==='/api/auth/login'&&req.method==='POST')return authLogin(req,res);
  if(url.pathname==='/api/auth/logout'&&req.method==='POST')return authLogout(req,res);
  if(url.pathname==='/api/auth/me'&&req.method==='GET')return authMe(req,res);
  if(url.pathname==='/api/leagues'&&req.method==='GET')return listLeagues(req,res);
  if(url.pathname==='/api/leagues'&&req.method==='POST')return createLeague(req,res);
  if(url.pathname==='/api/leagues/join'&&req.method==='POST')return joinLeague(req,res);
  const memberMatch=url.pathname.match(/^\/api\/leagues\/([0-9a-f-]+)\/members$/i);
  if(memberMatch&&req.method==='GET')return leagueMembers(req,res,memberMatch[1]);
  if(url.pathname==='/api/scores')return scores(req,res,url);
  if(url.pathname==='/api/players')return players(req,res,url);
  return staticFile(req,res,url);
}).listen(PORT,()=>console.log(`One Touch is running at http://localhost:${PORT} (${pool?'PostgreSQL':'local storage'})`));
