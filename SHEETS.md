# Google Sheets কে Database হিসেবে সেট করা (Apps Script Web App)

এই dashboard **Devices, Users, History** — তিনটাই Google Sheet-এ রাখে, একটা **Apps Script Web App** দিয়ে।
(`SHEETS_API_URL` + `SHEETS_TOKEN` secret না থাকলে আগের মতো files/cache-ই ব্যবহার হয়।)

---

## ধাপ ১ — Sheet ও Apps Script

1. একটা Google Spreadsheet বানান (নাম যেমন: **AEL - NOC DB**)।
2. **Extensions → Apps Script** খুলুন।
3. repo-র **`SHEETS.gs`** ফাইলের পুরো কোড কপি করে Apps Script এ পেস্ট করুন (`Code.gs` এর জায়গায়)।
4. উপরে `TOKEN = '...'` লাইনটা নিজের একটা গোপন string দিয়ে বদলান (এটাই `SHEETS_TOKEN`)।
5. ফাংশন dropdown → **`setupNocDashboard`** → **Run** → permission **Allow**।
   → Devices / Users / History / State — ৪টা tab হেডারসহ তৈরি হবে।

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
**Users** — `username  password  displayName  role`
**History** — `ts  deviceId  ifIdx  ifName  rxRate  txRate`  (অ্যাপ নিজে ভরবে)
**State** — `deviceId  ifIdx  ts  rxBytes  txBytes`          (অ্যাপ নিজে ভরবে)

---

## নোট

- **History বাড়তে থাকবে** → মাঝে মাঝে পুরনো row মুছুন (Sheets সীমা ১ কোটি cell)।
- Sheet **private** রাখুন; শুধু service-এর জন্য public Web App।
- `History` থেকে অ্যাপ শেষ ~২৫ ঘণ্টার ডেটা `history.json`-এ নেয় (graph-এর জন্য)।
