/* =========================================================
   Network Operation Center — login page logic
   (particle network background + sign in + request access)
   Plain vanilla JS (no libraries).
   ========================================================= */
(function () {
  "use strict";

  /* ---------------------------------------------------------
     PARTICLE NETWORK BACKGROUND
     --------------------------------------------------------- */
  const cv = document.getElementById("fx");
  const ctx = cv.getContext("2d");

  let w = 0, h = 0, dpr = 1;
  let pts = [];
  let ripples = [];
  const MAXP = 600;
  const mouse = { x: 0, y: 0, on: false };
  let raf = null;
  let running = false;

  const rand = () => Math.random();

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    cv.width = Math.floor(w * dpr);
    cv.height = Math.floor(h * dpr);
    cv.style.width = w + "px";
    cv.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    pts = pts.filter((p) => p.life !== Infinity);
    ripples = [];
    const base = Math.max(64, Math.min(208, Math.round((w * h) / 9375)));
    for (let i = 0; i < base; i++) {
      const ang = rand() * Math.PI * 2;
      const spd = (0.35 + rand() * 0.75) * 0.168;
      pts.push({
        x: rand() * w,
        y: rand() * h,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        life: Infinity,
        r: 1.7
      });
    }
  }

  function spawnClick(x, y) {
    ripples.push({ x: x, y: y, r: 4 });
    if (ripples.length > 14) ripples.shift();

    for (let i = 0; i < 12; i++) {
      if (pts.length > MAXP) break;
      const a = (2 * Math.PI * i) / 12 + rand() * 0.5;
      const sp = 2.5 + rand() * 4.5;
      const off = rand() * 12;
      pts.push({
        x: x + Math.cos(a) * off,
        y: y + Math.sin(a) * off,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 1,
        r: 2.5,
        ox: x,
        oy: y,
        slowed: false
      });
    }
  }

  function frame() {
    if (!running) return;
    ctx.clearRect(0, 0, w, h);

    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];

      if (mouse.on) {
        const gx = p.x - mouse.x;
        const gy = p.y - mouse.y;
        const gd = Math.hypot(gx, gy);
        if (gd > 1 && gd < 150) {
          const f = 0.015 * (1 - gd / 150);
          p.vx += (gx / gd) * f;
          p.vy += (gy / gd) * f;
        }
      }

      p.x += p.vx;
      p.y += p.vy;

      if (p.life === Infinity) {
        const bv = Math.hypot(p.vx, p.vy);
        if (bv > 1.4) {
          p.vx *= 1.4 / bv;
          p.vy *= 1.4 / bv;
        }
      } else {
        p.life -= 0.0005;
        const odx = p.x - p.ox;
        const ody = p.y - p.oy;
        if (!p.slowed && odx * odx + ody * ody >= 25600) {
          p.vx *= 0.1;
          p.vy *= 0.1;
          p.slowed = true;
        }
        if (p.life <= 0) {
          pts.splice(i, 1);
          continue;
        }
      }

      if (p.x < 0) p.x += w;
      else if (p.x > w) p.x -= w;
      if (p.y < 0) p.y += h;
      else if (p.y > h) p.y -= h;
    }

    if (mouse.on) {
      const g = ctx.createRadialGradient(mouse.x, mouse.y, 0, mouse.x, mouse.y, 170);
      g.addColorStop(0, "rgba(120,145,255,0.22)");
      g.addColorStop(0.5, "rgba(120,145,255,0.08)");
      g.addColorStop(1, "rgba(120,145,255,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(mouse.x, mouse.y, 170, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.lineWidth = 2;
    for (let i = ripples.length - 1; i >= 0; i--) {
      const rp = ripples[i];
      rp.r += 3.0;
      if (rp.r >= 160) {
        ripples.splice(i, 1);
        continue;
      }
      ctx.strokeStyle = "rgba(180,200,255," + (0.6 * (1 - rp.r / 160)).toFixed(3) + ")";
      ctx.beginPath();
      ctx.arc(rp.x, rp.y, rp.r, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.lineWidth = 1;
    const halfW = w * 0.5;
    const halfH = h * 0.5;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const lf1 = a.life === Infinity ? 1 : a.life;
      for (let j = i + 1; j < pts.length; j++) {
        const b = pts[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        if (Math.abs(dx) > halfW || Math.abs(dy) > halfH) continue;
        const d = Math.hypot(dx, dy);
        if (d < 135) {
          const lf2 = b.life === Infinity ? 1 : b.life;
          const al = 0.42 * (1 - d / 135) * (0.3 + 0.7 * Math.min(lf1, lf2));
          ctx.strokeStyle = "rgba(185,200,255," + al.toFixed(3) + ")";
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    if (mouse.on) {
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const md = Math.hypot(p.x - mouse.x, p.y - mouse.y);
        if (md < 210) {
          const al = 0.5 * (1 - md / 210);
          ctx.strokeStyle = "rgba(170,190,255," + al.toFixed(3) + ")";
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(mouse.x, mouse.y);
          ctx.stroke();
        }
      }
    }

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const lf = p.life === Infinity ? 1 : p.life;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(228,234,255," + (0.5 + 0.4 * lf).toFixed(3) + ")";
      ctx.fill();
    }

    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (raf) cancelAnimationFrame(raf);
    running = true;
    raf = requestAnimationFrame(frame);
  }

  window.addEventListener("resize", resize);

  window.addEventListener("mousemove", (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.on = true;
  });
  window.addEventListener("mouseleave", () => { mouse.on = false; });
  window.addEventListener(
    "touchmove",
    (e) => {
      if (!e.touches.length) return;
      mouse.x = e.touches[0].clientX;
      mouse.y = e.touches[0].clientY;
      mouse.on = true;
    },
    { passive: true }
  );
  window.addEventListener("touchend", () => { mouse.on = false; });

  document.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest(".login-card")) return;
    if (e.target.closest && e.target.closest(".dialog")) return;
    spawnClick(e.clientX, e.clientY);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      running = false;
      if (raf) { cancelAnimationFrame(raf); raf = null; }
    } else if (!raf) {
      start();
    }
  });

  resize();
  start();

  /* ---------------------------------------------------------
     APPS SCRIPT BACKEND
     --------------------------------------------------------- */
  const APP_URL = "https://script.google.com/macros/s/AKfycbwjB4K1ILtmX7O30oKD3OnxHyvnc_o5T8DuvXs3HN0CgYuwD_ZwZY_TXNf-jwMJyC4snQ/exec";

  async function callApp(lib) {
    const r = await fetch(APP_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(lib),
      redirect: "follow"
    });
    const txt = await r.text();
    let j = null;
    try { j = JSON.parse(txt); } catch (e) { throw new Error("Server response was not valid JSON."); }
    return j;
  }

  const SESSION_KEY = "nmc_session";
  const USER_KEY = "nmc_user";

  // already logged in? straight to the dashboard
  try {
    if (localStorage.getItem(SESSION_KEY)) window.location.replace("../");
  } catch (e) {}

  /* ---------------------------------------------------------
     PASSWORD VISIBILITY TOGGLE
     --------------------------------------------------------- */
  const pw = document.getElementById("password");
  const eye = document.getElementById("eye");
  const eyeOpen = document.getElementById("eyeOpen");
  const eyeOff = document.getElementById("eyeOff");

  eye.addEventListener("click", () => {
    const show = pw.type === "password";
    pw.type = show ? "text" : "password";
    eyeOpen.style.display = show ? "none" : "block";
    eyeOff.style.display = show ? "block" : "none";
    eye.setAttribute("aria-pressed", String(show));
    eye.setAttribute("aria-label", show ? "Hide password" : "Show password");
  });

  /* ---------------------------------------------------------
     SIGN IN
     --------------------------------------------------------- */
  const form = document.getElementById("login-form");
  const userInput = document.getElementById("username");
  const err = document.getElementById("error");
  const btn = document.getElementById("submit");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";

    const username = userInput.value.trim();
    const password = pw.value;
    if (!username || !password) {
      err.textContent = "Please enter your username and password.";
      return;
    }

    btn.disabled = true;
    btn.textContent = "Signing in…";
    try {
      const j = await callApp({ action: "login", username: username, password: password });
      if (j && j.ok) {
        try {
          localStorage.setItem(SESSION_KEY, j.session);
          localStorage.setItem(USER_KEY, JSON.stringify(j.user || {}));
        } catch (e2) {}
        window.location.replace("../");
      } else {
        err.textContent = (j && j.error) || "Invalid username or password.";
        btn.disabled = false;
        btn.textContent = "Sign in";
      }
    } catch (e) {
      err.textContent = "Unable to reach the server. Please try again.";
      btn.disabled = false;
      btn.textContent = "Sign in";
    }
  });

  /* ---------------------------------------------------------
     REQUEST ACCESS (dialog)
     --------------------------------------------------------- */
  const overlay = document.getElementById("reqOverlay");
  const requestBtn = document.getElementById("requestBtn");
  const rqCancel = document.getElementById("rqCancel");
  const reqForm = document.getElementById("request-form");
  const rqErr = document.getElementById("rqError");
  const rqBtn = document.getElementById("rqSubmit");

  function openRequest() {
    overlay.style.display = "flex";
  }
  function closeRequest() {
    overlay.style.display = "none";
    rqErr.textContent = "";
    rqErr.classList.remove("success");
    ["rqName", "rqEmail", "rqPassword", "rqNote"].forEach((id) => {
      const el = document.getElementById(id); if (el) el.value = "";
    });
  }

  requestBtn.addEventListener("click", openRequest);
  rqCancel.addEventListener("click", closeRequest);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeRequest(); });

  reqForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    rqErr.textContent = "";
    rqErr.classList.remove("success");

    const name = document.getElementById("rqName").value.trim();
    const email = document.getElementById("rqEmail").value.trim();
    const password = document.getElementById("rqPassword").value;
    const note = document.getElementById("rqNote").value.trim();

    if (!name || !email || !password) { rqErr.textContent = "Full name, email and password are required."; return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { rqErr.textContent = "Please enter a valid email address."; return; }
    if (password.length < 4) { rqErr.textContent = "Password must be at least 4 characters."; return; }

    rqBtn.disabled = true;
    rqBtn.textContent = "Sending…";
    try {
      const j = await callApp({
        action: "requestAccess",
        data: { username: email, displayName: name, password: password, note: note }
      });
      if (j && j.ok) {
        rqErr.classList.add("success");
        rqErr.textContent = "Request sent! Admin অনুমোদনের পর এই email দিয়ে login করতে পারবেন।";
        rqBtn.disabled = false;
        rqBtn.textContent = "Send request";
        setTimeout(closeRequest, 1800);
      } else {
        rqErr.textContent = (j && j.error) || "Request failed. Please try again.";
        rqBtn.disabled = false;
        rqBtn.textContent = "Send request";
      }
    } catch (e) {
      rqErr.textContent = "Unable to reach the server. Please try again.";
      rqBtn.disabled = false;
      rqBtn.textContent = "Send request";
    }
  });
})();
