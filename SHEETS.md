# Google Sheets কে Database হিসেবে সেট করা

এই dashboard এখন **Devices, Users, History** — তিনটাই Google Sheet থেকে পড়তে/লিখতে পারে।
(কনফিগার না করলে আগের মতো `routers.json`/`auth.json`/Actions cache-ই ব্যবহার হবে।)

---

## ধাপ ১ — Sheet ও Tabs বানান

একটা Google Spreadsheet বানান (নাম যেমন: **NOC DB**) → ৪টা tab রাখুন:

### `Devices`  (হেডার = প্রথম row)
```
id	name	isp	location	ip	type	snmpport	nvr_brand	nvr_port	nvr_user	nvr_pass
akij-flour-ccl	AKIJ Essential (Flour)	CCL-SIP	Amirabad, Bandar, Narayanganj	103.102.42.58
ael-sw01	AEL-SW01	Switch	OLD-ADMIN-OFFICE - SILO-8	103.102.42.59		16101
ael-nvr01	AEL-NVR01	NVR	CCTV / NVR	103.102.42.59	ping			2581	munna.apfil@akijpolyfibre.com	Valo@121
```
- `type` খালি = SNMP; NVR হলে `ping` দিন আর `nvr_*` কলাম ভরুন।
- SNMP non-standard port হলে `snmpport` দিন (যেমন 16101)।

### `Users`
```
username	password	displayName	role
admin	your-strong-password	Munna	admin
```

### `History`  (খালি রাখুন — অ্যাপ নিজে ভরবে)
```
ts	deviceId	ifIdx	ifName	rxRate	txRate
```

### `State`  (খালি রাখুন — অ্যাপ নিজে ভরবে)
```
deviceId	ifIdx	ts	rxBytes	txBytes
```

---

## ধাপ ২ — Service Account বানান

1. **console.cloud.google.com** → নতুন project বানান।
2. **APIs & Services → Library** → **Google Sheets API** → **Enable**।
3. **IAM & Admin → Service Accounts → Create Service Account** (নাম যেমন `noc-db`).
4. সেই service account → **Keys → Add key → Create new key → JSON** → download করুন।
5. JSON ফাইলের ভেতরে `"client_email"` = `noc-db@xxxx.iam.gserviceaccount.com` — এটা কপি করুন।
6. Google Sheet → **Share** → এই `client_email` কে **Editor** হিসেবে যোগ করুন।

---

## ধাপ ৩ — GitHub Secrets যোগ করুন

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

- `SHEET_ID` → Sheet-এর URL থেকে: `https://docs.google.com/spreadsheets/d/**<এই অংশটা>**/edit`
- `GOOGLE_SERVICE_ACCOUNT` → ডাউনলোড করা **JSON ফাইলের পুরো কনটেন্ট** পেস্ট করুন।

---

## ধাপ ৪ — চালু করুন

Actions → **Monitor & Deploy** → **Run workflow**।
এরপর প্রতি ৫ মিনিটে:
- Devices/Users পড়া হবে Sheet থেকে,
- History/State-এ ডেটা লেখা হবে ও `history.json` তৈরি হবে (Pages site-এর graph-এর জন্য)।

---

## জরুরি নোট
- **History বাড়তে থাকবে** → মাঝে মাঝে পুরনো row মুছে দিন (Google Sheets limit: ১ কোটি cell/শিট)। অ্যাপ শেষ ~২৪ ঘণ্টার ডেটা `history.json`-এ নেয়।
- Sheet-টা **private** রাখুন (শুধু service account + আপনার টিমের সাথে share)।
- Service account JSON মনে রাখবেন এটা একটা **secret** — কখনো repo-তে commit করবেন না (`.gitignore`-এ আছে)।
