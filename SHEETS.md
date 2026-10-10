# Google Sheets কে Database হিসেবে সেট করা (Apps Script Web App)

এই dashboard-এর **প্রতিটা config** — device list, users, camera meta, monitoring history — সব Google Sheet-এ থাকে, একটা **Apps Script Web App** দিয়ে। Dashboard-এ **login / user management / access request** ব্যবস্থাও একই Apps Script দিয়ে চলে (নিচের **"সাইটের auth ও actions"** দেখুন)।
কোনো local config file (routers.json / auth.json / camera-meta.json) আর লাগে না — GitHub Actions প্রতিবার Sheet থেকেই সব পড়ে।

---

## ধাপ ১ — Sheet ও Apps Script

1. একটা Google Spreadsheet বানান (নাম যেমন: **AEL - NOC DB**)।
2. **Extensions → Apps Script** খুলুন।
3. repo-র **`SHEETS.gs`** ফাইলের পুরো কোড কপি করে Apps Script এ পেস্ট করুন (`Code.gs` এর জায়গায়)।
4. উপরে `TOKEN = '...'` লাইনটা নিজের একটা গোপন string দিয়ে বদলান (এটাই `SHEETS_TOKEN`)।
5. ফাংশন dropdown → **`setupNocDashboard`** → **Run** → permission **Allow**।
   → Devices / Users / History / State / Requests / Cams — ৬টা tab হেডারসহ তৈরি হবে।

> অথবা Apps Script এর বদলে, `SHEETS.gs` চালানোর দরকার নেই — কিন্তু tab-গুলো (হুবহু হেডার দিয়ে) হাতে বানালেও হবে।

---

## ধাপ ২ — Web App হিসেবে Deploy

**Deploy → New deployment** (বা আগেরটা **Manage deployments → ✏️ Edit**):

- **Type:** Web app
- **Execute as:** **Me**
- **Who has access:** **Anyone**   ← এটা খুব জরুরি (নাহলে Google sign-in আসবে)
- **Deploy** → **`/exec` URL** কপি করুন।

নতুন version দিলেও আগের `/exec` URL একই থাকবে।

---

## ধাপ ৩ — GitHub Secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

- `SHEETS_API_URL` → উপরের **/exec URL**
- `SHEETS_TOKEN`  → Apps Script-এ যে token সেট করেছেন
- `SNMP_COMMUNITY` → (আগে থেকেই আছে)

---

## ধাপ ৪ — চালু

Actions → **Monitor & Deploy → Run workflow**।
এরপর প্রতি ৫ মিনিটে: Devices/Users পড়া হবে Sheet থেকে, History/State-এ লেখা হবে, আর `history.json` তৈরি হবে।

---

## Tab structure

**Devices** — `ID  NAME  ISP  LOCATION  IP  TYPE  SNMPPORT  NVR_BRAND  NVR_PORT  DEVICE-USER  DEVICE-PASS`
**Users** — `username  password  displayName  role`  (প্রথম admin-কে নিচের `makeFirstAdmin` দিয়ে হাতে ঢোকাতে হবে)
**Requests** — `ts  username  displayName  password  note  status`  (status: pending / approved / rejected)
**History** — `ts  deviceId  ifIdx  ifName  rxRate  txRate`  (অ্যাপ নিজে ভরবে)
**State** — `deviceId  ifIdx  ts  rxBytes  txBytes`          (অ্যাপ নিজে ভরবে)
**Cams** — `NVRID  CH  ALIAS  HIDDEN  SOURCE`                (NVR camera channel-এর alias / hidden / video source override)

---

## সাইটের auth ও actions (Apps Script Web App)

Dashboard-এর সব button (Add Device, Change Password, User Management, Access Requests, Sign in / Request Access) **Apps Script Web App**-এ POST করে (Content-Type `text/plain` → CORS preflight বন্ধ থাকে)। Actions:

| Action | কে দিতে পারে | কাজ |
|---|---|---|
| `login` | public | username/password দিয়ে session (টোকেন, ১২ ঘণ্টা TTL) |
| `requestAccess` | public | নতুন ব্যবহারকারীর আবেদন → Requests tab-এ pending |
| `me` | session | session বৈধ কিনা + user তথ্য (dashboard `boot()` এ চেক করে) |
| `logout` | session | session মুছে দেয় |
| `changePassword` | session | নিজের পাসওয়ার্ড বদলায় (current + new) |
| `addDevice` | ADD_TOKEN | Devices tab-এ যোগ; ID server-এ auto-generate |
| `listUsers` / `saveUser` / `deleteUser` | admin session | user যোগ/সম্পাদনা/মুছে ফেলা (last admin/নিজেকে মুছতে পারে না) |
| `listRequests` / `approveRequest` / `rejectRequest` | admin session | আবেদন অনুমোদন/বাতিল (`approve` করলে Users-এ password সহ যোগ হয়) |
| `getDevices` / `getUsers` / `getCams` | SHEETS_TOKEN | GitHub Actions-এর জন্য (poll + dump) |
| `setDevices` / `setUsers` / `setCams` / `setState` | SHEETS_TOKEN | GitHub Actions-এর জন্য |
| `appendHistory` / `getHistory` | SHEETS_TOKEN | History/state আপডেট/পড়া |

Session Apps Script-এ `PropertiesService`-এ রাখা; ১২ ঘণ্টা বা `logout` এ শেষ।

---

## "+ Add Device" (GitHub Pages site)

Site-এর **+ Add Device** বাটন দিয়ে device যোগ করলে সেটা সরাসরি **Devices** tab-এ append হয় (Apps Script-এর `addDevice` action)।

- **Device ID এখন server-এ auto-generate হয়** (`slug-N`) — user-কে ID field দেখানো হয় না; যোগের পর সফল মেসেজে ID দেখানো হয়।
- **Device Type** select করলে ফর্ম এমনিতে বদলায়: router/switch/other → SNMP Port; NVR → NVR Port/Brand/User/Pass; attendance → শুধু ping।
- IPA/Label field auto-filled হয় type অনুযায়ী (যদি user নিজে একবার না এডিট করে)।

এর জন্য Apps Script-এ একটা limited token দরকার:

```javascript
var ADD_TOKEN = 'PASTE-ADD-ONLY-TOKEN-HERE';
```

এই token শুধু `addDevice` অনুমতি দেয় (read/edit/delete নয়) — কারণ site public, তাই token সবাই দেখতে পারে।

## প্রথমবার admin সেট করা

Sheets-এ `Users` tab ফাঁকা থাকলে, প্রথম admin-কে নিচের ফাংশন দিয়ে যোগ করে নিন:

```javascript
function makeFirstAdmin() {
  const users = DB_.getSheetByName('Users');
  users.appendRow(['boss', 'CHANGE-ME', 'Network Admin', 'admin']);
}
```

Apps Script editor-এ এই ফাংশন লিখে, dropdown থেকে `makeFirstAdmin` → Run দিন। Run করার পর এই ফাংশনটা মুছে দিতে পারেন।

## ড্যাশবোর্ড লগইন

`site/index.html` খুললে না-থাকা session দিলে `login/`-এ পাঠায়; login বা request-access দুই পাওয়া যায়। Login সফল হলে session + user info `localStorage`-এ (`nmc_session`, `nmc_user`)।

> ⚠️ **লিমিটেশন:** এটি client-side gate — GitHub Pages-এর `data.json` ফাইলের URL-টা টেকনিক্যালি উন্মুক্ত থাকে। Session-ঘেঁষা সব কমান্ড (user add/delete, request approve) কিন্তু Apps Script-এ **admin-চেক করা** — তাই সেগুলো শুধু admin দিয়ে চলে।

## নোট

- **History বাড়তে থাকবে** → মাঝে মাঝে পুরনো row মুছুন (Sheets সীমা ১ কোটি cell)।
- Sheet **private** রাখুন; শুধু service-এর জন্য public Web App।
- `History` থেকে অ্যাপ শেষ ~২৫ ঘণ্টার ডেটা `history.json`-এ নেয় (graph-এর জন্য)।
- **Camera meta (`Cams`)** → GitHub Actions-এর `dashboard.js` load করে, `dump-data.mjs` UI-তে alias/hidden/source পাঠায়।
