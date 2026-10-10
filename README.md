# Network Monitoring Dashboard (NOC)

একটি হালকা, self-hosted **Network Operation Center** dashboard — SNMP ও HTTP (ISAPI) দিয়ে রাউটার, সুইচ, NVR/CCTV এবং অন্যান্য ডিভাইস মনিটর করার জন্য।

A lightweight, self-hosted **Network Operation Center** dashboard for monitoring routers, switches, NVR/CCTV and other devices over **SNMP** and **HTTP/ISAPI**.

---

## ফিচারসমূহ / Features

- **ডিভাইস মনিটরিং** — SNMP (MikroTik private OIDs) ও ping দিয়ে online/offline, latency, CPU, RAM, interface traffic।
- **NVR / CCTV ভিউ** — Hikvision ISAPI দিয়ে চ্যানেল, HDD/Storage (`3 / 8 connected`), RAM/Storage gauge, ক্যামেরা কার্ডে 16:9 live-style preview।
- **Group View / Frame View** — নিজের পছন্দমতো ক্যামেরা গ্রুপ করে বা 1/4/6/9/16 frame-এ live view।
- **Device & Camera list popup** — Online/Offline চিপে ক্লিক করলে পরিষ্কার তালিকা।
- **User Management** — একাধিক ইউজার (admin/user), ইউজার যোগ/এডিট/ডিলিট ও নিজের **Password Change**।
- **Live dashboard** — প্রতি 5 সেকেন্ডে auto-refresh, alert, search ও filter।

## প্রয়োজনীয়তা / Requirements

- **Node.js 18+** (LTS recommended)
- Windows / Linux / macOS
- (ঐচ্ছিক) office network-এ রাখলে Linux server ভালো

## ইনস্টল / Install

```bash
git clone https://github.com/<your-username>/network-monitoring-dashboard.git
cd network-monitoring-dashboard
npm install
```

## কনফিগারেশন / Configuration

রিপোতে আসল গোপন ফাইল থাকে না — **example** থেকে কপি করে নিজের মান বসান:

```bash
copy auth.example.json auth.json            # Windows
copy routers.example.json routers.json      # Windows
copy camera-meta.example.json camera-meta.json   # optional
```

Linux/macOS:

```bash
cp auth.example.json auth.json
cp routers.example.json routers.json
cp camera-meta.example.json camera-meta.json
```

- **`auth.json`** — ইউজার লিস্ট। প্রথমে `admin` পাসওয়ার্ড **অবশ্যই** বদলান।
- **`routers.json`** — ডিভাইস লিস্ট (SNMP, ping, NVR)। NVR হলে `nvr: { brand, port, user, pass }` দিতে হবে।
- **`camera-meta.json`** — (ঐচ্ছিক) NVR চ্যানেলের alias / hidden / video source override।

> ⚠️ `auth.json`, `routers.json`, `camera-meta.json` — এগুলো `.gitignore`-এ আছে, **কখনো commit/push করবেন না**।

## চালানো / Run

```bash
node dashboard.js
```

অথবা Windows-এ ডাবল-ক্লিক: **`start.bat`**

তারপর ব্রাউজারে খুলুন: **http://localhost:8080**

- ডিফল্ট লগইন: `admin` / `admin123` (প্রথমবার লগইন করে সাথে সাথে বদলে ফেলুন)।
- পোর্ট বদলাতে চাইলে: `set PORT=9090 && node dashboard.js`

### ব্যাকগ্রাউন্ডে চালানো (Windows)

`run-dashboard.bat` ডাবল-ক্লিক করলে ড্যাশবোর্ড চলে এবং crash করলে নিজে থেকেই আবার চালু হয়। এটিকে লগইনের সময় auto-start করাতে চাইলে এই ব্যাচ ফাইলের একটি শর্টকাট/লঞ্চার `shell:startup` ফোল্ডারে রাখুন।

## কনফিগারেশন রেফারেন্স

`routers.json` একটি array। প্রতিটি item:

| field | বর্ণনা |
|-------|--------|
| `id` | ইউনিক আইডি |
| `name` | ডিভাইসের নাম |
| `isp` | ISP / গ্রুপ |
| `location` | লোকেশন |
| `ip` | ডিভাইসের IP |
| `type` | `"ping"` দিলে ping-check, নাহলে SNMP |
| `nvr` | (শুধু NVR) `{ brand, port, user, pass }` |

## 24/7 সার্ভারে চালানো / Deploy 24/7

আপনার PC বন্ধ থাকলেও monitoring চালু রাখতে একটা always-on cloud **VPS**-এ চালান (Docker)। ধাপে ধাপে গাইড: **[DEPLOY.md](DEPLOY.md)**।

```bash
cp auth.example.json auth.json && cp routers.example.json routers.json
docker compose up -d --build
```

## নিরাপত্তা / Security

- সব গোপন ফাইল `.gitignore`-এ রাখা আছে — commit করার আগে `git status` দেখে নিন।
- প্রোডাকশনে HTTPS reverse-proxy + শক্ত পাসওয়ার্ড ব্যবহার করুন।
- পাসওয়ার্ড ম্যানেজ করতে চাইলে কোডে bcrypt যোগ করা যায়।

## লাইসেন্স / License

ISC — ব্যক্তিগত/প্রাতিষ্ঠানিক ব্যবহারের জন্য।
