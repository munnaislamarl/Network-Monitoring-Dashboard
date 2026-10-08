/* =========================================================
   AKIJ Essential Ltd. (Flour & Dal) — Network Operation Center
   Handles: particle network background, password visibility,
   form validation, and sign-in loading state.
   ========================================================= */

(function () {
  "use strict";

  /* =====================================================================
     INTERACTIVE PARTICLE / NETWORK BACKGROUND
     ---------------------------------------------------------------------
     This block ONLY controls the animated background. It does not touch
     the login form, validation, API calls or authentication logic.

     Layers (see styles.css):
       #network-bg  (canvas)  z-index 0  -> particles, lines, cursor glow
       #ripple-bg   (canvas)  z-index 1  -> click ripples
       .login-shell           z-index 2  -> the login card (unchanged)

     All tunable values live in BG_CONFIG so the effect is configurable.
     ===================================================================== */
  const BG_CONFIG = {
    // --- particle system ---
    particleCountDesktop: 120,   // number of particles on desktop/laptop
    particleCountMobile: 55,     // reduced count on small screens
    particleMinSize: 0.6,        // smallest core radius (px)
    particleMaxSize: 2.0,        // largest core radius (px)
    particleSpeed: 0.22,         // base drift speed (px per frame)

    // --- connections between particles ---
    connectDistanceDesktop: 150, // max px distance a link is drawn
    connectDistanceMobile: 100,  // smaller on mobile for performance
    connectionOpacity: 0.22,     // max alpha of a connecting line
    lineWidth: 0.6,              // base line thickness (px)

    // --- mouse interaction ---
    mouseRadius: 140,            // cursor influence radius (px)
    mouseRepelStrength: 0.045,   // how strongly particles are pushed away
    mouseLinkDistance: 170,      // particles within this connect to cursor
    cursorGlowRadius: 170,       // radius of the subtle cursor glow (px)
    cursorGlowOpacity: 0.05,     // alpha of the cursor glow

    // --- click interaction ---
    clickRadius: 190,            // click influence radius (px)
    clickStrength: 2.4,          // outward impulse applied to particles
    clickEnergy: 1.0,            // brightness boost amount (0..1)
    rippleDuration: 700,         // ripple lifetime (ms)
    rippleMaxRadius: 90,         // ripple max radius (px)

    // --- palette (subtle, no neon / no rainbow) ---
    dotColor: "170, 190, 240",   // core dot RGB (alpha applied at draw)
    dotGlow: "120, 150, 220",    // glow RGB
    lineColor: "130, 160, 225",  // line RGB
    cursorColor: "150, 180, 235" // cursor glow / link RGB
  };

  // ---- canvases ----
  const canvas = document.getElementById("network-bg");
  const ctx = canvas.getContext("2d");
  const rippleCanvas = document.getElementById("ripple-bg");
  const rctx = rippleCanvas.getContext("2d");

  // ---- state ----
  // Computed from the CURRENT viewport so it stays correct after a resize
  // (fewer particles + shorter links on small/mobile screens).
  function particleCount() {
    return window.innerWidth < 640 ? BG_CONFIG.particleCountMobile : BG_CONFIG.particleCountDesktop;
  }
  function connectDistance() {
    return window.innerWidth < 640 ? BG_CONFIG.connectDistanceMobile : BG_CONFIG.connectDistanceDesktop;
  }

  let particles = [];
  let ripples = [];
  let width = 0;
  let height = 0;
  let dpr = 1;
  let rafId = null;      // single animation loop id (prevents duplicates)
  let running = true;
  const mouse = { x: null, y: null, active: false };

  // Pre-rendered soft glow sprite (radial gradient drawn once, reused via
  // drawImage) — much cheaper than building a gradient every frame.
  const glowSprite = (function makeGlowSprite() {
    const size = 64;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, "rgba(" + BG_CONFIG.dotGlow + ", 1)");
    grad.addColorStop(1, "rgba(" + BG_CONFIG.dotGlow + ", 0)");
    g.fillStyle = grad;
    g.beginPath();
    g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    g.fill();
    return c;
  })();

  /* Resize both canvases to the viewport, accounting for devicePixelRatio
     so the drawing stays crisp on retina/high-DPI screens. */
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    rippleCanvas.width = Math.floor(width * dpr);
    rippleCanvas.height = Math.floor(height * dpr);
    rippleCanvas.style.width = width + "px";
    rippleCanvas.style.height = height + "px";
    rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* Create the particle field. Each particle carries:
       x, y   position
       vx, vy base drift velocity
       ix, iy interaction velocity (from mouse/click), decays smoothly
       r      core radius
       energy 0..1 extra brightness/burst that fades out            */
  function createParticles() {
    particles = [];
    const count = particleCount();
    for (let i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * BG_CONFIG.particleSpeed,
        vy: (Math.random() - 0.5) * BG_CONFIG.particleSpeed,
        ix: 0,
        iy: 0,
        r: Math.random() * (BG_CONFIG.particleMaxSize - BG_CONFIG.particleMinSize) + BG_CONFIG.particleMinSize,
        energy: 0
      });
    }
  }

  /* Apply a click shockwave: push nearby particles outward and briefly
     brighten them. Called only for background clicks (not the card). */
  function applyClick(x, y) {
    const R = BG_CONFIG.clickRadius;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const dx = p.x - x;
      const dy = p.y - y;
      const d = Math.hypot(dx, dy);
      if (d < R && d > 0.01) {
        const falloff = 1 - d / R;                 // stronger near the click
        const force = falloff * BG_CONFIG.clickStrength;
        p.ix += (dx / d) * force;                  // push outward
        p.iy += (dy / d) * force;
        p.energy = Math.min(1, p.energy + falloff * BG_CONFIG.clickEnergy);
      }
    }
    ripples.push({ x: x, y: y, start: performance.now() });
  }

  /* Single animation loop: updates + draws particles, cursor glow and
     ripples. Keeping one loop avoids duplicate/leaking RAF callbacks. */
  function step() {
    if (!running) return;

    // ---- clear ----
    ctx.clearRect(0, 0, width, height);
    rctx.clearRect(0, 0, width, height);

    // ---- update particles ----
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];

      // subtle mouse repulsion (particles drift away from the cursor)
      if (mouse.active) {
        const dx = p.x - mouse.x;
        const dy = p.y - mouse.y;
        const d = Math.hypot(dx, dy);
        if (d < BG_CONFIG.mouseRadius && d > 0.01) {
          const f = (1 - d / BG_CONFIG.mouseRadius) * BG_CONFIG.mouseRepelStrength;
          p.ix += (dx / d) * f;
          p.iy += (dy / d) * f;
        }
      }

      // move = base drift + decaying interaction velocity
      p.x += p.vx + p.ix;
      p.y += p.vy + p.iy;

      // decay interaction velocity (smooth return to normal movement)
      p.ix *= 0.93;
      p.iy *= 0.93;

      // decay energy (brightness returns to normal)
      p.energy *= 0.94;
      if (p.energy < 0.003) p.energy = 0;

      // keep base drift slow and constant
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > BG_CONFIG.particleSpeed) {
        p.vx = (p.vx / sp) * BG_CONFIG.particleSpeed;
        p.vy = (p.vy / sp) * BG_CONFIG.particleSpeed;
      }

      // wrap around the viewport edges
      if (p.x < -20) p.x = width + 20;
      else if (p.x > width + 20) p.x = -20;
      if (p.y < -20) p.y = height + 20;
      else if (p.y > height + 20) p.y = -20;
    }

    // ---- draw particle-to-particle links ----
    const linkDist = connectDistance();
    ctx.lineWidth = BG_CONFIG.lineWidth;
    for (let i = 0; i < particles.length; i++) {
      const a = particles[i];
      for (let j = i + 1; j < particles.length; j++) {
        const b = particles[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dSq = dx * dx + dy * dy;
        if (dSq < linkDist * linkDist) {
          const d = Math.sqrt(dSq);
          const base = (1 - d / linkDist) * BG_CONFIG.connectionOpacity;
          // brighter if either endpoint is "energised" by a click/close cursor
          const boost = Math.min(a.energy, b.energy) * 0.5;
          const alpha = Math.min(0.9, base + boost);
          ctx.strokeStyle = "rgba(" + BG_CONFIG.lineColor + "," + alpha.toFixed(3) + ")";
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    // ---- cursor: glow + extra connections to nearby particles ----
    if (mouse.active) {
      // soft glow around the cursor
      ctx.globalAlpha = BG_CONFIG.cursorGlowOpacity;
      const gr = BG_CONFIG.cursorGlowRadius;
      ctx.drawImage(glowSprite, mouse.x - gr, mouse.y - gr, gr * 2, gr * 2);
      ctx.globalAlpha = 1;

      // connect particles close to the cursor (denser network near pointer)
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        const dx = p.x - mouse.x;
        const dy = p.y - mouse.y;
        const d = Math.hypot(dx, dy);
        if (d < BG_CONFIG.mouseLinkDistance) {
          const alpha = (1 - d / BG_CONFIG.mouseLinkDistance) * 0.3;
          ctx.strokeStyle = "rgba(" + BG_CONFIG.cursorColor + "," + alpha.toFixed(3) + ")";
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(mouse.x, mouse.y);
          ctx.stroke();
        }
      }
    }

    // ---- draw nodes (soft glow sprite + bright core) ----
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const glowR = p.r * 4 * (1 + p.energy * 1.5);
      ctx.globalAlpha = 0.35 + p.energy * 0.6;
      ctx.drawImage(glowSprite, p.x - glowR, p.y - glowR, glowR * 2, glowR * 2);
      ctx.globalAlpha = 1;

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (1 + p.energy * 0.6), 0, Math.PI * 2);
      ctx.fillStyle = "rgba(" + BG_CONFIG.dotColor + "," + (0.55 + p.energy * 0.45).toFixed(3) + ")";
      ctx.fill();
    }

    // ---- draw click ripples (on the layer above particles) ----
    if (ripples.length) {
      const now = performance.now();
      ripples = ripples.filter((r) => now - r.start < BG_CONFIG.rippleDuration);
      for (let k = 0; k < ripples.length; k++) {
        const r = ripples[k];
        const t = (now - r.start) / BG_CONFIG.rippleDuration; // 0..1
        const eased = 1 - Math.pow(1 - t, 3);                 // ease-out
        const radius = BG_CONFIG.rippleMaxRadius * eased;
        const alpha = (1 - t) * 0.6;

        const g = rctx.createRadialGradient(r.x, r.y, radius * 0.6, r.x, r.y, radius * 1.4);
        g.addColorStop(0, "rgba(255,255,255," + (alpha * 0.45).toFixed(3) + ")");
        g.addColorStop(1, "rgba(255,255,255,0)");
        rctx.fillStyle = g;
        rctx.beginPath();
        rctx.arc(r.x, r.y, radius * 1.4, 0, Math.PI * 2);
        rctx.fill();

        rctx.strokeStyle = "rgba(255,255,255," + alpha.toFixed(3) + ")";
        rctx.lineWidth = 1.6;
        rctx.beginPath();
        rctx.arc(r.x, r.y, radius, 0, Math.PI * 2);
        rctx.stroke();
      }
    }

    rafId = requestAnimationFrame(step);
  }

  /* Start / restart the loop safely (never two loops at once). */
  function startNetwork() {
    resize();
    createParticles();
    running = true;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(step);
  }

  /* ---- events ---- */
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    // debounce resize; rebuild the field after the viewport settles
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resize();
      createParticles();
    }, 150);
  });

  // Track the cursor for the mouse interaction (clientX/Y are viewport-based)
  window.addEventListener("mousemove", (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.active = true;
  });
  window.addEventListener("mouseleave", () => {
    mouse.x = null;
    mouse.y = null;
    mouse.active = false;
  });

  // Pause the loop when the tab is hidden (saves CPU/GPU); resume on return.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      running = false;
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    } else if (!rafId) {
      running = true;
      rafId = requestAnimationFrame(step);
    }
  });

  // Background click only — ignore clicks on the login card, inputs or
  // buttons so the form keeps working exactly as before.
  document.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest(".login-card")) return;
    applyClick(e.clientX, e.clientY);
  });

  startNetwork();

  /* ---------------- Password visibility toggle ---------------- */
  const passwordInput = document.getElementById("password");
  const toggleBtn = document.getElementById("toggle-password");

  toggleBtn.addEventListener("click", () => {
    const isPassword = passwordInput.type === "password";
    passwordInput.type = isPassword ? "text" : "password";
    toggleBtn.classList.toggle("showing", isPassword);
    toggleBtn.setAttribute("aria-pressed", String(isPassword));
    toggleBtn.setAttribute("aria-label", isPassword ? "Hide password" : "Show password");
  });

  /* ---------------- Form validation ---------------- */
  const form = document.getElementById("login-form");
  const usernameInput = document.getElementById("username");
  const usernameError = document.getElementById("username-error");
  const passwordError = document.getElementById("password-error");
  const formError = document.getElementById("form-error");
  const signinBtn = document.getElementById("signin-btn");

  function setFieldError(input, errorEl, message) {
    if (message) {
      input.setAttribute("aria-invalid", "true");
      errorEl.textContent = message;
    } else {
      input.removeAttribute("aria-invalid");
      errorEl.textContent = "";
    }
  }

  function validateField(input, errorEl) {
    const value = input.value.trim();
    if (!value) {
      setFieldError(input, errorEl, "This field is required.");
      return false;
    }
    setFieldError(input, errorEl, "");
    return true;
  }

  function clearErrors() {
    setFieldError(usernameInput, usernameError, "");
    setFieldError(passwordInput, passwordError, "");
    formError.textContent = "";
  }

  usernameInput.addEventListener("input", () => validateField(usernameInput, usernameError));
  passwordInput.addEventListener("input", () => validateField(passwordInput, passwordError));

  form.addEventListener("submit", (e) => {
    e.preventDefault();

    const userOk = validateField(usernameInput, usernameError);
    const passOk = validateField(passwordInput, passwordError);

    if (!userOk || !passOk) {
      usernameInput.focus();
      return;
    }

    // Clear any previous generic error
    formError.textContent = "";

    // Loading state
    signinBtn.classList.add("loading");
    signinBtn.disabled = true;

    // Authenticate against the backend login endpoint.
    const payload = {
      username: usernameInput.value.trim(),
      password: passwordInput.value
    };

    fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then((res) => res.json())
      .then((data) => {
        if (data && data.ok) {
          // Successful login — go to the dashboard.
          window.location.href = "/";
        } else {
          signinBtn.classList.remove("loading");
          signinBtn.disabled = false;
          formError.textContent =
            (data && data.error) || "Invalid username or password.";
        }
      })
      .catch(() => {
        signinBtn.classList.remove("loading");
        signinBtn.disabled = false;
        formError.textContent = "Unable to reach the server. Please try again.";
      });
  });

  /* ---------------- Cleanup (defensive) ---------------- */
  window.addEventListener("beforeunload", () => {
    if (rafId) cancelAnimationFrame(rafId);
  });
})();
