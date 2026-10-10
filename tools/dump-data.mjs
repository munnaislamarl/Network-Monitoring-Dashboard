// Dumps the dashboard data to a static JSON file for GitHub Pages.
// It talks to the locally-running dashboard.js server (same machine/repo),
// logs in with the admin credentials from auth.json, then writes a snapshot.
//
// Usage: node tools/dump-data.mjs [outFile]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080'
const OUT = process.argv[2] || path.join(ROOT, 'site', 'data.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function adminCreds() {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(ROOT, 'auth.json'), 'utf8'))
    const admin = (auth.users || []).find((u) => (u.role || 'user') === 'admin') || (auth.users || [])[0]
    if (admin) return { username: admin.username, password: admin.password }
  } catch {}
  return { username: 'admin', password: 'admin123' }
}

async function login() {
  const { username, password } = adminCreds()
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
        console.warn('[dump] login rejected (401) — check auth.json')
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

    // ---- per-interface traffic history (persisted across runs via Actions cache) ----
    const HISTORY_FILE = process.env.HISTORY_FILE || path.join(ROOT, 'history-data', 'history.json')
    let hist = { version: 1, devices: {} }
    try { hist = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); hist.devices = hist.devices || {} } catch (e) {}
    const MAXPTS = 300
    const now = Date.now()
    for (const dev of devices) {
      if (dev.type !== 'snmp' || !dev.interfaces || !dev.interfaces.length) continue
      const d = hist.devices[dev.id] || (hist.devices[dev.id] = { prev: { t: 0, ifs: {} }, series: {} })
      d.series = d.series || {}
      const dt = Math.max((now - (d.prev.t || 0)) || 0, 1000)
      for (const it of dev.interfaces) {
        if (it.rxBytes == null || it.txBytes == null) continue
        const p = d.prev.ifs ? d.prev.ifs[it.idx] : null
        let rRate = null, tRate = null
        if (p) {
          let dr = it.rxBytes - p.rx; if (dr < 0) dr += 4294967296
          let dtr = it.txBytes - p.tx; if (dtr < 0) dtr += 4294967296
          rRate = (dr * 8) / (dt / 1000)
          tRate = (dtr * 8) / (dt / 1000)
        }
        const s = d.series[it.idx] || (d.series[it.idx] = { name: it.name, pts: [] })
        s.name = it.name
        s.pts.push([now, rRate == null ? null : Math.round(rRate), tRate == null ? null : Math.round(tRate)])
        if (s.pts.length > MAXPTS) s.pts.splice(0, s.pts.length - MAXPTS)
      }
      d.prev = { t: now, ifs: {} }
      for (const it of dev.interfaces) if (it.rxBytes != null) d.prev.ifs[it.idx] = { rx: it.rxBytes, tx: it.txBytes }
    }
    try { fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true }); fs.writeFileSync(HISTORY_FILE, JSON.stringify(hist)) } catch (e) { console.warn('[dump] history save:', e.message) }
    const siteHist = { generated: now, devices: {} }
    for (const [id, d] of Object.entries(hist.devices)) {
      siteHist.devices[id] = {}
      for (const [idx, s] of Object.entries(d.series)) siteHist.devices[id][idx] = { name: s.name, pts: s.pts }
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
