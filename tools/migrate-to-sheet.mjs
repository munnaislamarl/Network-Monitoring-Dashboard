// One-time migration: upload the legacy local config files
// (routers.json / auth.json / camera-meta.json) into the Google Sheet
// (Devices / Users / Cams tabs), making the sheet the single source of truth.
//
// Usage:
//   $env:SHEETS_API_URL = "<web app url>"
//   $env:SHEETS_TOKEN   = "<secret token>"
//   node tools/migrate-to-sheet.mjs            # real migration (replaces tabs)
//   node tools/migrate-to-sheet.mjs --dry-run  # just show what would be sent
//
// WARNING: this REPLACES the Devices / Users / Cams tabs wholesale. Run it once
// when bootstrapping; after you confirm the sheet has your data, you can delete
// routers.json, auth.json and camera-meta.json.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const gs = require('../lib/gsheets.js')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const DRY = process.argv.includes('--dry-run')

function readJson(name) {
  const fp = path.join(ROOT, name)
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')) } catch { return null }
}

async function main() {
  if (!gs.enabled()) {
    console.error('SHEETS_API_URL and SHEETS_TOKEN must be set first (see SHEETS.md).')
    process.exit(1)
  }

  const routers = readJson('routers.json')
  const auth = readJson('auth.json')
  const camMeta = readJson('camera-meta.json')

  if (!routers && !auth && !camMeta) {
    console.log('No routers.json / auth.json / camera-meta.json found — nothing to migrate.')
    process.exit(0)
  }

  const tabs = {}
  if (routers && (routers.users || Array.isArray(routers))) {
    const devs = Array.isArray(routers) ? routers : routers.devices || []
    tabs.Devices = gs.devicesToRows(devs)
  }
  if (auth) {
    const users = Array.isArray(auth.users) ? auth.users : (auth.username ? [{ username: auth.username, password: auth.password || '', displayName: auth.displayName || auth.username, role: auth.role || 'admin' }] : [])
    tabs.Users = gs.usersToRows(users)
  } else {
    tabs.Users = gs.usersToRows([{ username: 'admin', password: 'admin123', displayName: 'Admin', role: 'admin' }])
  }
  if (camMeta && Object.keys(camMeta).length) tabs.Cams = gs.camMetaToRows(camMeta)

  for (const [tab, rows] of Object.entries(tabs)) {
    console.log('[migrate] would upload ' + tab + ': ' + (rows.length - 1) + ' data rows' + (DRY ? ' (dry-run)' : ''))
  }
  if (DRY) return

  for (const [tab, rows] of Object.entries(tabs)) {
    const count = await gs.replaceTab(tab, rows)
    console.log('[migrate] ' + tab + ' -> ' + count + ' rows written')
  }
  console.log('\nDone. Verify the Devices / Users / Cams tabs, then delete routers.json, auth.json and camera-meta.json.')
  console.log('Next: push this repo to GitHub and set the Actions secrets (SHEETS_API_URL, SHEETS_TOKEN, SNMP_COMMUNITY).')
}

main().catch((e) => { console.error('[migrate] failed:', e.message || e); process.exit(1) })