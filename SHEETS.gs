/**
 * AEL NOC — Google Sheet API (Apps Script Web App)
 * ------------------------------------------------------------
 * এই পুরো কোডটা আপনার Sheet-এর Apps Script এ পেস্ট করে
 * "Web App" হিসেবে deploy করবেন:
 *   Deploy → Manage deployments → (pencil) Edit →
 *   Version: New version · Execute as: Me · Who has access: Anyone → Deploy
 *
 * Tokens:
 *   TOKEN      → পুরো access (GitHub secret SHEETS_TOKEN, server-side)
 *   ADD_TOKEN  → শুধু device add (public site ব্যবহার করে)
 *
 * Session: login সফল হলে ১২ ঘণ্টার session token ফেরত আসে।
 * Admin work (user/request manage) সেই session দিয়ে হয় — secret token ফাঁস হয় না।
 */

var TOKEN = 'AELNOCLTXCgMZ8ARzt975NlsbyIOEeVFHmDWxu'; // full token (app/CI ব্যবহার করে)
var ADD_TOKEN = 'AELADDFWkyHt203zTJs7NbxDdOlKGp';     // add-only token (site ব্যবহার করে)
var SESSION_TTL_MS = 12 * 60 * 60 * 1000;      // session ১২ ঘণ্টা বৈধ

var REQ_HEADER = ['ts', 'username', 'displayName', 'password', 'note', 'status'];
var CAM_HEADER = ['NVRID', 'CH', 'ALIAS', 'HIDDEN', 'SOURCE'];

function doGet(e) { return handle_(e, e.parameter || {}); }

function doPost(e) {
  var p = {};
  try { p = JSON.parse((e.postData && e.postData.contents) || '{}'); } catch (err) { p = {}; }
  var q = e.parameter || {};
  for (var k in q) { if (!(k in p)) p[k] = q[k]; }
  return handle_(e, p);
}

function handle_(e, p) {
  try {
    var action = String(p.action || '');
    var tk = String(p.token || '');

    // ---------------- public (no secret token) ----------------
    if (action === 'login')          return json_(login_(p.username, p.password));
    if (action === 'requestAccess')  return json_(requestAccess_(p.data || {}));
    if (action === 'addDevice') {
      if (tk !== ADD_TOKEN && tk !== TOKEN) return json_({ ok: false, error: 'unauthorized' });
      return json_({ ok: true, added: addDevice_(p.data || {}) });
    }

    // ---------------- session (logged-in user) ----------------
    var sess = getSession_(p.session);
    if (action === 'me') {
      return json_(sess ? { ok: true, user: sess.user } : { ok: false, error: 'unauthorized' });
    }
    if (action === 'logout') {
      if (p.session) delSession_(p.session);
      return json_({ ok: true });
    }
    if (action === 'changePassword') {
      if (!sess) return json_({ ok: false, error: 'unauthorized' });
      return json_(changePassword_(sess.user.username, p.data || {}));
    }
    if (!sess) return json_({ ok: false, error: 'unauthorized' });

    var admin = sess.user.role === 'admin';
    switch (action) {
      case 'listUsers':      return admin ? json_({ ok: true, users: listUsers_() })              : json_({ ok: false, error: 'forbidden' });
      case 'saveUser':       return admin ? json_(saveUser_(p.data || {}))                         : json_({ ok: false, error: 'forbidden' });
      case 'deleteUser':     return admin ? json_(deleteUser_(p.data || {}, sess.user.username))   : json_({ ok: false, error: 'forbidden' });
      case 'listRequests':   return admin ? json_({ ok: true, requests: listRequests_() })         : json_({ ok: false, error: 'forbidden' });
      case 'approveRequest': return admin ? json_(approveRequest_(p.data || {}))                   : json_({ ok: false, error: 'forbidden' });
      case 'rejectRequest':  return admin ? json_(rejectRequest_(p.data || {}))                    : json_({ ok: false, error: 'forbidden' });
    }

    // ---------------- secret token (GitHub Actions / server) ----------------
    if (tk !== TOKEN) return json_({ ok: false, error: 'unauthorized' });
    switch (action) {
      case 'getDevices':    return json_({ ok: true, values: readAll_('Devices') });
      case 'getUsers':      return json_({ ok: true, values: readAll_('Users') });
      case 'getCams':       return json_({ ok: true, values: readAll_('Cams') });
      case 'getState':      return json_({ ok: true, values: readAll_('State') });
      case 'getHistory':    return json_({ ok: true, values: readHistory_(p.since) });
      case 'appendHistory': return json_({ ok: true, added: appendRows_('History', p.values || []) });
      case 'setState':      return json_({ ok: true, count: replaceRows_('State', p.values || []) });
      case 'setUsers':      return json_({ ok: true, count: replaceRows_('Users', p.values || []) });
      case 'setDevices':    return json_({ ok: true, count: replaceRows_('Devices', p.values || []) });
      case 'setCams':       return json_({ ok: true, count: replaceRows_('Cams', p.values || []) });
      case 'setup':         return json_({ ok: true, result: setupNocDashboard() });
      default:              return json_({ ok: false, error: 'unknown action: ' + action });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/* ================= users / auth ================= */

function readUsers_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Users');
  if (!sh || sh.getLastRow() < 2) return [];
  var v = sh.getDataRange().getValues();
  var h = v[0].map(function (x) { return String(x).trim().toLowerCase(); });
  var iu = h.indexOf('username'), ip = h.indexOf('password'), idn = h.indexOf('displayname'), ir = h.indexOf('role');
  if (iu < 0) return [];
  var out = [];
  for (var i = 1; i < v.length; i++) {
    var u = String(v[i][iu] == null ? '' : v[i][iu]).trim();
    if (!u) continue;
    out.push({
      row: i + 1,
      username: u,
      password: String(v[i][ip] == null ? '' : v[i][ip]),
      displayName: String(v[i][idn] == null ? '' : v[i][idn]).trim() || u,
      role: String(v[i][ir] == null ? '' : v[i][ir]).trim() || 'user'
    });
  }
  return out;
}

function login_(username, password) {
  username = String(username || '').trim();
  password = String(password == null ? '' : password);
  if (!username || !password) return { ok: false, error: 'Username and password are required.' };
  var users = readUsers_();
  var lc = username.toLowerCase();
  for (var i = 0; i < users.length; i++) {
    if (users[i].username.toLowerCase() === lc && users[i].password === password) {
      var user = { username: users[i].username, displayName: users[i].displayName, role: users[i].role };
      return { ok: true, session: newSession_(user), user: user };
    }
  }
  return { ok: false, error: 'Invalid username or password.' };
}

function changePassword_(username, d) {
  var cur = String(d.currentPassword == null ? '' : d.currentPassword);
  var np = String(d.newPassword == null ? '' : d.newPassword);
  if (!cur || !np) return { ok: false, error: 'Current and new password are required.' };
  var sh = sheet_('Users');
  var v = sh.getDataRange().getValues();
  var h = v[0].map(function (x) { return String(x).trim().toLowerCase(); });
  var iu = h.indexOf('username'), ip = h.indexOf('password');
  for (var i = 1; i < v.length; i++) {
    if (String(v[i][iu]).trim().toLowerCase() === username.toLowerCase()) {
      if (String(v[i][ip]) !== cur) return { ok: false, error: 'Current password is incorrect.' };
      sh.getRange(i + 1, ip + 1).setValue(np);
      return { ok: true };
    }
  }
  return { ok: false, error: 'User not found.' };
}

function listUsers_() {
  return readUsers_().map(function (u) {
    return { username: u.username, displayName: u.displayName, role: u.role }; // password never sent
  });
}

function saveUser_(d) {
  var username = String(d.username || '').trim();
  if (!username) return { ok: false, error: 'Username is required.' };
  var displayName = String(d.displayName || '').trim() || username;
  var role = (String(d.role || 'user').trim() === 'admin') ? 'admin' : 'user';
  var password = (d.password == null) ? '' : String(d.password);
  var sh = sheet_('Users');
  ensureHeader_(sh, ['username', 'password', 'displayName', 'role']);
  var v = sh.getDataRange().getValues();
  var h = v[0].map(function (x) { return String(x).trim().toLowerCase(); });
  var iu = h.indexOf('username'), ip = h.indexOf('password'), idn = h.indexOf('displayname'), ir = h.indexOf('role');
  for (var i = 1; i < v.length; i++) {
    if (String(v[i][iu]).trim().toLowerCase() === username.toLowerCase()) {
      sh.getRange(i + 1, idn + 1).setValue(displayName);
      sh.getRange(i + 1, ir + 1).setValue(role);
      if (password) sh.getRange(i + 1, ip + 1).setValue(password);
      return { ok: true, updated: true };
    }
  }
  if (!password) return { ok: false, error: 'Password is required for a new user.' };
  sh.appendRow([username, password, displayName, role]);
  return { ok: true, created: true };
}

function deleteUser_(d, me) {
  var username = String(d.username || '').trim();
  if (!username) return { ok: false, error: 'Username is required.' };
  if (me && username.toLowerCase() === String(me).toLowerCase())
    return { ok: false, error: 'You cannot delete your own account.' };
  var users = readUsers_();
  var target = users.filter(function (u) { return u.username.toLowerCase() === username.toLowerCase(); })[0];
  if (!target) return { ok: false, error: 'User not found.' };
  var admins = users.filter(function (u) { return u.role === 'admin'; });
  if (target.role === 'admin' && admins.length <= 1)
    return { ok: false, error: 'Cannot delete the last admin.' };
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Users');
  sh.deleteRow(target.row);
  return { ok: true };
}

/* ================= sessions ================= */

function newSession_(user) {
  var token = Utilities.getUuid().replace(/-/g, '');
  var rec = { user: user, exp: Date.now() + SESSION_TTL_MS };
  PropertiesService.getScriptProperties().setProperty('sess_' + token, JSON.stringify(rec));
  return token;
}

function getSession_(token) {
  token = String(token || '');
  if (!token) return null;
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty('sess_' + token);
  if (!raw) return null;
  var rec;
  try { rec = JSON.parse(raw); } catch (e) { props.deleteProperty('sess_' + token); return null; }
  if (!rec || !rec.exp || rec.exp < Date.now()) { props.deleteProperty('sess_' + token); return null; }
  return rec;
}

function delSession_(token) {
  if (!token) return;
  try { PropertiesService.getScriptProperties().deleteProperty('sess_' + String(token)); } catch (e) {}
}

/* ================= access requests ================= */

function requestsSheet_() {
  var sh = sheet_('Requests');
  ensureHeader_(sh, REQ_HEADER);
  return sh;
}

function readRequests_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Requests');
  if (!sh || sh.getLastRow() < 2) return [];
  var v = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < v.length; i++) {
    if (!String(v[i][1] || '').trim()) continue;
    out.push({
      row: i + 1,
      ts: v[i][0] || '',
      username: String(v[i][1]).trim(),
      displayName: String(v[i][2] == null ? '' : v[i][2]).trim(),
      password: String(v[i][3] == null ? '' : v[i][3]),
      note: String(v[i][4] == null ? '' : v[i][4]).trim(),
      status: (String(v[i][5] || '').trim() || 'pending')
    });
  }
  return out;
}

function requestAccess_(d) {
  var username = String(d.username || '').trim();
  var password = String(d.password == null ? '' : d.password);
  var displayName = String(d.displayName || '').trim() || username;
  var note = String(d.note || '').trim();
  if (!username || !password) return { ok: false, error: 'Username and password are required.' };
  if (username.length < 3) return { ok: false, error: 'Username must be at least 3 characters.' };
  var users = readUsers_();
  for (var i = 0; i < users.length; i++) {
    if (users[i].username.toLowerCase() === username.toLowerCase())
      return { ok: false, error: 'This username is already taken.' };
  }
  var pend = readRequests_().filter(function (r) {
    return r.status === 'pending' && r.username.toLowerCase() === username.toLowerCase();
  });
  if (pend.length) return { ok: false, error: 'A request for this username is already pending.' };
  requestsSheet_().appendRow([Date.now(), username, displayName, password, note, 'pending']);
  return { ok: true };
}

function listRequests_() {
  return readRequests_().filter(function (r) { return r.status === 'pending'; })
    .map(function (r) {
      return { ts: r.ts, username: r.username, displayName: r.displayName, note: r.note };
    });
}

function setRequestStatus_(username, status) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Requests');
  if (!sh || sh.getLastRow() < 2) return false;
  var v = sh.getDataRange().getValues();
  var lc = String(username || '').trim().toLowerCase();
  for (var i = 1; i < v.length; i++) {
    if (String(v[i][1] || '').trim().toLowerCase() === lc &&
        (String(v[i][5] || '').trim() || 'pending') === 'pending') {
      sh.getRange(i + 1, 6).setValue(status);
      return true;
    }
  }
  return false;
}

function approveRequest_(d) {
  var username = String(d.username || '').trim();
  var reqs = readRequests_();
  var req = reqs.filter(function (r) { return r.username.toLowerCase() === username.toLowerCase() && r.status === 'pending'; })[0];
  if (!req) return { ok: false, error: 'Request not found.' };
  var role = (String(d.role || 'user').trim() === 'admin') ? 'admin' : 'user';
  var r = saveUser_({ username: req.username, displayName: req.displayName, password: req.password, role: role });
  if (!r.ok) return r;
  setRequestStatus_(username, 'approved');
  return { ok: true };
}

function rejectRequest_(d) {
  var username = String(d.username || '').trim();
  if (!setRequestStatus_(username, 'rejected')) return { ok: false, error: 'Request not found.' };
  return { ok: true };
}

/* ================= devices ================= */

function slug_(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'device';
}

function genDeviceId_(name) {
  var base = slug_(name);
  var sh = sheet_('Devices');
  var used = {};
  if (sh.getLastRow() >= 1) {
    var v = sh.getDataRange().getValues();
    for (var i = 1; i < v.length; i++) used[String(v[i][0]).trim().toLowerCase()] = true;
  }
  var id = base, n = 1;
  while (used[id.toLowerCase()]) { n++; id = base + '-' + n; }
  return id;
}

function addDevice_(d) {
  var sh = sheet_('Devices');
  ensureHeader_(sh, ['ID', 'NAME', 'ISP', 'LOCATION', 'IP', 'TYPE', 'SNMPPORT', 'NVR_BRAND', 'NVR_PORT', 'DEVICE-USER', 'DEVICE-PASS']);
  var name = String(d.name || '').trim();
  var id = String(d.id || '').trim() || genDeviceId_(name);
  var row = [
    id, name || id, d.isp || '', d.location || '', d.ip || '',
    d.type || '', d.snmpport || '', d.nvr_brand || '', d.nvr_port || '', d.device_user || '', d.device_pass || ''
  ];
  sh.appendRow(row);
  return row;
}

/* ================= shared helpers ================= */

function readAll_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) return [];
  return sh.getDataRange().getValues();
}

function readHistory_(since) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('History');
  if (!sh) return [];
  var v = sh.getDataRange().getValues();
  if (!v.length || !since) return v;
  var s = Number(since);
  var out = [v[0]];
  for (var i = 1; i < v.length; i++) { if (Number(v[i][0]) >= s) out.push(v[i]); }
  return out;
}

function appendRows_(name, rows) {
  if (!rows || !rows.length) return 0;
  var sh = sheet_(name);
  var w = 0; rows.forEach(function (r) { if (r.length > w) w = r.length; });
  rows.forEach(function (r) { while (r.length < w) r.push(''); });
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, w).setValues(rows);
  return rows.length;
}

function replaceRows_(name, values) {
  var sh = sheet_(name);
  sh.clear();
  if (!values || !values.length) return 0;
  var w = 0; values.forEach(function (r) { if (r.length > w) w = r.length; });
  values.forEach(function (r) { while (r.length < w) r.push(''); });
  sh.getRange(1, 1, values.length, w).setValues(values);
  return values.length;
}

function sheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function ensureHeader_(sh, header) {
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#eef2f7');
    sh.setFrozenRows(1);
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/** একবার চালালেই ৫টা tab + হেডার তৈরি হবে */
function setupNocDashboard() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tabs = {
    'Devices': ['ID', 'NAME', 'ISP', 'LOCATION', 'IP', 'TYPE', 'SNMPPORT', 'NVR_BRAND', 'NVR_PORT', 'DEVICE-USER', 'DEVICE-PASS'],
    'Users':   ['username', 'password', 'displayName', 'role'],
    'History': ['ts', 'deviceId', 'ifIdx', 'ifName', 'rxRate', 'txRate'],
    'State':   ['deviceId', 'ifIdx', 'ts', 'rxBytes', 'txBytes'],
    'Requests':REQ_HEADER,
    'Cams':    CAM_HEADER
  };
  Object.keys(tabs).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, tabs[name].length).setValues([tabs[name]]).setFontWeight('bold').setBackground('#eef2f7');
    }
    sh.setFrozenRows(1);
  });
  return 'tabs ready (Devices, Users, History, State, Requests, Cams)';
}