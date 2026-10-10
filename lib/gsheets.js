'use strict';
// Google Sheets store via a Google Apps Script Web App (see SHEETS.gs + SHEETS.md).
// Enabled when SHEETS_API_URL is set; otherwise the app falls back to
// routers.json / auth.json / local history (unchanged behaviour).
const API_URL = process.env.SHEETS_API_URL || '';
const TOKEN = process.env.SHEETS_TOKEN || '';

function enabled() { return !!API_URL; }

async function call(action, extra) {
  if (!API_URL) return null;
  const body = JSON.stringify(Object.assign({ action: action, token: TOKEN }, extra || {}));
  const r = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body, redirect: 'follow' });
  const txt = await r.text();
  let j = null;
  try { j = JSON.parse(txt); } catch (e) { throw new Error('bad response from sheet API: ' + txt.slice(0, 120)); }
  if (!j || j.ok === false) throw new Error((j && j.error) || 'sheet API error');
  return j;
}

async function readTab(tab) {
  const map = { Devices: 'getDevices', Users: 'getUsers', State: 'getState', History: 'getHistory' };
  const j = await call(map[tab] || ('get' + tab));
  return (j && j.values) || [];
}
async function appendRows(tab, rows) {
  if (!rows || !rows.length) return 0;
  const j = await call('appendHistory', { values: rows });
  return (j && j.added) || 0;
}
async function replaceTab(tab, values) {
  const map = { State: 'setState', Users: 'setUsers', Devices: 'setDevices' };
  const j = await call(map[tab] || ('set' + tab), { values: values || [] });
  return (j && j.count) || 0;
}

function rowsToObjects(rows) {
  if (!rows || !rows.length) return { header: [], list: [] };
  const header = rows[0].map(h => String(h).trim().toLowerCase());
  const list = rows.slice(1)
    .filter(r => (r || []).some(x => x !== '' && x != null))
    .map(r => { const o = {}; header.forEach((k, i) => o[k] = r[i] == null ? '' : String(r[i]).trim()); return o; });
  return { header, list };
}

const DEV_HEADER = ['id', 'name', 'isp', 'location', 'ip', 'type', 'snmpport', 'nvr_brand', 'nvr_port', 'nvr_user', 'nvr_pass'];
function devicesFromRows(rows) {
  const { list } = rowsToObjects(rows);
  return list.filter(o => o.id || o.ip).map(o => {
    const dev = { id: o.id || o.name, name: o.name || o.id, isp: o.isp || '', location: o.location || '', ip: o.ip || '' };
    if (o.type) dev.type = o.type;
    const sp = parseInt(o.snmpport, 10); if (sp) dev.snmpPort = sp;
    const np = parseInt(o.nvr_port, 10);
    if (np) dev.nvr = { brand: o.nvr_brand || 'hikvision', port: np, user: o.nvr_user || '', pass: o.nvr_pass || '' };
    return dev;
  });
}
function devicesToRows(devices) {
  return [DEV_HEADER].concat((devices || []).map(d => [
    d.id || '', d.name || '', d.isp || '', d.location || '', d.ip || '', d.type || '', d.snmpPort || '',
    d.nvr ? (d.nvr.brand || '') : '', d.nvr ? (d.nvr.port || '') : '', d.nvr ? (d.nvr.user || '') : '', d.nvr ? (d.nvr.pass || '') : ''
  ]));
}

const USER_HEADER = ['username', 'password', 'displayname', 'role'];
function usersFromRows(rows) {
  const { list } = rowsToObjects(rows);
  return list.filter(o => o.username).map(o => ({ username: o.username, password: o.password || '', displayName: o.displayname || o.username, role: o.role || 'user' }));
}
function usersToRows(users) {
  return [USER_HEADER].concat((users || []).map(u => [u.username || '', u.password || '', u.displayName || '', u.role || 'user']));
}

module.exports = {
  enabled, readTab, appendRows, replaceTab, API_URL,
  devicesFromRows, devicesToRows, usersFromRows, usersToRows, DEV_HEADER, USER_HEADER
};
