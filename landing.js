/* ==========================================================================
   FlipSmart landing page
   Three jobs: run the narrated product tour, handle sign-up / sign-in, and
   keep the page feeling alive without being noisy.
   ========================================================================== */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Deep links belong to the app, not the brochure. A lender opening
  // #/share/abc123 or a bookmarked #/p/xyz gets forwarded straight through.
  if (/^#\/(p|share)\b/.test(location.hash)) {
    location.replace("app.html" + location.hash);
    return;
  }

  var $ = function (id) { return document.getElementById(id); };

  document.getElementById("year").textContent = String(new Date().getFullYear());

  // =========================================================================
  // NAV
  // =========================================================================
  var nav = $("nav");
  var burger = $("nav-burger");

  window.addEventListener("scroll", function () {
    nav.classList.toggle("stuck", window.scrollY > 16);
  }, { passive: true });

  burger.addEventListener("click", function () {
    var open = nav.classList.toggle("open");
    burger.setAttribute("aria-expanded", String(open));
  });
  nav.addEventListener("click", function (ev) {
    if (ev.target.closest(".nav-links a")) {
      nav.classList.remove("open");
      burger.setAttribute("aria-expanded", "false");
    }
  });

  // =========================================================================
  // COUNTERS + SCROLL REVEAL
  // =========================================================================
  function money(n) {
    return "$" + Math.round(n).toLocaleString("en-US");
  }

  function countUp(el) {
    var target = Number(el.dataset.count);
    if (reduceMotion) { el.textContent = money(target); return; }
    var start = performance.now();
    var dur = 1400;
    (function step(now) {
      var t = Math.min(1, (now - start) / dur);
      // Ease out so it lands softly instead of slamming to a stop.
      el.textContent = money(target * (1 - Math.pow(1 - t, 3)));
      if (t < 1) requestAnimationFrame(step);
    })(start);
  }

  var seen = new WeakSet();
  var io = "IntersectionObserver" in window
    ? new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting || seen.has(e.target)) return;
          seen.add(e.target);
          if (e.target.dataset.count) countUp(e.target);
          else e.target.classList.add("in");
        });
      }, { threshold: 0.25 })
    : null;

  document.querySelectorAll("[data-count]").forEach(function (el) {
    if (io) io.observe(el); else el.textContent = money(Number(el.dataset.count));
  });

  document
    .querySelectorAll(".prob, .feat, .math, .step, .tcard, .stat, .theatre")
    .forEach(function (el) {
      if (!io) return;
      el.classList.add("reveal");
      io.observe(el);
    });

  // Stagger inside a tour screen is driven off data-r so the markup stays
  // readable: r=1 shows first, r=2 a beat later, and so on.
  document.querySelectorAll(".screen [data-r]").forEach(function (el) {
    el.style.setProperty("--d", (Number(el.dataset.r) - 1) * 130);
  });

  // =========================================================================
  // THE TOUR
  // =========================================================================
  var CHAPTERS = [
    {
      screen: "dashboard",
      path: "/dashboard",
      tag: "Dashboard",
      title: "Every deal on one screen",
      lines: [
        "This is FlipSmart. Everything starts here, on the portfolio screen.",
        "One number across every project you are running: one million, two hundred and sixty four thousand dollars is in the ground right now, across three deals.",
        "Each card is a live deal. Its true all-in cost, its projected profit, how much of the budget is gone, and the date it is due to finish.",
        "Harbour Row is in red. It has burned a hundred and seventeen percent of its budget and two phases are late. You knew that before you opened it.",
        "And up top, FlipSmart is already telling you that an electrician's insurance certificate expires in nine days."
      ]
    },
    {
      screen: "receipt",
      path: "/p/maple/expenses/new",
      tag: "Add expense",
      title: "Photograph a receipt",
      lines: [
        "Here is how money gets into the system. You are standing at the lumber yard counter. You photograph the receipt.",
        "FlipSmart reads it on the phone itself. No upload, no third party service, no waiting.",
        "It pulls out twelve hundred and eighty four dollars and sixty cents, the date, and the vendor, Prime Lumber Company.",
        "Then it does the thinking. Lumber means framing, so it sets the phase to framing and structural, the cost type to materials, and it matches the vendor to Ridgeline Framing, a contractor already in your directory.",
        "You glance, correct anything it got wrong, and save. The photo is squeezed from four megabytes down to two hundred kilobytes on the way out."
      ]
    },
    {
      screen: "ledger",
      path: "/p/maple/expenses",
      tag: "Expenses",
      title: "The ledger, grouped your way",
      lines: [
        "That expense lands in the ledger, highlighted, already filed under framing and structural.",
        "Group the whole ledger by phase, by cost type, or by which partner paid. The subtotals follow you.",
        "Every row carries its date, who it was payable to, what kind of cost it was, who paid it, and the receipt image itself.",
        "When your accountant asks, it exports to a spreadsheet in one click, or prints to a clean PDF."
      ]
    },
    {
      screen: "budget",
      path: "/p/maple/budget",
      tag: "Budget",
      title: "Budget against reality",
      lines: [
        "Now the part that saves deals. Budget against actual, phase by phase.",
        "Green is inside budget. Amber is over, but still inside the ten percent tolerance you set. Red is genuinely over.",
        "Mechanical, electrical and plumbing came in at seventy seven thousand against sixty two thousand budgeted. Fifteen thousand four hundred over.",
        "Leave a phase with no budget and FlipSmart still tracks the spend, it just never accuses you of overrunning something you never priced.",
        "The moment a phase tips over, the project card on your portfolio screen turns red too."
      ]
    },
    {
      screen: "split",
      path: "/p/maple/overview",
      tag: "Partners",
      title: "Who takes home what",
      lines: [
        "This is the screen that ends arguments. The profit waterfall.",
        "First, every partner gets their own money back. One hundred and eighty eight thousand, six hundred and forty dollars of capital, returned before anybody sees profit.",
        "Second, the preferred return. Eight percent a year, accrued per dollar from the day that dollar was actually spent. A partner who funded in March is not treated like one who funded in September.",
        "Third, the upside. Ninety six thousand, nine hundred and forty eight dollars, split by the equity percentages you agreed at the start.",
        "Everyone sees the same table, and it always balances back to the proceeds. No spreadsheet, no weekend, no argument."
      ]
    },
    {
      screen: "schedule",
      path: "/p/maple/schedule",
      tag: "Schedule",
      title: "The critical path, priced",
      lines: [
        "Time is money on a flip, so FlipSmart schedules the build as well as the budget.",
        "Start from a typical twelve phase rehab and bend it to your job. Set durations, set what depends on what.",
        "FlipSmart runs the schedule forwards and backwards, works out how much slack each phase really has, and outlines the critical path in red.",
        "Rough-in mechanical, electrical and plumbing is six days late, and it sits on that critical path, so the whole finish date has moved to the fourteenth of October.",
        "And it prices the damage. Your holding costs run two hundred and fourteen dollars a day, so those six days cost you one thousand, two hundred and eighty four dollars."
      ]
    },
    {
      screen: "loan",
      path: "/p/maple/loan",
      tag: "Loan",
      title: "The loan and the draws",
      lines: [
        "If the deal is financed, FlipSmart tracks the loan properly.",
        "Two hundred and forty thousand funded at closing, forty one thousand five hundred drawn since, eighteen thousand five hundred of holdback still available, and a payoff at sale of two hundred and eighty one thousand five hundred.",
        "When it is time to draw, FlipSmart gathers every reimbursable expense since your last draw and pre-ticks them. Untick anything the lender will not cover.",
        "Out comes a proper itemised draw request. Property, borrower, loan position, subtotals by category, certification wording and a signature line. It warns you if you exceed the holdback, or if any line has no receipt behind it.",
        "And note this: a draw hands back money you already spent. FlipSmart never adds it to your all-in twice. That single rule is where most flip spreadsheets quietly go wrong."
      ]
    },
    {
      screen: "crew",
      path: "/contractors",
      tag: "Contractors",
      title: "Crew records and 1099s",
      lines: [
        "One contractor directory across every project you run.",
        "Who has a W-9 on file, whose insurance certificate is current, whose licence is about to lapse. FlipSmart warns you thirty days out, not the day the inspector asks.",
        "It also totals what you paid each contractor this year, counting labour and services and correctly ignoring materials.",
        "Four of these are past the six hundred dollar threshold and need a ten ninety nine. Cedar Tile has no W-9 on file, so you chase it now, in August, instead of in January."
      ]
    },
    {
      screen: "share",
      path: "/p/maple/access",
      tag: "Sharing",
      title: "Sharing, and no signal",
      lines: [
        "Last part. Who gets to see all this.",
        "People with accounts get a role. Owner, editor, or viewer. That is enforced inside the database itself, not by hiding buttons in the browser.",
        "Your lender does not need an account at all. Generate a read-only link and choose exactly what it reveals: the budget and the schedule, but not your expense descriptions and not what your partners are making. Set it to expire, or revoke it, and it dies instantly.",
        "And all of this works in a basement with no bars. FlipSmart keeps writing to the phone, tells you exactly how many changes are waiting, and replays them oldest first the moment you get a signal.",
        "That is FlipSmart. Create an account, open your first deal, and photograph the first receipt today."
      ]
    }
  ];

  var stage = $("stage");
  var screensEl = $("screens");
  var captionEl = $("caption");
  var listEl = $("chapter-list");
  var fillEl = $("tp-fill");
  var timeEl = $("tp-time");
  var playIcon = $("tp-icon");
  var overlayPlay = $("stage-play");
  var voiceToggle = $("voice-toggle");
  var urlPath = $("url-path");
  var chromeTag = $("chrome-tag");

  var PLAY_PATH = "M8 5v14l11-7z";
  var PAUSE_PATH = "M7 5h4v14H7zM13 5h4v14h-4z";

  var TOTAL_LINES = CHAPTERS.reduce(function (n, c) { return n + c.lines.length; }, 0);

  var state = { chapter: 0, line: 0, playing: false, started: false };
  var timer = null;
  var watchdog = null;
  var speech = window.speechSynthesis || null;
  var voice = null;

  // Chapter rail ------------------------------------------------------------
  CHAPTERS.forEach(function (c, i) {
    var li = document.createElement("li");
    var b = document.createElement("button");
    b.type = "button";
    b.innerHTML = '<span class="cn">' + (i + 1) + "</span><span>" + c.title + "</span>";
    b.addEventListener("click", function () { goTo(i, true); });
    li.appendChild(b);
    listEl.appendChild(li);
  });
  var chapterItems = Array.prototype.slice.call(listEl.children);

  function pickVoice() {
    if (!speech) return;
    var all = speech.getVoices() || [];
    if (!all.length) return;
    var english = all.filter(function (v) { return /^en(-|_|$)/i.test(v.lang); });
    var pool = english.length ? english : all;
    // Prefer a natural-sounding voice where the platform ships one, but never
    // fail over a name that does not exist on this device.
    var preferred = ["Google UK English Male", "Google US English", "Samantha", "Daniel", "Microsoft Aria", "Microsoft Guy", "Microsoft Ryan"];
    for (var i = 0; i < preferred.length; i++) {
      var hit = pool.find(function (v) { return v.name.indexOf(preferred[i]) === 0; });
      if (hit) { voice = hit; return; }
    }
    voice = pool.find(function (v) { return v.localService; }) || pool[0];
  }
  if (speech) {
    pickVoice();
    speech.addEventListener("voiceschanged", pickVoice);
    // Some browsers only expose voices behind a user gesture or a tick later.
    setTimeout(pickVoice, 400);
  } else {
    voiceToggle.checked = false;
    voiceToggle.disabled = true;
    $("voice-note").textContent = "This browser has no built-in voice. Captions only.";
  }

  function clearTimers() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
  }

  function hush() {
    clearTimers();
    if (speech) { try { speech.cancel(); } catch (e) { /* nothing useful to do */ } }
  }

  function readingTime(text) {
    // About 160 words a minute, with a floor so a short line is still readable.
    var words = text.trim().split(/\s+/).length;
    return Math.max(2600, Math.round((words / 160) * 60000) + 700);
  }

  function showScreen(key) {
    Array.prototype.forEach.call(screensEl.children, function (s) {
      var on = s.dataset.screen === key;
      // Re-triggering the stagger needs the animation to be torn down first.
      if (on && !s.classList.contains("on")) {
        s.querySelectorAll("[data-r]").forEach(function (el) {
          el.style.animation = "none";
          void el.offsetWidth;
          el.style.animation = "";
        });
      }
      s.classList.toggle("on", on);
    });
  }

  function paint() {
    var c = CHAPTERS[state.chapter];
    showScreen(c.screen);
    urlPath.textContent = c.path;
    chromeTag.textContent = c.tag;
    captionEl.textContent = c.lines[state.line];

    chapterItems.forEach(function (li, i) {
      li.classList.toggle("active", i === state.chapter);
      li.classList.toggle("seen", i < state.chapter);
    });

    var done = CHAPTERS.slice(0, state.chapter).reduce(function (n, ch) { return n + ch.lines.length; }, 0) + state.line + 1;
    fillEl.style.width = (done / TOTAL_LINES) * 100 + "%";
    timeEl.textContent = (state.chapter + 1) + " / " + CHAPTERS.length;
  }

  function speakCurrent() {
    var text = CHAPTERS[state.chapter].lines[state.line];
    var fallback = readingTime(text);

    if (!speech || !voiceToggle.checked) {
      timer = setTimeout(advance, fallback);
      return;
    }

    var u = new SpeechSynthesisUtterance(text);
    if (voice) { u.voice = voice; u.lang = voice.lang; } else { u.lang = "en-US"; }
    u.rate = 1.0;
    u.pitch = 1.0;
    var handled = false;
    function once() { if (!handled) { handled = true; clearTimers(); advance(); } }
    u.onend = once;
    // Chrome drops onend on long utterances often enough that a watchdog is not
    // optional. Generous, so it only ever fires when speech really has stalled.
    u.onerror = once;
    watchdog = setTimeout(once, fallback * 2.4 + 4000);
    try {
      speech.cancel();
      speech.speak(u);
    } catch (e) {
      clearTimers();
      timer = setTimeout(advance, fallback);
    }
  }

  function advance() {
    if (!state.playing) return;
    var c = CHAPTERS[state.chapter];
    if (state.line + 1 < c.lines.length) {
      state.line++;
    } else if (state.chapter + 1 < CHAPTERS.length) {
      state.chapter++;
      state.line = 0;
    } else {
      paint();
      pause();
      captionEl.textContent = "That is the whole tour. Ready to run your own deal?";
      chapterItems.forEach(function (li) { li.classList.add("seen"); });
      return;
    }
    paint();
    speakCurrent();
  }

  function play() {
    state.playing = true;
    state.started = true;
    overlayPlay.classList.add("gone");
    playIcon.setAttribute("d", PAUSE_PATH);
    $("tp-play").setAttribute("aria-label", "Pause");
    paint();
    speakCurrent();
  }

  function pause() {
    state.playing = false;
    hush();
    playIcon.setAttribute("d", PLAY_PATH);
    $("tp-play").setAttribute("aria-label", "Play");
  }

  function goTo(index, autoplay) {
    hush();
    state.chapter = Math.max(0, Math.min(CHAPTERS.length - 1, index));
    state.line = 0;
    overlayPlay.classList.add("gone");
    state.started = true;
    paint();
    if (autoplay || state.playing) { state.playing = true; playIcon.setAttribute("d", PAUSE_PATH); speakCurrent(); }
  }

  overlayPlay.addEventListener("click", play);
  $("tp-play").addEventListener("click", function () { state.playing ? pause() : play(); });
  $("tp-next").addEventListener("click", function () { goTo(state.chapter + 1, state.playing); });
  $("tp-prev").addEventListener("click", function () { goTo(state.chapter - 1, state.playing); });
  $("tp-restart").addEventListener("click", function () {
    chapterItems.forEach(function (li) { li.classList.remove("seen"); });
    goTo(0, true);
  });

  voiceToggle.addEventListener("change", function () {
    if (!state.playing) { if (speech) speech.cancel(); return; }
    hush();
    speakCurrent();
  });

  // Leaving the tab mid-sentence and coming back to a voice talking to nobody
  // is worse than losing your place.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden && state.playing) pause();
  });

  // Stop narrating once the tour has scrolled well out of view.
  if (io) {
    new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (!e.isIntersecting && state.playing) pause(); });
    }, { threshold: 0 }).observe(stage);
  }

  paint();

  // =========================================================================
  // AUTH
  // =========================================================================
  var overlay = $("auth-overlay");
  var form = $("auth-form");
  var emailEl = $("auth-email");
  var passEl = $("auth-password");
  var errEl = $("auth-err");
  var okEl = $("auth-ok");
  var submitEl = $("auth-submit");
  var tabUp = $("tab-signup");
  var tabIn = $("tab-signin");
  var mode = "signup";
  var client = null;
  var lastFocus = null;

  function supa() {
    if (client) return client;
    if (!window.supabase || typeof SUPABASE_CONFIG === "undefined" || !SUPABASE_CONFIG.url) return null;
    client = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
    return client;
  }

  function setMode(next) {
    mode = next === "signin" ? "signin" : "signup";
    var up = mode === "signup";
    tabUp.classList.toggle("active", up);
    tabIn.classList.toggle("active", !up);
    $("auth-title").textContent = up ? "Start your first project" : "Welcome back";
    $("auth-hint").textContent = up
      ? "Free, no card. One account covers every deal you run."
      : "Sign in to pick up exactly where you left off.";
    submitEl.textContent = up ? "Create account" : "Sign in";
    passEl.setAttribute("autocomplete", up ? "new-password" : "current-password");
    passEl.placeholder = up ? "At least 8 characters" : "Your password";
    $("auth-foot").innerHTML = up
      ? 'Already have an account? <button type="button" class="linkish" data-auth="signin">Sign in</button>'
      : 'No account yet? <button type="button" class="linkish" data-auth="signup">Create one</button>';
    errEl.classList.add("hidden");
    okEl.classList.add("hidden");
  }

  function openAuth(next) {
    lastFocus = document.activeElement;
    setMode(next);
    overlay.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    setTimeout(function () { emailEl.focus(); }, 30);
  }

  function closeAuth() {
    overlay.classList.add("hidden");
    document.body.style.overflow = "";
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  document.addEventListener("click", function (ev) {
    var trigger = ev.target.closest("[data-auth]");
    if (trigger) {
      ev.preventDefault();
      if (state.playing) pause();
      openAuth(trigger.dataset.auth);
    }
  });
  tabUp.addEventListener("click", function () { setMode("signup"); });
  tabIn.addEventListener("click", function () { setMode("signin"); });
  $("auth-close").addEventListener("click", closeAuth);
  overlay.addEventListener("click", function (ev) { if (ev.target === overlay) closeAuth(); });
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && !overlay.classList.contains("hidden")) closeAuth();
  });

  form.addEventListener("submit", async function (ev) {
    ev.preventDefault();
    errEl.classList.add("hidden");
    okEl.classList.add("hidden");

    var email = emailEl.value.trim();
    var password = passEl.value;
    if (!email || !password) return fail("Enter your email and a password.");
    if (mode === "signup" && password.length < 8) return fail("Use at least 8 characters.");

    var db = supa();
    if (!db) {
      // config.js is missing or unfilled: hand off rather than dead-end.
      location.href = "app.html?auth=" + mode;
      return;
    }

    submitEl.disabled = true;
    submitEl.textContent = mode === "signup" ? "Creating\u2026" : "Signing in\u2026";
    try {
      if (mode === "signup") {
        var res = await db.auth.signUp({ email: email, password: password });
        if (res.error) throw res.error;
        if (res.data && res.data.session) return done();
        setMode("signin");
        okEl.textContent = "Account created. Check " + email + " for the confirmation link, then sign in.";
        okEl.classList.remove("hidden");
      } else {
        var out = await db.auth.signInWithPassword({ email: email, password: password });
        if (out.error) throw out.error;
        return done();
      }
    } catch (err) {
      fail((err && err.message) || "Something went wrong. Try again.");
    } finally {
      submitEl.disabled = false;
      submitEl.textContent = mode === "signup" ? "Create account" : "Sign in";
    }
  });

  function fail(msg) {
    errEl.textContent = msg;
    errEl.classList.remove("hidden");
  }

  function done() {
    submitEl.textContent = "Opening FlipSmart\u2026";
    location.href = "app.html";
  }

  // Somebody already signed in on this device should not be sold to twice.
  (async function () {
    var db = supa();
    if (!db) return;
    try {
      var s = await db.auth.getSession();
      if (s.data && s.data.session) {
        document.querySelectorAll('[data-auth="signin"]').forEach(function (b) {
          b.textContent = "Open the app";
          b.removeAttribute("data-auth");
          b.addEventListener("click", function () { location.href = "app.html"; });
        });
      }
    } catch (e) { /* not signed in, which is the normal case */ }
  })();

  // Service worker: same shell the app registers, so the landing page is
  // available offline too once it has been seen.
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () { /* fine without it */ });
    });
  }
})();
