# 24/7 সার্ভারে চালানো (আপনার PC বন্ধ থাকলেও মনিটরিং)

লক্ষ্য: একটা সবসময় চালু **cloud server (VPS)**-এ এই dashboard চালানো, যাতে আপনার PC বন্ধ থাকলেও ডিভাইস মনিটরিং চলতে থাকে। যেহেতু ডিভাইসগুলো **public IP** দিয়ে reachable, তাই VPS ইন্টারনেট থেকেই সেগুলো poll করতে পারবে।

---

## যা লাগবে

- একটা **VPS** (Ubuntu 22.04 / 24.04 LTS), public IP সহ
  - Providers: Hetzner, DigitalOcean, Vultr, AWS Lightsail, Contabo
  - কমপক্ষে 1 GB RAM / 1 vCPU যথেষ্ট
- VPS থেকে ডিভাইসে **outbound** খোলা থাকতে হবে — SNMP (UDP 161) ও NVR HTTP পোর্ট (ডিফল্ট 80/443/8000)
- (ঐচ্ছিক, HTTPS-এর জন্য) একটা ডোমেইন

---

## ধাপ ১ — VPS বানান ও SSH করুন

উদাহরণ (Hetzner/DigitalOcean): Ubuntu 22.04/24.04 image দিয়ে সার্ভার বানিয়ে SSH করুন:

```bash
ssh root@<VPS_PUBLIC_IP>
```

## ধাপ ২ — Docker ইনস্টল

```bash
curl -fsSL https://get.docker.com | sh
docker --version
docker compose version
```

## ধাপ ৩ — প্রজেক্ট clone

```bash
git clone https://github.com/munnaislamarl/Network-Monitoring-Dashboard.git
cd Network-Monitoring-Dashboard
```

> Private repo হলে GitHub-এর **Personal Access Token (PAT)** বা **SSH key** লাগবে।
> PAT দিয়ে: `git clone https://<USERNAME>:<TOKEN>@github.com/munnaislamarl/Network-Monitoring-Dashboard.git`

## ধাপ ৪ — কনফিগারেশন

```bash
cp auth.example.json auth.json
cp routers.example.json routers.json
cp camera-meta.example.json camera-meta.json
mkdir -p history

nano routers.json     # এখানে ডিভাইসের PUBLIC IP বসান
nano auth.json        # admin-এর পাসওয়ার্ড বদলান
```

`routers.json`-এ প্রতিটি ডিভাইস:

```json
[
  { "id": "office-router", "name": "Office Router", "isp": "ISP", "location": "HQ", "ip": "1.2.3.4" },
  { "id": "nvr-01", "name": "NVR-01", "isp": "NVR", "location": "Server Room",
    "ip": "1.2.3.5", "type": "ping",
    "nvr": { "brand": "hikvision", "port": 80, "user": "isapi-user", "pass": "isapi-pass" } }
]
```

## ধাপ ৫ — চালু করুন

```bash
docker compose up -d --build
docker compose logs -f        # লগ দেখুন (Ctrl+C দিয়ে বের হবেন, container চলবে)
```

এখন ব্রাউজারে: **http://<VPS_PUBLIC_IP>:8080** → লগইন করুন।

## ধাপ ৬ — HTTPS (Caddy দিয়ে, auto certificate)

একটা ডোমেইন (যেমন `noc.yourcompany.com`) VPS-এর IP-তে point করুন; তারপর:

```bash
sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```
noc.yourcompany.com {
    reverse_proxy 127.0.0.1:8080
}
```

```bash
sudo systemctl reload caddy
```

এখন: **https://noc.yourcompany.com** (সার্টিফিকেট auto-renew হবে)।

## ফায়ারওয়াল (গুরুত্বপূর্ণ)

শুধু এগুলো খুলুন — বাকি বন্ধ:

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

> 8080 পোর্ট ইন্টারনেটে সরাসরি খুলবেন **না** — HTTPS (Caddy) দিয়েই ব্যবহার করুন।

## আপডেট করা

```bash
cd Network-Monitoring-Dashboard
git pull
docker compose up -d --build
```

---

## বিকল্প: Docker ছাড়া (Node + PM2)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
cd Network-Monitoring-Dashboard
npm install --omit=dev
sudo npm install -g pm2
pm2 start dashboard.js --name noc-dashboard
pm2 startup && pm2 save
```

---

## নিরাপত্তা

- `auth.json`-এ শক্ত পাসওয়ার্ড দিন; প্রথম লগইনে বদলে নিন।
- সবসময় **HTTPS** ব্যবহার করুন।
- ডিভাইসের ISP/ফায়ারওয়ালে শুধু VPS-এর IP থেকেই SNMP/HTTP allow করা ভালো।
- `auth.json`, `routers.json`, `camera-meta.json` কখনো GitHub-এ commit করবেন না (`.gitignore`-এ আছে)।
