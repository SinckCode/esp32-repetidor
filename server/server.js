/*
 * ESP32-C5 Telemetry API + Dashboard
 * ----------------------------------
 * - El ESP32 hace POST /api/telemetry con Authorization: Bearer <DEVICE_TOKEN>.
 * - Cada muestra se guarda como una linea JSON en data/telemetry.jsonl.
 * - El dashboard (/) pide login (DASH_USER/DASH_PASS) y muestra el estado en vivo.
 *
 * Sin dependencias nativas: solo express + express-session. Corre en cualquier VM
 * con Node >= 18. Pensado para ir detras de un tunel de Cloudflare (HTTPS).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');

// ---- Config (.env opcional; en la VM las pasa PM2/entorno) ----
function loadDotEnv(file) {
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
try { if (fs.existsSync('.env')) loadDotEnv('.env'); } catch (_) {}

const PORT = parseInt(process.env.PORT || '5055', 10);
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || '';
const DASH_USER = process.env.DASH_USER || 'admin';
const DASH_PASS = process.env.DASH_PASS || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE_SECURE = process.env.COOKIE_SECURE !== 'false';
const EXPECTED_MAC = (process.env.EXPECTED_MAC || '00:11:22:33:44:55').toUpperCase();

if (!DEVICE_TOKEN) console.warn('[AVISO] DEVICE_TOKEN vacio: /api/telemetry responde 503 (falla cerrada).');
if (!DASH_PASS) console.warn('[AVISO] DASH_PASS vacio: nadie podra entrar al dashboard.');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'telemetry.jsonl');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- Comparacion de secretos en tiempo constante ----
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) { crypto.timingSafeEqual(ba, ba); return false; }
  return crypto.timingSafeEqual(ba, bb);
}

// ---- Estado en memoria + ultimo registro ----
let latest = null;
(function bootstrapLatest() {
  try {
    const txt = fs.readFileSync(DATA_FILE, 'utf8').trimEnd();
    if (txt) latest = JSON.parse(txt.slice(txt.lastIndexOf('\n') + 1));
  } catch (_) {}
})();

function readRecent(limit) {
  let txt = '';
  try { txt = fs.readFileSync(DATA_FILE, 'utf8'); } catch (_) { return []; }
  const lines = txt.split('\n').filter(Boolean);
  const slice = lines.slice(-limit);
  const out = [];
  for (const l of slice) { try { out.push(JSON.parse(l)); } catch (_) {} }
  return out;
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));

// =================== API: recibe telemetria del ESP32 ===================
app.post('/api/telemetry', (req, res) => {
  if (!DEVICE_TOKEN) return res.status(503).json({ error: 'servidor sin DEVICE_TOKEN' });
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!safeEqual(token, DEVICE_TOKEN)) return res.status(401).json({ error: 'token invalido' });

  const b = req.body || {};
  const rec = {
    ts: Date.now(),
    device_id: String(b.device_id || 'esp32-c5'),
    fw: String(b.fw || ''),
    sta_connected: !!b.sta_connected,
    sta_mac: String(b.sta_mac || '').toUpperCase(),
    sta_ip: String(b.sta_ip || ''),
    rssi: num(b.rssi),
    channel: num(b.channel),
    ap_clients: num(b.ap_clients),
    napt_ok: !!b.napt_ok,
    uptime_s: num(b.uptime_s),
    heap_free: num(b.heap_free),
  };
  fs.appendFile(DATA_FILE, JSON.stringify(rec) + '\n', () => {});
  latest = rec;
  res.status(204).end();
});

// =================== Login / sesion ===================
app.use(session({
  name: 'esp32.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE, maxAge: 7 * 24 * 3600 * 1000 },
}));
app.use(express.urlencoded({ extended: false }));

function requireAuth(req, res, next) {
  if (req.session && req.session.ok) return next();
  res.redirect('/login');
}

app.get('/login', (req, res) => res.type('html').send(loginPage(false)));
app.post('/login', (req, res) => {
  const u = req.body.user || '', p = req.body.pass || '';
  if (DASH_PASS && safeEqual(u, DASH_USER) && safeEqual(p, DASH_PASS)) {
    req.session.ok = true;
    return res.redirect('/');
  }
  res.status(401).type('html').send(loginPage(true));
});
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

// =================== Dashboard ===================
app.get('/', requireAuth, (req, res) => res.type('html').send(dashboardPage()));
app.get('/api/data', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '300', 10) || 300, 2000);
  res.json({ latest, expected_mac: EXPECTED_MAC, recent: readRecent(limit) });
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log('ESP32 telemetry API en http://localhost:' + PORT));

// =================== Vistas (HTML inline) ===================
function loginPage(err) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Entrar</title>${baseCss()}</head>
<body class="center">
  <form class="card login" method="post" action="/login">
    <h1>Repetidor ESP32-C5</h1>
    <p class="muted">Panel de telemetria</p>
    ${err ? '<p class="err">Usuario o clave incorrectos</p>' : ''}
    <input name="user" placeholder="Usuario" autocomplete="username" autofocus>
    <input name="pass" type="password" placeholder="Clave" autocomplete="current-password">
    <button type="submit">Entrar</button>
  </form>
</body></html>`;
}

function dashboardPage() {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ESP32-C5 Telemetria</title>${baseCss()}</head>
<body>
  <header>
    <div><strong>Repetidor ESP32-C5</strong> <span id="dot" class="dot"></span><span id="state" class="muted">cargando…</span></div>
    <form method="post" action="/logout"><button class="ghost">Salir</button></form>
  </header>
  <main>
    <section class="grid" id="cards"></section>
    <section class="card">
      <h2>RSSI (ultimas muestras)</h2>
      <svg id="spark" viewBox="0 0 600 120" preserveAspectRatio="none"></svg>
    </section>
    <section class="card">
      <h2>Historial reciente</h2>
      <div class="tablewrap"><table id="hist"><thead><tr>
        <th>Hora</th><th>STA</th><th>IP</th><th>RSSI</th><th>Ch</th><th>Clientes</th><th>NAPT</th><th>Uptime</th>
      </tr></thead><tbody></tbody></table></div>
    </section>
  </main>
<script>${dashboardJs()}</script>
</body></html>`;
}

function dashboardJs() {
  return `
const $=s=>document.querySelector(s);
function ago(ts){const s=Math.floor((Date.now()-ts)/1000);if(s<60)return s+'s';if(s<3600)return Math.floor(s/60)+'m';return Math.floor(s/3600)+'h';}
function dur(s){if(s==null)return '—';const h=Math.floor(s/3600),m=Math.floor(s%3600/60);return (h?h+'h ':'')+m+'m';}
function esc(x){return String(x==null?'':x).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
function card(label,value,cls){return '<div class="card stat '+(cls||'')+'"><div class="muted">'+label+'</div><div class="big">'+value+'</div></div>';}
async function tick(){
  let d; try{d=await (await fetch('/api/data?limit=120',{cache:'no-store'})).json();}catch(e){return;}
  const l=d.latest; const online = l && (Date.now()-l.ts)<90000;
  $('#dot').className='dot '+(online?'ok':'bad');
  $('#state').textContent = l ? (online?('en linea · visto hace '+ago(l.ts)):('SIN SEÑAL · ultimo hace '+ago(l.ts))) : 'sin datos aun';
  if(l){
    const macOk = l.sta_mac===d.expected_mac;
    $('#cards').innerHTML =
      card('STA (RedRestringida)', l.sta_connected?'Conectado':'Caido', l.sta_connected?'good':'bad')+
      card('MAC clonada', esc(l.sta_mac||'—'), macOk?'good':'warn')+
      card('IP en RedRestringida', esc(l.sta_ip||'—'))+
      card('NAPT', l.napt_ok?'OK':'FALLO', l.napt_ok?'good':'bad')+
      card('RSSI', (l.rssi!=null?l.rssi+' dBm':'—'))+
      card('Canal', esc(l.channel!=null?l.channel:'—'))+
      card('Clientes en AP', esc(l.ap_clients!=null?l.ap_clients:'—'))+
      card('Uptime', dur(l.uptime_s))+
      card('Heap libre', l.heap_free!=null?(Math.round(l.heap_free/1024)+' KB'):'—');
  }
  const pts=d.recent.map(r=>r.rssi).filter(v=>v!=null);
  const svg=$('#spark'); svg.innerHTML='';
  if(pts.length>1){
    const min=-95,max=-30,W=600,H=120;
    const step=W/(pts.length-1);
    const y=v=>H-((Math.max(min,Math.min(max,v))-min)/(max-min))*H;
    let dd='M0 '+y(pts[0]); pts.forEach((v,i)=>dd+=' L'+(i*step).toFixed(1)+' '+y(v).toFixed(1));
    svg.innerHTML='<path d="'+dd+'" fill="none" stroke="var(--accent)" stroke-width="2"/>';
  }
  const rows=d.recent.slice().reverse().slice(0,40).map(r=>'<tr>'+
    '<td>'+new Date(r.ts).toLocaleTimeString()+'</td>'+
    '<td class="'+(r.sta_connected?'g':'b')+'">'+(r.sta_connected?'up':'down')+'</td>'+
    '<td>'+esc(r.sta_ip||'—')+'</td>'+
    '<td>'+esc(r.rssi!=null?r.rssi:'—')+'</td>'+
    '<td>'+esc(r.channel!=null?r.channel:'—')+'</td>'+
    '<td>'+esc(r.ap_clients!=null?r.ap_clients:'—')+'</td>'+
    '<td class="'+(r.napt_ok?'g':'b')+'">'+(r.napt_ok?'ok':'x')+'</td>'+
    '<td>'+dur(r.uptime_s)+'</td></tr>').join('');
  $('#hist tbody').innerHTML=rows||'<tr><td colspan="8" class="muted">Sin datos</td></tr>';
}
tick(); setInterval(tick,5000);
`;
}

function baseCss() {
  return `<style>
:root{--bg:#f4f5f7;--card:#fff;--fg:#1a1d21;--muted:#6b7280;--line:#e5e7eb;--accent:#2563eb;--ok:#16a34a;--bad:#dc2626;--warn:#d97706;}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#1a1d23;--fg:#e8eaed;--muted:#9aa0a6;--line:#2a2e37;--accent:#60a5fa;--ok:#4ade80;--bad:#f87171;--warn:#fbbf24;}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,Segoe UI,Roboto,sans-serif}
.center{min-height:100vh;display:flex;align-items:center;justify-content:center}
header{display:flex;justify-content:space-between;align-items:center;padding:14px 20px;border-bottom:1px solid var(--line);background:var(--card)}
main{max-width:980px;margin:0 auto;padding:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
.stat{margin:0}.big{font-size:22px;font-weight:650;margin-top:4px}
.muted{color:var(--muted);font-size:13px}
.good .big{color:var(--ok)}.bad .big{color:var(--bad)}.warn .big{color:var(--warn)}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:0 0 12px}
.login{width:320px;display:flex;flex-direction:column;gap:10px}
input{padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font-size:15px}
button{padding:10px 14px;border:0;border-radius:8px;background:var(--accent);color:#fff;font-size:15px;cursor:pointer}
button.ghost{background:transparent;color:var(--muted);border:1px solid var(--line)}
.err{color:var(--bad);font-size:13px;margin:0}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--muted);margin:0 6px}
.dot.ok{background:var(--ok)}.dot.bad{background:var(--bad)}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-weight:600}.tablewrap{overflow-x:auto}td.g{color:var(--ok)}td.b{color:var(--bad)}
svg{width:100%;height:120px;display:block}
</style>`;
}
