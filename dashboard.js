const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const snmp = require('snmp-native');
const gsheets = require('./lib/gsheets');

const COMMUNITY = process.env.SNMP_COMMUNITY || 'arlzabbix';
const PORT = 161;
const POLL_MS = 5000;
const GRACE_MS = 60000;
const HISTORY_SAMPLE_MS = 60000;
const HISTORY_MAX = 2000;
const HIST_DIR = path.join(__dirname, 'history');
const PORT_HTTP = process.env.PORT || 8080;

// Device list. The real routers.json is git-ignored (may contain credentials);
// if it's missing we fall back to routers.example.json or an empty list.
const ROUTERS_FILE = path.join(__dirname, 'routers.json');
let routers = [];
try {
  routers = JSON.parse(fs.readFileSync(ROUTERS_FILE, 'utf8'));
} catch (e) {
  try {
    routers = JSON.parse(fs.readFileSync(path.join(__dirname, 'routers.example.json'), 'utf8'));
    console.warn('[config] routers.json missing — using routers.example.json (copy it to routers.json and edit).');
  } catch (e2) {
    routers = [];
    console.warn('[config] no routers.json found — starting with an empty device list.');
  }
}

// ----- Authentication config -----
// auth.json shape: { users: [ { username, password, displayName, role } ] }
// A legacy single-user object ({ username, password, ... }) is auto-migrated.
const AUTH_FILE = path.join(__dirname, 'auth.json');
let AUTH = { users: [{ username: 'admin', password: 'admin123', displayName: 'Admin', role: 'admin' }] };
try {
  const raw = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  if (raw && Array.isArray(raw.users)) AUTH = raw;
  else if (raw && raw.username) AUTH = { users: [{ username: raw.username, password: raw.password || 'admin123', displayName: raw.displayName || raw.username, role: raw.role || 'admin' }] };
} catch (e) {}
if (!Array.isArray(AUTH.users) || !AUTH.users.length) AUTH = { users: [{ username: 'admin', password: 'admin123', displayName: 'Admin', role: 'admin' }] };

function saveAuth() { try { fs.writeFileSync(AUTH_FILE, JSON.stringify(AUTH, null, 2)); } catch (e) {} pushUsersToSheet(); }
function findUser(username) { return AUTH.users.find(u => u.username.toLowerCase() === String(username || '').toLowerCase()) || null; }
function publicUser(u) { return { username: u.username, displayName: u.displayName || u.username, role: u.role || 'user' }; }
function adminCount() { return AUTH.users.filter(u => (u.role || 'user') === 'admin').length; }
function invalidateUserSessions(username) {
  for (const [tok, s] of sessions) if (s.username === username) sessions.delete(tok);
}

// ----- Google Sheets store (optional; used when SHEETS_API_URL is set) -----
async function loadSheetConfig() {
  if (!gsheets.enabled()) return false;
  try {
    const devs = gsheets.devicesFromRows(await gsheets.readTab('Devices'));
    if (devs.length) { routers = devs; console.log('[gsheets] loaded ' + devs.length + ' devices'); }
    const users = gsheets.usersFromRows(await gsheets.readTab('Users'));
    if (users.length) { AUTH = { users }; console.log('[gsheets] loaded ' + users.length + ' users'); }
    return true;
  } catch (e) { console.warn('[gsheets] load failed: ' + e.message); return false; }
}
function pushUsersToSheet() {
  if (!gsheets.enabled()) return;
  gsheets.replaceTab('Users', gsheets.usersToRows(AUTH.users)).catch(e => console.warn('[gsheets] push users: ' + e.message));
}
function pushDevicesToSheet() {
  if (!gsheets.enabled()) return;
  gsheets.replaceTab('Devices', gsheets.devicesToRows(routers)).catch(e => console.warn('[gsheets] push devices: ' + e.message));
}

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const sessions = new Map(); // token -> { username, expires }
const SESSION_COOKIE = 'akij_sid';

function getSessionToken(req) {
  const c = req.headers.cookie || '';
  for (const part of c.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === SESSION_COOKIE) return v;
  }
  return null;
}

function isAuthed(req) {
  const token = getSessionToken(req);
  if (!token) return false;
  const s = sessions.get(token);
  if (!s) return false;
  if (Date.now() > s.expires) { sessions.delete(token); return false; }
  return true;
}

function requireAuth(req, res) {
  if (isAuthed(req)) return true;
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
  return false;
}

function currentUser(req) {
  const token = getSessionToken(req);
  const s = token ? sessions.get(token) : null;
  return s ? findUser(s.username) : null;
}

function requireAdmin(req, res) {
  if (!requireAuth(req, res)) return null;
  const u = currentUser(req);
  if (!u || (u.role || 'user') !== 'admin') {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Admin access required.' }));
    return null;
  }
  return u;
}

function toArr(o) { return o.split('.').map(Number); }

function newSession(host, snmpPort) {
  const s = new snmp.Session({ host, port: snmpPort || PORT, community: COMMUNITY, timeout: 6000, retries: 2 });
  // snmp-native emits an 'error' event on malformed packets. With no listener,
  // Node turns that into an uncaughtException and the whole server can die.
  // Swallow per-device errors so one bad device can't take the dashboard down.
  s.on('error', () => {});
  return s;
}

function decode(v) {
  if (v == null) return undefined;
  if (Buffer.isBuffer(v)) return v.toString('latin1');
  if (typeof v === 'number') return v;
  return String(v);
}

function snmpGet(session, oidStr, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(undefined); } }, (timeoutMs || 3000) + 300);
    session.get({ oid: toArr(oidStr) }, (error, varbinds) => {
      if (done) return; done = true; clearTimeout(t);
      if (error || !varbinds || !varbinds.length) return resolve(undefined);
      resolve(decode(varbinds[0].value));
    });
  });
}

async function snmpGetMany(host, oidStrs, snmpPort) {
  const CONCURRENCY = 8;
  const results = new Array(oidStrs.length);
  let idx = 0;
  async function worker() {
    while (idx < oidStrs.length) {
      const i = idx++;
      const s = newSession(host, snmpPort);
      results[i] = await snmpGet(s, oidStrs[i]);
      try { s.close(); } catch (e) {}
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return oidStrs.map((oid, i) => ({ oid, value: results[i] }));
}

function num(v) {
  if (v == null) return null;
  if (v instanceof Buffer) return Number(v.readUInt32BE(0));
  return Number(v);
}

async function snmpScanIfDescr(host, maxIdx, snmpPort) {
  const names = {};
  const maxIdxN = maxIdx || 70;
  const oidList = [];
  for (let i = 1; i <= maxIdxN; i++) oidList.push('1.3.6.1.2.1.2.2.1.2.' + i);
  const res = await snmpGetMany(host, oidList, snmpPort);
  for (const r of res) {
    if (r.value == null || r.value === 'noSuchObject' || r.value === 'noSuchInstance') continue;
    const oidParts = r.oid.split('.');
    const idx = parseInt(oidParts[oidParts.length - 1], 10);
    if (!isNaN(idx)) names[idx] = String(r.value);
  }
  return names;
}

// Bounded manual getNext walk (avoids snmp-native getSubtree recursion issues)
function snmpWalkIndexed(host, rootStr, snmpPort) {
  return new Promise((resolve) => {
    const s = newSession(host, snmpPort);
    const out = {};
    const rootArr = toArr(rootStr);
    let current = rootArr;
    let steps = 0;
    const MAX = 300;
    let done = false;
    const guard = setTimeout(() => { if (!done) { done = true; try { s.close(); } catch (e) {} resolve(out); } }, 15000);

    function step() {
      if (done) return;
      if (steps++ > MAX) { done = true; clearTimeout(guard); try { s.close(); } catch (e) {} return resolve(out); }
      s.getNext({ oid: current }, (error, varbinds) => {
        if (done) return;
        if (error || !varbinds || !varbinds.length) {
          done = true; clearTimeout(guard); try { s.close(); } catch (e) {} return resolve(out);
        }
        const x = varbinds[0];
        const oidArr = x.oid;
        const oidStr = oidArr.join('.');
        if (oidStr.indexOf(rootStr) !== 0) {
          done = true; clearTimeout(guard); try { s.close(); } catch (e) {} return resolve(out);
        }
        let val = decode(x.value);
        if (val !== undefined && val !== 'noSuchObject' && val !== 'noSuchInstance' && val !== 'endOfMibView') {
          const idx = parseInt(oidArr[oidArr.length - 1], 10);
          if (!isNaN(idx)) out[idx] = String(val);
        }
        current = oidArr;
        step();
      });
    }
    step();
  });
}

function fmtUptime(cs) {
  let s = Math.floor(cs / 100);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

function fmtBps(n) {
  if (n == null || isNaN(n)) return '--';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' Gbps';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + ' Mbps';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + ' Kbps';
  return n.toFixed(0) + ' bps';
}
function fmtBytes(n) {
  if (n == null || isNaN(n)) return '--';
  if (n >= 1e12) return (n / 1e12).toFixed(2) + ' TB';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + ' MB';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + ' KB';
  return n.toFixed(0) + ' B';
}

let state = [];
function buildState() {
  state = routers.map(r => ({
    id: r.id, name: r.name, isp: r.isp, location: r.location, ip: r.ip,
    type: r.type || 'snmp',
    vendor: 'unknown',
    snmpPort: r.snmpPort || null,
    nvr: r.nvr || null,
    online: false, version: null, model: null, upText: null, upSeconds: 0,
    lastSeen: 0, error: null, latency: null,
    cpu: null, memTotal: null, memFree: null, totalRx: 0, totalTx: 0,
    interfaces: [],
    hist: [], prev: {}, _camCache: null
  }));
}
buildState();

async function pingHost(rs, timeoutMs) {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    const timeout = timeoutMs || 3000;
    const isWin = process.platform === 'win32';
    const cmd = isWin
      ? `ping -n 1 -w ${Math.floor(timeout)} ${rs.ip}`
      : `ping -c 1 -W ${Math.max(1, Math.floor(timeout / 1000))} ${rs.ip}`;
    let done = false;
    const killer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeout + 1500);
    exec(cmd, { windowsHide: true }, (error, stdout) => {
      if (done) return; done = true; clearTimeout(killer);
      const out = String(stdout);
      const m = out.match(/time[=<]\s*([0-9.]+)\s*ms/i);
      const reachable = /ttl=/i.test(out) || (error == null && !!m);
      if (!reachable) return resolve(null);
      resolve(m ? Math.round(parseFloat(m[1])) : 0);
    });
  });
}

// TCP reachability check (used for NVRs / any host whose ICMP is blocked).
function tcpCheck(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const net = require('net');
    const timeout = timeoutMs || 3000;
    const start = Date.now();
    const sock = new net.Socket();
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (e) {} resolve(v); };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(Date.now() - start));
    sock.once('timeout', () => finish(null));
    sock.once('error', () => finish(null));
    try { sock.connect(port, host); } catch (e) { finish(null); }
  });
}

async function collectInterfaces(routerState) {
  if (routerState.type === 'ping') return;
  let names = null;
  // quick reachability check — skip full scan if device is down
  try {
    const rchk = newSession(routerState.ip, routerState.snmpPort);
    const up = await snmpGet(rchk, '1.3.6.1.2.1.1.3.0', 1500);
    try { rchk.close(); } catch (e) {}
    if (up === undefined) return;
  } catch (e) { return; }
  try {
    const chk = newSession(routerState.ip, routerState.snmpPort);
    const vChk = await snmpGet(chk, '1.3.6.1.4.1.14988.1.1.7.7.0', 1500);
    try { chk.close(); } catch (e) {}
    if (vChk != null && String(vChk) !== 'noSuchObject') {
      names = await snmpWalkIndexed(routerState.ip, '1.3.6.1.4.1.14988.1.1.14.1.1.2', routerState.snmpPort);
      if (Object.keys(names).length === 0) names = null;
    }
  } catch (e) { names = null; }
  if (!names) {
    try {
      names = await snmpScanIfDescr(routerState.ip, 70, routerState.snmpPort);
    } catch (e) { names = {}; }
  }
  names = names || {};
  const ifs = Object.keys(names).map(k => parseInt(k, 10)).filter(Number.isInteger).sort((a, b) => a - b);
  routerState.interfaces = ifs.map(i => ({
    idx: i, name: names[i], oper: 0, rx: 0, tx: 0, rxRate: null, txRate: null
  }));
}

async function pollRouter(rs) {
  if (rs.type === 'ping') {
    // NVRs / port-forwarded hosts: check the TCP port (ICMP is often blocked).
    const ms = rs.nvr ? await tcpCheck(rs.ip, rs.nvr.port || 80) : await pingHost(rs);
    if (ms == null) {
      if (rs.lastSeen && (Date.now() - rs.lastSeen) > GRACE_MS) {
        rs.online = false;
        rs.error = 'ping timeout';
      } else {
        rs.error = 'checking...';
      }
      rs.latency = null;
    } else {
      rs.online = true;
      rs.error = null;
      rs.latency = ms;
      rs.lastSeen = Date.now();
    }
    return;
  }
  try {
    const uptimeStr = '1.3.6.1.2.1.1.3.0';
    const versionStr = '1.3.6.1.4.1.14988.1.1.7.7.0';
    const descrStr = '1.3.6.1.2.1.1.1.0';
    const ifs = rs.interfaces;
    const oids = [uptimeStr, descrStr];
    const meta = [];
    for (const it of ifs) {
      meta.push({ idx: it.idx, oper: `1.3.6.1.2.1.2.2.1.8.${it.idx}`, rx: `1.3.6.1.2.1.2.2.1.10.${it.idx}`, tx: `1.3.6.1.2.1.2.2.1.16.${it.idx}` });
      oids.push(meta[meta.length - 1].oper, meta[meta.length - 1].rx, meta[meta.length - 1].tx);
    }
    const res = await snmpGetMany(rs.ip, oids, rs.snmpPort);
    const byOid = {};
    for (const r of res) byOid[r.oid] = r.value;
    const upcs = byOid[uptimeStr];
    const descn = byOid[descrStr];
    if (upcs === undefined && descn === undefined) { throw new Error('no response'); }
    // version is a MikroTik-private OID; query separately so failures on
    // non-MikroTik devices do not abort the whole poll
    let vern = undefined;
    try {
      const vs = newSession(rs.ip, rs.snmpPort);
      vern = await snmpGet(vs, versionStr, 1500);
      try { vs.close(); } catch (e) {}
    } catch (e) { vern = undefined; }

    rs.online = true;
    rs.lastSeen = Date.now();
    rs.error = null;
    const upCs = num(upcs);
    rs.upSeconds = upCs != null && !isNaN(upCs) ? Math.floor(upCs / 100) : 0;
    rs.upText = fmtUptime(upCs);
    rs.version = vern && String(vern) !== 'noSuchObject' ? vern : null;
    rs.model = descn;
    if (!rs.version && rs.model) {
      const vm = String(rs.model).match(/(?:^|\s)(\d+\.\d+(?:\.\d+)?)/);
      if (vm) rs.version = 'FW ' + vm[1];
    }
    if (String(rs.model).toLowerCase().indexOf('ubiquiti') >= 0) {
      rs.vendor = 'ubiquiti';
    } else if (String(rs.model).toLowerCase().indexOf('routeros') >= 0) {
      rs.vendor = 'mikrotik';
    } else if (/cbs|catalyst|cisco|sg3\d+|meraki/i.test(String(rs.model))) {
      rs.vendor = 'cisco';
    } else {
      rs.vendor = 'other';
    }

    const now = Date.now();
    // CPU / Memory via standard HOST-RESOURCES-MIB (works on MikroTik, Linux, Cisco...)
    rs.cpu = null; rs.memTotal = null; rs.memFree = null;
    if (rs.online) {
      try {
        // CPU: hrProcessorLoad per core -> overall = busiest core
        const cores = await snmpWalkIndexed(rs.ip, '1.3.6.1.2.1.25.3.3.1.2', rs.snmpPort);
        const loads = Object.values(cores).map(Number).filter((n) => !isNaN(n));
        if (loads.length) rs.cpu = Math.max.apply(null, loads);

        // Memory: pick the "memory/ram" row from hrStorageTable
        const descr = await snmpWalkIndexed(rs.ip, '1.3.6.1.2.1.25.2.3.1.3', rs.snmpPort);
        let memIdx = null;
        for (const k of Object.keys(descr)) { if (/memory|ram/i.test(String(descr[k]))) { memIdx = k; break; } }
        if (memIdx != null) {
          const allocStr = '1.3.6.1.2.1.25.2.3.1.4.' + memIdx;
          const sizeStr = '1.3.6.1.2.1.25.2.3.1.5.' + memIdx;
          const usedStr = '1.3.6.1.2.1.25.2.3.1.6.' + memIdx;
          const res2 = await snmpGetMany(rs.ip, [allocStr, sizeStr, usedStr], rs.snmpPort);
          const mm = {}; for (const r of res2) mm[r.oid] = r.value;
          const unit = num(mm[allocStr]) || 1;
          const sizeU = num(mm[sizeStr]);
          const usedU = num(mm[usedStr]);
          if (sizeU != null && !isNaN(sizeU) && sizeU > 0) {
            const total = sizeU * unit;
            const used = (usedU != null && !isNaN(usedU) ? usedU : 0) * unit;
            rs.memTotal = total;
            rs.memFree = total - used;
          }
        }
      } catch (e) { /* leave CPU/mem null if unsupported */ }
    }

    // history for graphs
    const totalRx = ifs.reduce((a, it) => a + (it.rx || 0), 0);
    const totalTx = ifs.reduce((a, it) => a + (it.tx || 0), 0);
    const histItem = {
      t: now,
      rxRate: ifs.reduce((a, it) => a + (it.rxRate || 0), 0),
      txRate: ifs.reduce((a, it) => a + (it.txRate || 0), 0),
      cpu: rs.cpu,
      memUsed: (rs.memTotal != null && rs.memFree != null) ? ((rs.memTotal - rs.memFree) / (rs.memTotal || 1) * 100) : null
    };
    rs.hist.push(histItem);
    if (rs.hist.length > 60) rs.hist.shift();
    rs.totalRx = totalRx; rs.totalTx = totalTx;

    for (let i = 0; i < ifs.length; i++) {
      const it = ifs[i];
      const m = meta[i];
      const prev = rs.prev[it.idx] || {};
      const dt = Math.max((now - (prev.t || now)) || 1000, 500);
      const rx = num(byOid[m.rx]); const tx = num(byOid[m.tx]);
      it.oper = num(byOid[m.oper]);
      if (prev.rx != null && rx != null) {
        let dr = rx - prev.rx; if (dr < 0) dr += 4294967296;
        it.rxRate = (dr * 8) / (dt / 1000);
      } else {
        it.rxRate = null;
      }
      if (prev.tx != null && tx != null) {
        let dtr = tx - prev.tx; if (dtr < 0) dtr += 4294967296;
        it.txRate = (dtr * 8) / (dt / 1000);
      } else {
        it.txRate = null;
      }
      rs.prev[it.idx] = { t: now, rx, tx };
      it.rx = rx; it.tx = tx;
    }
  } catch (e) {
    if (rs.lastSeen && (Date.now() - rs.lastSeen) > GRACE_MS) {
      rs.online = false;
      rs.error = e.message || String(e);
    } else {
      rs.error = 'checking...';
    }
    console.log('POLLERR', rs.ip, e && (e.stack || e.message || e));
    rs.version = null; rs.upText = null;
    rs.interfaces.forEach(it => it.rxRate = null);
  }
}

async function pollAll() {
  for (const rs of state) {
    try { if (rs.interfaces.length === 0) await collectInterfaces(rs); } catch (e) {}
  }
  await Promise.all(state.map(rs => pollRouter(rs).catch(e => {})));
}

let cachedJson = '';
function serialize() {
  const payload = state.map(rs => ({
    id: rs.id, name: rs.name, isp: rs.isp, location: rs.location, ip: rs.ip,
    type: rs.type,
    vendor: rs.vendor,
    hasNvr: !!rs.nvr,
    online: rs.online, version: rs.version, model: rs.model, upText: rs.upText,
    upSeconds: rs.upSeconds, lastSeen: rs.lastSeen, error: rs.error, latency: rs.latency,
    cpu: rs.cpu, memTotal: rs.memTotal, memFree: rs.memFree,
    totalRx: rs.totalRx, totalTx: rs.totalTx,
    hist: rs.hist,
    interfaces: rs.interfaces.map(it => ({
      idx: it.idx, name: it.name, oper: it.oper,
      rx: prettyNum(it.rx), tx: prettyNum(it.tx),
      rxBytes: it.rx, txBytes: it.tx,
      rxRate: prettyRate(it.rxRate), txRate: prettyRate(it.txRate)
    }))
  }));
  cachedJson = JSON.stringify({ generated: Date.now(), pollMs: POLL_MS, routers: payload });
}
function saveHistory(r) {
  if (r.type === 'ping' || !r.interfaces.length) return;
  try {
    const entry = { t: Date.now(), ifs: {} };
    for (const it of r.interfaces) {
      if (it.rx != null && it.tx != null) entry.ifs[it.idx] = { rx: it.rx, tx: it.tx };
    }
    if (Object.keys(entry.ifs).length === 0) return;
    if (!fs.existsSync(HIST_DIR)) fs.mkdirSync(HIST_DIR, { recursive: true });
    const fp = path.join(HIST_DIR, r.id + '.json');
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { arr = []; }
    arr.push(entry);
    if (arr.length > HISTORY_MAX) arr = arr.slice(arr.length - HISTORY_MAX);
    fs.writeFileSync(fp, JSON.stringify(arr));
  } catch (e) {}
}

function prettyRate(n){ return n==null?null:fmtBps(n); }
function prettyNum(n){ return n==null?null:fmtBytes(n); }

function readHistory(id) {
  const fp = path.join(HIST_DIR, id + '.json');
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { return []; }
}

function historySeries(id, ifaceIdx, seconds) {
  const arr = readHistory(id);
  const since = Date.now() - seconds * 1000;
  const pts = arr.filter(e => e.t >= since && e.ifs && e.ifs[ifaceIdx]);
  const out = [];
  const STEP = pts.length > 500 ? Math.ceil(pts.length / 500) : 1;
  let prev = null;
  for (let i = 0; i < pts.length; i++) {
    const e = pts[i];
    const cur = e.ifs[ifaceIdx];
    if (prev) {
      const dt = (e.t - prev.t) / 1000;
      if (dt > 0) {
        let drx = cur.rx - prev.rx; if (drx < 0) drx += 4294967296;
        let dtx = cur.tx - prev.tx; if (dtx < 0) dtx += 4294967296;
        if (i % STEP === 0) {
          out.push({ t: e.t, rx: (drx * 8) / dt, tx: (dtx * 8) / dt });
        }
      }
    }
    prev = { t: e.t, rx: cur.rx, tx: cur.tx };
  }
  return out;
}

/* =====================================================================
   Hikvision NVR (ISAPI) camera discovery
   Uses HTTP Digest auth against the NVR ISAPI endpoint to list the
   connected camera channels and their online/offline status.
   ===================================================================== */
function md5hex(s) { return crypto.createHash('md5').update(s).digest('hex'); }

function parseDigestHeader(header) {
  const p = {};
  const m = String(header || '').match(/Digest\s+(.*)/i);
  if (!m) return null;
  m[1].replace(/(\w+)="?([^",]+)"?/g, (_, k, v) => { p[k] = v; });
  return p;
}

function isapiRequest(host, port, user, pass, path) {
  function doReq(auth) {
    return new Promise((resolve) => {
      const headers = auth ? { Authorization: auth } : {};
      const req = http.get({ host, port, path: path, headers: headers, timeout: 8000 }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
      });
      req.on('error', (e) => resolve({ status: -1, body: '', err: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ status: -1, body: '', err: 'timeout' }); });
    });
  }
  return doReq(null).then((first) => {
    if (first.status !== 401) return first;
    const ch = parseDigestHeader(first.headers['www-authenticate'] || '');
    if (!ch) return first;
    const HA1 = md5hex(user + ':' + ch.realm + ':' + pass);
    const HA2 = md5hex('GET:' + path);
    const nc = '00000001';
    const cnonce = crypto.randomBytes(8).toString('hex');
    const response = ch.qop
      ? md5hex([HA1, ch.nonce, nc, cnonce, ch.qop, HA2].join(':'))
      : md5hex([HA1, ch.nonce, HA2].join(':'));
    let auth = 'Digest username="' + user + '", realm="' + ch.realm + '", nonce="' + ch.nonce + '", uri="' + path + '", response="' + response + '", algorithm=MD5';
    if (ch.qop) auth += ', qop=' + ch.qop + ', nc=' + nc + ', cnonce="' + cnonce + '"';
    if (ch.opaque) auth += ', opaque="' + ch.opaque + '"';
    return doReq(auth);
  });
}

function parseNvrChannels(xml) {
  const out = [];
  const re = /<InputProxyChannel>([\s\S]*?)<\/InputProxyChannel>/g;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[1];
    out.push({
      id: Number((b.match(/<id>(\d+)<\/id>/) || [])[1]) || 0,
      name: (b.match(/<name>([^<]*)<\/name>/) || [])[1] || '',
      ip: (b.match(/<ipAddress>([^<]*)<\/ipAddress>/) || [])[1] || '',
      model: (b.match(/<model>([^<]*)<\/model>/) || [])[1] || '',
      online: null
    });
  }
  return out;
}

function parseNvrStatus(xml) {
  const st = {};
  const re = /<InputProxyChannelStatus>([\s\S]*?)<\/InputProxyChannelStatus>/g;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[1];
    const id = (b.match(/<id>(\d+)<\/id>/) || [])[1];
    const online = (b.match(/<online>(true|false)<\/online>/) || [])[1];
    if (id) st[id] = online === 'true';
  }
  return st;
}

function parseHddList(xml) {
  const out = [];
  const re = /<hdd>([\s\S]*?)<\/hdd>/g;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[1];
    const grab = (tag) => (b.match(new RegExp('<' + tag + '>([^<]*)</' + tag + '>')) || [])[1] || '';
    const id = parseInt(grab('id'), 10) || 0;
    const status = grab('status');
    const capMB = parseInt(grab('capacity'), 10) || 0;
    const freeMB = parseInt(grab('freeSpace'), 10) || 0;
    let st;
    if (status === 'ok') st = 'healthy';
    else if (status === 'notexist' || status === 'abnormal' && capMB === 0) st = 'empty';
    else st = 'warning';
    out.push({
      id: id, name: grab('hddName'), model: grab('hddModel'),
      capacityMB: capMB, freeMB: freeMB, status: st, type: grab('hddType')
    });
  }
  return out;
}

const CAMERA_META_FILE = path.join(__dirname, 'camera-meta.json');
function loadCameraMeta() {
  try { return JSON.parse(fs.readFileSync(CAMERA_META_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveCameraMeta(m) {
  try { fs.writeFileSync(CAMERA_META_FILE, JSON.stringify(m, null, 2)); } catch (e) {}
}

async function getNvrCameras(rs) {
  if (!rs.nvr) return null;
  const now = Date.now();
  if (rs._camCache && (now - rs._camCache.t) < 10000) return rs._camCache.data;
  const { port, user, pass, brand } = rs.nvr;
  try {
    const info = await isapiRequest(rs.ip, port, user, pass, '/ISAPI/System/deviceInfo');
    const caps = await isapiRequest(rs.ip, port, user, pass, '/ISAPI/System/capabilities');
    const list = await isapiRequest(rs.ip, port, user, pass, '/ISAPI/ContentMgmt/InputProxy/channels');
    if (list.status !== 200) throw new Error('channels HTTP ' + list.status + (list.err ? ' ' + list.err : ''));
    const status = await isapiRequest(rs.ip, port, user, pass, '/ISAPI/ContentMgmt/InputProxy/channels/status');
    const sysStatus = await isapiRequest(rs.ip, port, user, pass, '/ISAPI/System/status');
    const storage = await isapiRequest(rs.ip, port, user, pass, '/ISAPI/ContentMgmt/Storage');

    const model = info.status === 200 ? ((info.body.match(/<model>([^<]*)<\/model>/) || [])[1] || '') : '';
    const serialNumber = info.status === 200 ? ((info.body.match(/<serialNumber>([^<]*)<\/serialNumber>/) || [])[1] || '') : '';
    const firmwareVersion = info.status === 200 ? ((info.body.match(/<firmwareVersion>([^<]*)<\/firmwareVersion>/) || [])[1] || '') : '';
    const capacity = caps.status === 200 ? (parseInt((caps.body.match(/<inputProxyNums>(\d+)<\/inputProxyNums>/) || [])[1], 10) || 0) : 0;

    // resource / status parsing
    const upSec = sysStatus.status === 200 ? (parseInt((sysStatus.body.match(/<deviceUpTime>(\d+)<\/deviceUpTime>/) || [])[1], 10) || 0) : 0;
    const memUsed = sysStatus.status === 200 ? (parseFloat((sysStatus.body.match(/<memoryUsage>([^<]*)<\/memoryUsage>/) || [])[1])) : NaN;
    const memAvail = sysStatus.status === 200 ? (parseFloat((sysStatus.body.match(/<memoryAvailable>([^<]*)<\/memoryAvailable>/) || [])[1])) : NaN;
    const cpuUtil = sysStatus.status === 200 ? (parseFloat((sysStatus.body.match(/<cpuUtilization>([^<]*)<\/cpuUtilization>/) || [])[1])) : NaN;
    const ramTotalMB = (isFinite(memUsed) && isFinite(memAvail)) ? (memUsed + memAvail) : 0;
    const ramPercent = ramTotalMB > 0 ? Math.round((memUsed / ramTotalMB) * 100) : null;

    const hdds = storage.status === 200 ? parseHddList(storage.body) : [];
    let storageTotalMB = 0, storageFreeMB = 0;
    for (const h of hdds) { storageTotalMB += h.capacityMB; storageFreeMB += h.freeMB; }
    const storagePercent = storageTotalMB > 0 ? Math.round(((storageTotalMB - storageFreeMB) / storageTotalMB) * 100) : null;
    // HDD slot count — Hikvision model encodes bays, e.g. "DS-8664NXI-I8/S" -> 8
    const slotMatch = model.match(/-([A-Z])(\d+)/i);
    const totalSlots = slotMatch ? parseInt(slotMatch[2], 10) : (hdds.length ? Math.max.apply(null, hdds.map(h => h.id)) : 0);
    const connectedSlots = hdds.filter(h => h.status === 'healthy' && h.capacityMB > 0).length;

    const cams = parseNvrChannels(list.body);
    const st = (status.status === 200) ? parseNvrStatus(status.body) : {};
    const meta = (loadCameraMeta()[rs.id]) || {};
    for (const c of cams) {
      c.online = (c.id in st) ? st[c.id] : null;
      c.recording = c.online === true; // fallback: online cameras are recording
      const m = meta[c.id];
      c.alias = (m && m.alias) ? m.alias : '';
      if (c.alias) c.name = c.alias;
      c.hidden = !!(m && m.hidden);
      // Per-camera video source. Leave empty for the mock CCTV placeholder, or
      // set an HLS (.m3u8) / MP4 / WebRTC-playable URL (also overridable via
      // camera-meta.json) and the card renders it in an HTML5 <video>.
      c.source = (m && m.source) || '';
      c.sourceType = c.source ? 'stream' : 'mock';
      // Hikvision sub-stream path — useful when wiring a real transcriber later.
      c.rtspPath = '/Streaming/Channels/' + String(c.id).padStart(2, '0') + '02';
    }
    const visible = cams.filter(c => !c.hidden);
    const cap = capacity || cams.length;
    const data = {
      id: rs.id, name: rs.name, model: model, brand: brand || 'hikvision',
      serialNumber: serialNumber, firmwareVersion: firmwareVersion,
      ip: rs.ip, port: port, online: rs.online, latency: rs.latency,
      capacity: cap,
      count: visible.length,
      onlineCount: visible.filter(c => c.online === true).length,
      offlineCount: visible.filter(c => c.online === false).length,
      freeCh: Math.max(0, cap - visible.length),
      hiddenCount: cams.length - visible.length,
      uptimeSeconds: upSec,
      cpuUsage: isFinite(cpuUtil) ? Math.round(cpuUtil) : null,
      ram: { usedMB: Math.round(memUsed) || 0, totalMB: Math.round(ramTotalMB) || 0, percent: ramPercent },
      storage: { totalMB: storageTotalMB, freeMB: storageFreeMB, percent: storagePercent },
      hdds: hdds, totalSlots: totalSlots, connectedSlots: connectedSlots,
      cameras: cams, updated: now
    };
    rs._camCache = { t: now, data: data };
    return data;
  } catch (e) {
    const data = { id: rs.id, name: rs.name, error: e.message || String(e), cameras: [], count: 0, onlineCount: 0, offlineCount: 0, updated: now };
    rs._camCache = { t: now - 45000, data: data }; // retry sooner on error
    return data;
  }
}

const server = http.createServer((req, res) => {
  // ----- Auth endpoints -----
  if (req.url === '/api/login' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let d = {};
      try { d = JSON.parse(body || '{}'); } catch (e) {}
      const u = String(d.username || '').trim();
      const p = String(d.password || '');
      const user = findUser(u);
      if (user && user.password === p) {
        const token = crypto.randomBytes(24).toString('hex');
        sessions.set(token, { username: user.username, expires: Date.now() + SESSION_TTL_MS });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
        });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid username or password.' }));
      }
    });
    return;
  }
  if (req.url === '/api/logout' && req.method === 'POST') {
    const token = getSessionToken(req);
    if (token) sessions.delete(token);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Protect API endpoints
  if (req.url === '/api/data' || req.url === '/api/add' || req.url === '/api/remove' ||
      (req.url && (req.url.indexOf('/api/history') === 0 || req.url.indexOf('/api/nvr') === 0 || req.url.indexOf('/api/camera-meta') === 0))) {
    if (!requireAuth(req, res)) return;
  }

  // Current user info
  if (req.url === '/api/me' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    const u = currentUser(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      username: u ? u.username : '',
      displayName: u ? (u.displayName || u.username) : '',
      role: u ? (u.role || 'user') : 'user'
    }));
    return;
  }

  // Change own password
  if (req.url === '/api/change-password' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const u = currentUser(req);
      let d = {}; try { d = JSON.parse(body || '{}'); } catch (e) {}
      const cur = String(d.currentPassword || '');
      const next = String(d.newPassword || '');
      if (!u) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' })); }
      if (u.password !== cur) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'Current password is incorrect.' })); }
      if (next.length < 4) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'New password must be at least 4 characters.' })); }
      u.password = next;
      saveAuth();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // ----- User management (admin only) -----
  if (req.url === '/api/users' && req.method === 'GET') {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, users: AUTH.users.map(publicUser), me: admin.username }));
    return;
  }
  if (req.url === '/api/users' && req.method === 'POST') {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let d = {}; try { d = JSON.parse(body || '{}'); } catch (e) {}
      const username = String(d.username || '').trim();
      const password = String(d.password || '');
      const displayName = String(d.displayName || '').trim() || username;
      const role = d.role === 'admin' ? 'admin' : 'user';
      const fail = (msg) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: msg })); };
      if (!username || !password) return fail('Username and password are required.');
      if (findUser(username)) return fail('Username already exists.');
      if (password.length < 4) return fail('Password must be at least 4 characters.');
      AUTH.users.push({ username, password, displayName, role });
      saveAuth();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  if (req.url === '/api/users/update' && req.method === 'POST') {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let d = {}; try { d = JSON.parse(body || '{}'); } catch (e) {}
      const user = findUser(String(d.username || '').trim());
      const fail = (msg, code) => { res.writeHead(code || 400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: msg })); };
      if (!user) return fail('User not found.', 404);
      if (typeof d.displayName === 'string' && d.displayName.trim()) user.displayName = d.displayName.trim();
      if (d.role === 'admin' || d.role === 'user') {
        if ((user.role || 'user') === 'admin' && d.role === 'user' && adminCount() <= 1) return fail('Cannot remove the last admin.');
        user.role = d.role;
      }
      if (typeof d.password === 'string' && d.password) {
        if (d.password.length < 4) return fail('Password must be at least 4 characters.');
        user.password = d.password;
        if (user.username !== admin.username) invalidateUserSessions(user.username);
      }
      saveAuth();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  if (req.url === '/api/users/delete' && req.method === 'POST') {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let d = {}; try { d = JSON.parse(body || '{}'); } catch (e) {}
      const user = findUser(String(d.username || '').trim());
      const fail = (msg, code) => { res.writeHead(code || 400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: msg })); };
      if (!user) return fail('User not found.', 404);
      if (user.username === admin.username) return fail("You can't delete your own account.");
      if ((user.role || 'user') === 'admin' && adminCount() <= 1) return fail('Cannot delete the last admin.');
      AUTH.users = AUTH.users.filter(u => u !== user);
      saveAuth();
      invalidateUserSessions(user.username);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // Aggregate camera counts across all NVRs
  if (req.url === '/api/cameras-summary' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    const nvrs = state.filter(s => s.nvr);
    Promise.all(nvrs.map(getNvrCameras)).then((list) => {
      let total = 0, online = 0, offline = 0, capacity = 0;
      const cameras = [];
      for (const d of list) {
        if (!d || d.error) continue;
        total += d.count || 0;
        online += d.onlineCount || 0;
        offline += d.offlineCount || 0;
        capacity += d.capacity || 0;
        for (const c of (d.cameras || [])) {
          if (c.hidden) continue;
          cameras.push({ nvr: d.name, nvrId: d.id, ch: c.id, name: c.name, ip: c.ip, model: c.model, online: c.online });
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ nvrs: nvrs.length, total, online, offline, capacity, cameras }));
    }).catch((e) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || String(e) }));
    });
    return;
  }

  // NVR camera summary
  if (req.url && req.url.indexOf('/api/nvr') === 0 && req.method === 'GET') {
    const u = new URL(req.url, 'http://x');
    const id = u.searchParams.get('id');
    const rs = state.find(s => s.id === id);
    if (!rs || !rs.nvr) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not an NVR device' }));
      return;
    }
    getNvrCameras(rs).then((data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    }).catch((e) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || String(e) }));
    });
    return;
  }

  // Update a camera's local metadata (alias / hidden)
  if (req.url === '/api/camera-meta' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const d = JSON.parse(body || '{}');
        const nvrId = String(d.nvr || '');
        const ch = String(d.channel || '');
        if (!nvrId || !ch) throw new Error('nvr and channel required');
        const all = loadCameraMeta();
        all[nvrId] = all[nvrId] || {};
        const cur = all[nvrId][ch] || {};
        if (typeof d.alias === 'string') cur.alias = d.alias;
        if (typeof d.hidden === 'boolean') cur.hidden = d.hidden;
        all[nvrId][ch] = cur;
        saveCameraMeta(all);
        const rs = state.find(s => s.id === nvrId);
        if (rs) rs._camCache = null; // force refresh
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    });
    return;
  }

  if (req.url === '/api/data') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(cachedJson);
    return;
  }
  if (req.url === '/api/add' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const d = JSON.parse(body);
        addDevice(d);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    });
    return;
  }
  if (req.url === '/device' || (req.url && req.url.indexOf('/device?') === 0)) {
    if (!isAuthed(req)) {
      res.writeHead(302, { 'Location': '/login/' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(path.join(__dirname, 'public', 'device.html')));
    return;
  }
  if (req.url === '/nvr' || (req.url && req.url.indexOf('/nvr?') === 0)) {
    if (!isAuthed(req)) {
      res.writeHead(302, { 'Location': '/login/' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(path.join(__dirname, 'public', 'nvr.html')));
    return;
  }
  if (req.url && req.url.indexOf('/api/history') === 0 && req.method === 'GET') {
    const u = new URL(req.url, 'http://x');
    const id = u.searchParams.get('id');
    const ifaceIdx = parseInt(u.searchParams.get('iface'), 10);
    const seconds = Math.min(parseInt(u.searchParams.get('range'), 10) || 86400, 86400 * 3);
    const rs = state.find(s => s.id === id);
    const pts = historySeries(id, ifaceIdx, seconds);
    const name = rs ? (rs.interfaces.find(i => i.idx === ifaceIdx) || {}).name : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id, iface: ifaceIdx, name, seconds, points: pts }));
    return;
  }
  if (req.url === '/api/remove' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const d = JSON.parse(body);
        removeDevice(d.id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    });
    return;
  }
  // Login page (public)
  if (req.url === '/login') {
    res.writeHead(302, { 'Location': '/login/' });
    res.end();
    return;
  }
  if (req.url === '/login/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(path.join(__dirname, 'public', 'login', 'index.html')));
    return;
  }
  // Login static assets (css/js/images) — public
  if (req.url && req.url.indexOf('/login/') === 0) {
    const f = req.url.replace(/^\/login\//, '');
    const fp = path.join(__dirname, 'public', 'login', f);
    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      const ext = path.extname(fp);
      const type = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[ext] || 'text/plain';
      res.writeHead(200, { 'Content-Type': type });
      res.end(fs.readFileSync(fp));
    } else {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  // Main dashboard (protected)
  let file = req.url === '/' ? 'index.html' : req.url.replace(/^\//, '');
  if (!isAuthed(req)) {
    res.writeHead(302, { 'Location': '/login/' });
    res.end();
    return;
  }
  const fp = path.join(__dirname, 'public', file);
  if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    const ext = path.extname(fp);
    const type = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': type });
    res.end(fs.readFileSync(fp));
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

function addDevice(d) {
  const ip = String(d.ip || '').trim();
  if (!ip) throw new Error('IP required');
  const type = d.type === 'ping' ? 'ping' : 'snmp';
  const id = (String(d.id) || ('dev-' + Date.now())).trim();
  const rec = {
    id, name: String(d.name || ip).trim(), isp: String(d.isp || '').trim(),
    location: String(d.location || '').trim(), ip, ...(type === 'ping' ? { type } : {})
  };
  if (state.some(s => s.ip === ip)) throw new Error('IP already exists');
  routers.push(rec);
  try { fs.writeFileSync(path.join(__dirname, 'routers.json'), JSON.stringify(routers, null, 2)); } catch (e) {}
  pushDevicesToSheet();
  state.push({
    id: rec.id, name: rec.name, isp: rec.isp, location: rec.location, ip: rec.ip,
    type: rec.type || 'snmp', vendor: 'unknown',
    online: false, version: null, model: null, upText: null, upSeconds: 0,
    lastSeen: 0, error: null, latency: null, cpu: null, memTotal: null, memFree: null,
    totalRx: 0, totalTx: 0, interfaces: [], hist: [], prev: {}
  });
  collectInterfaces(state[state.length - 1]);
  pollRouter(state[state.length - 1]);
}

function removeDevice(id) {
  const i = state.findIndex(s => s.id === id);
  if (i < 0) return;
  state.splice(i, 1);
  const ri = routers.findIndex(r => r.id === id);
  if (ri >= 0) routers.splice(ri, 1);
  try { fs.writeFileSync(path.join(__dirname, 'routers.json'), JSON.stringify(routers, null, 2)); } catch (e) {}
  pushDevicesToSheet();
}

(async () => {
  console.log('Collecting initial interface data...');
  try { await loadSheetConfig(); buildState(); } catch (e) { console.warn('[gsheets] config load skipped: ' + (e && e.message)); }
  try { await pollAll(); } catch (e) { console.error('pollAll error', e); }
  serialize();
  console.log('Dashboard ready at http://localhost:' + PORT_HTTP);
  server.listen(PORT_HTTP, () => {
    console.log('Server listening on port ' + PORT_HTTP);
  });
  setInterval(async () => {
    try { await pollAll(); } catch (e) { console.error('pollAll error', e); }
    serialize();
  }, POLL_MS);
  setInterval(() => {
    for (const rs of state) saveHistory(rs);
  }, HISTORY_SAMPLE_MS);
})();

process.on('uncaughtException', (e) => {
  console.error('uncaughtException', e && (e.stack || e.message || e));
});
process.on('unhandledRejection', (e) => {
  console.error('unhandledRejection', e && (e.stack || e.message || e));
});

// When launched as a background service (run-dashboard.bat), ignore Ctrl+C so a
// parent terminal/console closing can't stop the dashboard. Manual runs via
// start.bat keep normal Ctrl+C behaviour (env var is not set there).
if (process.env.AKIJ_DASH_IGNORE_SIGINT === '1') {
  process.on('SIGINT', () => {});
  process.on('SIGBREAK', () => {});
}

