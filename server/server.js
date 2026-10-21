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
<title>Entrar · ESP32-C5</title>${baseCss()}</head>
<body class="center">
  <form class="authcard" method="post" action="/login">
    <div class="logo">📡</div>
    <h1>Repetidor ESP32-C5</h1>
    <p class="sub">Panel de telemetría</p>
    ${err ? '<p class="err">Usuario o clave incorrectos</p>' : ''}
    <label class="fld"><span>Usuario</span>
      <input name="user" autocomplete="username" autofocus></label>
    <label class="fld"><span>Clave</span>
      <input name="pass" type="password" autocomplete="current-password"></label>
    <button type="submit">Entrar</button>
  </form>
</body></html>`;
}

function dashboardPage() {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ESP32-C5 Telemetría</title>${baseCss()}</head>
<body>
  <header>
    <div class="brand"><span class="brand-ico">📡</span>
      <div><div class="brand-name">Repetidor ESP32-C5</div>
        <div class="brand-sub" id="devid">—</div></div>
    </div>
    <div class="head-right">
      <span class="pill" id="pill"><span class="dot" id="dot"></span><span id="state">cargando…</span></span>
      <form method="post" action="/logout"><button class="ghost">Salir</button></form>
    </div>
  </header>
  <main>
    <div id="banner" class="banner" hidden></div>
    <section class="grid" id="cards"></section>
    <section class="panel">
      <div class="panel-head"><h2>RSSI</h2><span class="muted" id="rssi-now"></span></div>
      <svg id="spark" viewBox="0 0 600 140" preserveAspectRatio="none"></svg>
      <div class="axis"><span>-95 dBm</span><span>-30 dBm</span></div>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Historial reciente</h2><span class="muted" id="count"></span></div>
      <div class="tablewrap"><table id="hist"><thead><tr>
        <th>Hora</th><th>STA</th><th>IP</th><th>RSSI</th><th>Canal</th><th>Clientes</th><th>NAPT</th><th>Uptime</th>
      </tr></thead><tbody></tbody></table></div>
    </section>
    <footer class="foot">Actualiza cada 5 s · <span id="updated">—</span></footer>
  </main>
<script>${dashboardJs()}</script>
</body></html>`;
}

function dashboardJs() {
  return `
const $=s=>document.querySelector(s);
function ago(ts){const s=Math.floor((Date.now()-ts)/1000);if(s<60)return s+'s';if(s<3600)return Math.floor(s/60)+'m';return Math.floor(s/3600)+'h';}
function dur(s){if(s==null)return '—';const h=Math.floor(s/3600),m=Math.floor(s%3600/60),ss=Math.floor(s%60);return (h?h+'h ':'')+(h||m?m+'m ':'')+ss+'s';}
function esc(x){return String(x==null?'':x).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
function band(ch){if(ch==null)return '';return ch>=32?'5 GHz':'2.4 GHz';}
function card(label,value,sub,cls){return '<div class="stat '+(cls||'')+'"><div class="stat-l">'+label+'</div><div class="stat-v">'+value+'</div>'+(sub?'<div class="stat-s">'+sub+'</div>':'')+'</div>';}
async function tick(){
  let d; try{d=await (await fetch('/api/data?limit=120',{cache:'no-store'})).json();}catch(e){return;}
  const l=d.latest; const online = l && (Date.now()-l.ts)<90000;
  $('#pill').className='pill '+(online?'ok':'bad');
  $('#dot').className='dot '+(online?'ok':'bad');
  $('#state').textContent = l ? (online?('En línea · hace '+ago(l.ts)):('Sin señal · hace '+ago(l.ts))) : 'Sin datos aún';
  $('#devid').textContent = l ? (l.device_id||'—')+(l.fw?(' · fw '+l.fw):'') : '—';
  $('#updated').textContent = new Date().toLocaleTimeString();
  const banner=$('#banner'), cards=$('#cards');
  if(l && !online){ banner.hidden=false; banner.textContent='⚠ Sin datos recientes (último hace '+ago(l.ts)+'). Es el ÚLTIMO estado conocido, puede no reflejar el actual.'; cards.classList.add('stale'); }
  else { banner.hidden=true; cards.classList.remove('stale'); }
  if(l){
    const macOk = l.sta_mac===d.expected_mac;
    $('#cards').innerHTML =
      card('Enlace STA', l.sta_connected?'Conectado':'Caído', l.sta_connected?('Red restringida'):'Reintentando', l.sta_connected?'good':'bad')+
      card('MAC', esc(l.sta_mac||'—'), macOk?'Clonada ✓':'De fábrica', macOk?'good':'warn')+
      card('IP asignada', esc(l.sta_ip||'—'), 'En la red destino', 'neutral')+
      card('NAPT', l.napt_ok?'Activo':'Fallo', l.napt_ok?'NAT funcionando':'Sin NAT', l.napt_ok?'good':'bad')+
      card('Señal', (l.rssi!=null?l.rssi+' dBm':'—'), rssiLabel(l.rssi), rssiCls(l.rssi))+
      card('Canal', esc(l.channel!=null?l.channel:'—'), band(l.channel), 'neutral')+
      card('Clientes', esc(l.ap_clients!=null?l.ap_clients:'—'), 'En ESP32-Extender', 'neutral')+
      card('Uptime', dur(l.uptime_s), 'Sin reinicios', 'neutral')+
      card('Heap libre', l.heap_free!=null?(Math.round(l.heap_free/1024)+' KB'):'—', 'Memoria', 'neutral');
    $('#rssi-now').textContent = l.rssi!=null?(l.rssi+' dBm'):'';
  }
  const pts=d.recent.map(r=>r.rssi).filter(v=>v!=null);
  const svg=$('#spark'); svg.innerHTML='';
  if(pts.length>1){
    const min=-95,max=-30,W=600,H=140;
    const step=W/(pts.length-1);
    const y=v=>H-((Math.max(min,Math.min(max,v))-min)/(max-min))*H;
    let dd='M0 '+y(pts[0]).toFixed(1); pts.forEach((v,i)=>{if(i)dd+=' L'+(i*step).toFixed(1)+' '+y(v).toFixed(1);});
    const area=dd+' L'+W+' '+H+' L0 '+H+' Z';
    svg.innerHTML='<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">'+
      '<stop offset="0%" stop-color="var(--accent)" stop-opacity="0.35"/>'+
      '<stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>'+
      '<path d="'+area+'" fill="url(#g)"/>'+
      '<path d="'+dd+'" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"/>';
  } else { svg.innerHTML='<text x="12" y="24" fill="var(--muted)" font-size="13">Aún sin suficientes muestras…</text>'; }
  $('#count').textContent = d.recent.length+' muestras';
  const rows=d.recent.slice().reverse().slice(0,40).map(r=>'<tr>'+
    '<td>'+new Date(r.ts).toLocaleTimeString()+'</td>'+
    '<td><span class="tag '+(r.sta_connected?'g':'b')+'">'+(r.sta_connected?'up':'down')+'</span></td>'+
    '<td class="mono">'+esc(r.sta_ip||'—')+'</td>'+
    '<td>'+esc(r.rssi!=null?r.rssi:'—')+'</td>'+
    '<td>'+esc(r.channel!=null?(r.channel+' · '+band(r.channel)):'—')+'</td>'+
    '<td>'+esc(r.ap_clients!=null?r.ap_clients:'—')+'</td>'+
    '<td><span class="tag '+(r.napt_ok?'g':'b')+'">'+(r.napt_ok?'ok':'x')+'</span></td>'+
    '<td>'+dur(r.uptime_s)+'</td></tr>').join('');
  $('#hist tbody').innerHTML=rows||'<tr><td colspan="8" class="muted" style="text-align:center;padding:24px">Sin datos todavía</td></tr>';
}
function rssiLabel(v){if(v==null)return '';if(v>=-55)return 'Excelente';if(v>=-67)return 'Buena';if(v>=-75)return 'Regular';return 'Débil';}
function rssiCls(v){if(v==null)return 'neutral';if(v>=-67)return 'good';if(v>=-75)return 'warn';return 'bad';}
tick(); setInterval(tick,5000);
`;
}

function baseCss() {
  return `<style>
:root{--bg:#eef1f5;--card:#ffffff;--card2:#f7f9fc;--fg:#141922;--muted:#6b7480;--line:#e3e8ef;--accent:#2f6df6;--ok:#15a34a;--bad:#e23b3b;--warn:#d98412;--shadow:0 1px 2px rgba(16,24,40,.06),0 1px 3px rgba(16,24,40,.10);}
:root:not([data-theme=light]) {}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0b0e14;--card:#151a22;--card2:#1b212b;--fg:#e8ecf2;--muted:#8b94a3;--line:#262d38;--accent:#5b8dff;--ok:#43d07f;--bad:#ff6b6b;--warn:#f5b53d;--shadow:0 1px 2px rgba(0,0,0,.3),0 2px 8px rgba(0,0,0,.25);}}
:root[data-theme=dark]{--bg:#0b0e14;--card:#151a22;--card2:#1b212b;--fg:#e8ecf2;--muted:#8b94a3;--line:#262d38;--accent:#5b8dff;--ok:#43d07f;--bad:#ff6b6b;--warn:#f5b53d;--shadow:0 1px 2px rgba(0,0,0,.3),0 2px 8px rgba(0,0,0,.25);}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em}
.center{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
/* header */
header{position:sticky;top:0;z-index:5;display:flex;justify-content:space-between;align-items:center;gap:16px;
  padding:14px 22px;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--card) 88%,transparent);backdrop-filter:saturate(1.3) blur(8px)}
.brand{display:flex;align-items:center;gap:12px;min-width:0}
.brand-ico{font-size:22px;filter:grayscale(.1)}
.brand-name{font-weight:700;letter-spacing:-.01em}
.brand-sub{font-size:12.5px;color:var(--muted)}
.head-right{display:flex;align-items:center;gap:12px}
.pill{display:inline-flex;align-items:center;gap:7px;padding:6px 12px;border-radius:999px;font-size:13px;font-weight:600;
  border:1px solid var(--line);background:var(--card2);color:var(--muted)}
.pill.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 40%,var(--line))}
.pill.bad{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 40%,var(--line))}
.dot{width:9px;height:9px;border-radius:50%;background:var(--muted);box-shadow:0 0 0 0 color-mix(in srgb,var(--muted) 50%,transparent)}
.dot.ok{background:var(--ok);animation:pulse 2s infinite}
.dot.bad{background:var(--bad)}
@keyframes pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--ok) 55%,transparent)}70%{box-shadow:0 0 0 7px transparent}100%{box-shadow:0 0 0 0 transparent}}
main{max-width:1040px;margin:0 auto;padding:22px}
.banner{background:color-mix(in srgb,var(--warn) 14%,transparent);color:var(--warn);border:1px solid color-mix(in srgb,var(--warn) 42%,var(--line));border-radius:12px;padding:11px 14px;font-size:13.5px;font-weight:600;margin-bottom:18px}
.stale{opacity:.5;filter:grayscale(.45);transition:opacity .2s}
/* stat grid */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(166px,1fr));gap:14px;margin-bottom:20px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:15px 16px;box-shadow:var(--shadow);position:relative;overflow:hidden}
.stat::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--muted);opacity:.5}
.stat.good::before{background:var(--ok)}.stat.bad::before{background:var(--bad)}.stat.warn::before{background:var(--warn)}.stat.neutral::before{background:var(--accent);opacity:.45}
.stat-l{font-size:11.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
.stat-v{font-size:21px;font-weight:700;margin-top:5px;letter-spacing:-.02em;word-break:break-word}
.stat.good .stat-v{color:var(--ok)}.stat.bad .stat-v{color:var(--bad)}.stat.warn .stat-v{color:var(--warn)}
.stat-s{font-size:12px;color:var(--muted);margin-top:3px}
/* panels */
.panel{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:20px;box-shadow:var(--shadow)}
.panel-head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:14px}
h1{font-size:21px;margin:0 0 4px}h2{font-size:15px;margin:0;font-weight:650}
.muted{color:var(--muted);font-size:13px}
svg{width:100%;height:140px;display:block}
.axis{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:6px}
/* table */
table{width:100%;border-collapse:collapse;font-size:13.5px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line)}
thead th{color:var(--muted);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.03em}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover{background:var(--card2)}
.tablewrap{overflow-x:auto;margin:0 -4px}
.tag{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600}
.tag.g{color:var(--ok);background:color-mix(in srgb,var(--ok) 15%,transparent)}
.tag.b{color:var(--bad);background:color-mix(in srgb,var(--bad) 15%,transparent)}
.foot{text-align:center;color:var(--muted);font-size:12px;padding:6px 0 20px}
/* buttons */
button{padding:9px 15px;border:0;border-radius:9px;background:var(--accent);color:#fff;font-size:14px;font-weight:600;cursor:pointer;transition:filter .15s}
button:hover{filter:brightness(1.07)}
button.ghost{background:transparent;color:var(--muted);border:1px solid var(--line)}
button.ghost:hover{background:var(--card2);filter:none}
/* login */
.authcard{width:340px;max-width:92vw;background:var(--card);border:1px solid var(--line);border-radius:18px;padding:30px 26px;box-shadow:var(--shadow);text-align:center}
.authcard .logo{font-size:40px;margin-bottom:6px}
.authcard h1{font-size:19px;margin:0}
.authcard .sub{color:var(--muted);font-size:13px;margin:4px 0 18px}
.fld{display:block;text-align:left;margin-bottom:13px}
.fld span{display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:5px}
input{width:100%;padding:11px 13px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg);font-size:15px;transition:border-color .15s,box-shadow .15s}
input:focus{outline:0;border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 22%,transparent)}
.authcard button{width:100%;margin-top:6px;padding:11px}
.err{color:var(--bad);font-size:13px;margin:0 0 12px;background:color-mix(in srgb,var(--bad) 12%,transparent);padding:8px;border-radius:8px}
@media(max-width:560px){header{padding:12px 16px}.brand-sub{display:none}main{padding:16px}}
</style>`;
}
