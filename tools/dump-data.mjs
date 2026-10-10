// Dumps the dashboard data to a static JSON file for GitHub Pages.
// It talks to the locally-running dashboard.js server (same machine/repo),
// logs in with the admin credentials from the Google Sheet (Users tab),
// then writes a snapshot.
//
// Usage: node tools/dump-data.mjs [outFile]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
function rowsToObjectsLocal(rows) {
  if (!rows || !rows.length) return { header: [], list: [] }
  const header = rows[0].map(h => String(h).trim().toLowerCase())
  const list = rows.slice(1).filter(r => (r || []).some(x => x !== '' && x != null)).map(r => { const o = {}; header.forEach((k, i) => o[k] = r[i] == null ? '' : String(r[i]).trim()); return o })
  return { header, list }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080'
const OUT = process.argv[2] || path.join(ROOT, 'site', 'data.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function adminCreds() {
  // Users come from the Google Sheet (Users tab, source of truth)
  if (process.env.SHEETS_API_URL) {
    try {
      const gs = require('../lib/gsheets.js')
      const users = gs.usersFromRows(await gs.readTab('Users'))
      const admin = users.find((u) => (u.role || 'user') === 'admin') || users[0]
      if (admin && admin.username) return { username: admin.username, password: admin.password }
    } catch (e) { console.warn('[dump] sheet users read failed: ' + e.message) }
  }
  return { username: 'admin', password: 'admin123' }
}

async function login() {
  const { username, password } = await adminCreds()
  // The server only starts listening AFTER its first poll sweep — retry until ready.
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(BASE + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (r.ok) {
        const sc = r.headers.get('set-cookie') || ''
        return sc.split(';')[0]
      }
      if (r.status === 401) {
        console.warn('[dump] login rejected (401) — check the Users tab in the sheet')
        return null
      }
    } catch {
      /* server not up yet */
    }
    await sleep(5000)
  }
  throw new Error('server did not become ready in time')
}

async function getJson(cookie, p) {
  const headers = cookie ? { cookie } : {}
  const r = await fetch(BASE + p, { headers })
  if (!r.ok) throw new Error(p + ' -> HTTP ' + r.status)
  return r.json()
}

;(async () => {
  try {
    const cookie = await login()
    const data = await getJson(cookie, '/api/data')
    let cameras = null
    try { cameras = await getJson(cookie, '/api/cameras-summary') } catch (e) { console.warn('[dump] cameras:', e.message) }

    // Per-NVR detail (storage, HDD slots, RAM, uptime, firmware, cameras)
    const devices = data.routers || []
    const nvrs = {}
    for (const dev of devices) {
      if (!dev.hasNvr) continue
      try { nvrs[dev.id] = await getJson(cookie, '/api/nvr?id=' + encodeURIComponent(dev.id)) }
      catch (e) { console.warn('[dump] nvr ' + dev.id + ': ' + e.message) }
    }

    // ---- per-interface traffic history ----
    const now = Date.now()
    const MAXPTS = 300
    const gs = process.env.SHEETS_API_URL ? require('../lib/gsheets.js') : null
    const siteHist = { generated: now, devices: {} }

    if (gs && gs.enabled()) {
     try {
      // History in Google Sheets: 'State' tab (prev octets) + 'History' tab (rate samples)
      const prevMap = {}
      try {
        const { list } = rowsToObjectsLocal(await gs.readTab('State'))
        for (const r of list) prevMap[r.deviceid + '|' + r.ifidx] = { t: parseInt(r.ts, 10) || 0, rx: Number(r.rxbytes), tx: Number(r.txbytes) }
      } catch (e) { console.warn('[dump] state read:', e.message) }
      const newState = [['deviceId', 'ifIdx', 'ts', 'rxBytes', 'txBytes']]
      const append = []
      for (const dev of devices) {
        if (dev.type !== 'snmp' || !dev.interfaces || !dev.interfaces.length) continue
        for (const it of dev.interfaces) {
          if (it.rxBytes == null || it.txBytes == null) continue
          const p = prevMap[dev.id + '|' + it.idx]
          let rRate = '', tRate = ''
          if (p) {
            const dt = Math.max((now - p.t) || 0, 1000)
            let dr = it.rxBytes - p.rx; if (dr < 0) dr += 4294967296
            let dtr = it.txBytes - p.tx; if (dtr < 0) dtr += 4294967296
            rRate = Math.round((dr * 8) / (dt / 1000))
            tRate = Math.round((dtr * 8) / (dt / 1000))
          }
          append.push([now, dev.id, it.idx, it.name, rRate, tRate])
          newState.push([dev.id, it.idx, now, it.rxBytes, it.txBytes])
        }
      }
      try { await gs.appendRows('History', append); await gs.replaceTab('State', newState) } catch (e) { console.warn('[dump] history write:', e.message) }
      try {
        const cutoff = now - 25 * 3600 * 1000
        const { list } = rowsToObjectsLocal(await gs.readTab('History'))
        for (const r of list) {
          const t = parseInt(r.ts, 10) || 0
          if (t < cutoff) continue
          const devId = r.deviceid, idx = r.ifidx
          if (!devId || idx == null || idx === '') continue
          const d = siteHist.devices[devId] || (siteHist.devices[devId] = {})
          const s = d[idx] || (d[idx] = { name: r.ifname || '', pts: [] })
          s.pts.push([t, r.rxrate === '' || r.rxrate == null ? null : Number(r.rxrate), r.txrate === '' || r.txrate == null ? null : Number(r.txrate)])
        }
        for (const d of Object.values(siteHist.devices)) for (const s of Object.values(d)) if (s.pts.length > MAXPTS) s.pts = s.pts.slice(-MAXPTS)
      } catch (e) { console.warn('[dump] history read:', e.message) }
      console.log('[dump] history via Sheets: ' + append.length + ' rows')
     } catch (e) { console.warn('[dump] sheets history failed -> no site history this run: ' + (e && e.message)) }
    } else {
      console.warn('[dump] SHEETS_API_URL not set -> no site history this run')
    }
    try { fs.writeFileSync(path.join(ROOT, 'site', 'history.json'), JSON.stringify(siteHist)) } catch (e) {}

    const payload = { generated: now, devices, cameras, nvrs }
    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    fs.writeFileSync(OUT, JSON.stringify(payload))
    console.log('[dump] wrote ' + OUT + '  devices=' + devices.length + ' cameras=' + (cameras ? cameras.total : 'n/a') + ' nvrs=' + Object.keys(nvrs).length)
    process.exit(0)
  } catch (e) {
    console.error('[dump] failed:', e.message || e)
    process.exit(1)
  }
})()
