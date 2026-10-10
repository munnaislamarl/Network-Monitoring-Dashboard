/**
 * AEL NOC — Google Sheet API (Apps Script Web App)
 * ------------------------------------------------------------
 * এই পুরো কোডটা আপনার Sheet-এর Apps Script এ পেস্ট করে
 * "Web App" হিসেবে deploy করবেন:
 *   Deploy → Manage deployments → (pencil) Edit →
 *   Version: New version · Execute as: Me · Who has access: Anyone → Deploy
 * এরপর প্রতিটি request-এ ?token=<TOKEN> দিতে হবে (GitHub secret SHEETS_TOKEN)।
 */

var TOKEN = 'AEL-NOC-k9F3p2qLz7R4t'; // এটি আপনার GitHub secret SHEETS_TOKEN এর সমান হতে হবে

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
    if (String(p.token || '') !== TOKEN) return json_({ ok: false, error: 'unauthorized' });
    var action = String(p.action || '');
    switch (action) {
      case 'getDevices':    return json_({ ok: true, values: readAll_('Devices') });
      case 'getUsers':      return json_({ ok: true, values: readAll_('Users') });
      case 'getState':      return json_({ ok: true, values: readAll_('State') });
      case 'getHistory':    return json_({ ok: true, values: readHistory_(p.since) });
      case 'appendHistory': return json_({ ok: true, added: appendRows_('History', p.values || []) });
      case 'setState':      return json_({ ok: true, count: replaceRows_('State', p.values || []) });
      case 'setUsers':      return json_({ ok: true, count: replaceRows_('Users', p.values || []) });
      case 'setDevices':    return json_({ ok: true, count: replaceRows_('Devices', p.values || []) });
      case 'setup':         return json_({ ok: true, result: setupNocDashboard() });
      default:              return json_({ ok: false, error: 'unknown action: ' + action });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

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

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/** একবার চালালেই ৪টা tab + হেডার তৈরি হবে */
function setupNocDashboard() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tabs = {
    'Devices': ['id', 'name', 'isp', 'location', 'ip', 'type', 'snmpport', 'nvr_brand', 'nvr_port', 'nvr_user', 'nvr_pass'],
    'Users':   ['username', 'password', 'displayName', 'role'],
    'History': ['ts', 'deviceId', 'ifIdx', 'ifName', 'rxRate', 'txRate'],
    'State':   ['deviceId', 'ifIdx', 'ts', 'rxBytes', 'txBytes']
  };
  Object.keys(tabs).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, tabs[name].length).setValues([tabs[name]]).setFontWeight('bold').setBackground('#eef2f7');
    }
    sh.setFrozenRows(1);
  });
  return 'tabs ready (Devices, Users, History, State)';
}
