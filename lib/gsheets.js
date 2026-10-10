'use strict';
// Google Sheets store for Devices, Users and History.
// Enabled only when SHEET_ID + GOOGLE_SERVICE_ACCOUNT (service-account JSON) env vars are set;
// otherwise the app falls back to routers.json / auth.json / local history (unchanged behaviour).
const SHEET_ID = process.env.SHEET_ID || '';
let client = null, inited = false;

function getClient() {
  if (inited) return client;
  inited = true;
  try {
    if (!SHEET_ID || !process.env.GOOGLE_SERVICE_ACCOUNT) return (client = null);
    const { google } = require('googleapis');
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
    const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    client = google.sheets({ version: 'v4', auth });
    console.log('[gsheets] enabled (sheet ' + SHEET_ID + ')');
  } catch (e) { console.warn('[gsheets] init failed: ' + e.message); client = null; }
  return client;
}
function enabled() { return !!getClient(); }

async function readTab(tab) {
  const c = getClient(); if (!c) return [];
  const r = await c.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: tab });
  return r.data.values || [];
}
async function appendRows(tab, rows) {
  const c = getClient(); if (!c || !rows.length) return false;
  await c.spreadsheets.values.append({ spreadsheetId: SHEET_ID, range: tab, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: rows } });
  return true;
}
async function replaceTab(tab, values) {
  const c = getClient(); if (!c) return false;
  await c.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: tab });
  if (values && values.length) {
    await c.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: tab + '!A1', valueInputOption: 'RAW', requestBody: { values } });
  }
  return true;
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
  enabled, readTab, appendRows, replaceTab, getClient, SHEET_ID,
  devicesFromRows, devicesToRows, usersFromRows, usersToRows, DEV_HEADER, USER_HEADER
};
