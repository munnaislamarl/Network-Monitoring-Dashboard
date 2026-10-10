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

    const payload = { generated: Date.now(), devices, cameras, nvrs }
    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    fs.writeFileSync(OUT, JSON.stringify(payload))
    console.log('[dump] wrote ' + OUT + '  devices=' + devices.length + ' cameras=' + (cameras ? cameras.total : 'n/a') + ' nvrs=' + Object.keys(nvrs).length)
    process.exit(0)
  } catch (e) {
    console.error('[dump] failed:', e.message || e)
    process.exit(1)
  }
})()
