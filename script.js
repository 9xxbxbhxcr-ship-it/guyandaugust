/**
 * Couple app — localStorage, optional session (one-time “password” on device).
 * Live GPS: watchPosition for the logged-in person only (Guy → me, August → her).
 *
 * Passwords are checked only in the browser (not secure for public apps).
 */

/* global: showScreen, toggleManual, getGPS, calcDistance, calcManual, addMemory, deleteMemory, startCam, takeSnap, retake, flipCam, tryLogin, signOut */

var DB_KEY = "coupleapp_v3";
var SNAPS_KEY = "coupleapp_v3_snaps";
var SESSION_KEY = "coupleapp_v3_session";

/** One-time device passwords (trimmed input, exact match). */
var PASS_AUGUST = "AUGUST 11";
var PASS_GUY = "GUY11";

var GEOCODE_MIN_INTERVAL_MS = 45000;
var SAVE_COORDS_MIN_INTERVAL_MS = 4000;
var MAX_SNAPS = 32;
var SNAP_JPEG_QUALITY = 0.72;

var appData = { memories: [], snaps: [] };
var coords = { me: null, her: null };
var camStream = null;
var camFacingMode = "user";

var watchId = null;
var lastGeocodeAt = { me: 0, her: 0 };
var lastCoordsSaveAt = 0;
var deferredInstallPrompt = null;
/** After live GPS fails, show "use GPS" again for the logged-in row. */
var liveGpsBlocked = false;

function getSession() {
  try {
    var raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    var o = JSON.parse(raw);
    if (o && (o.role === "guy" || o.role === "august")) return o;
  } catch (e) {}
  return null;
}

function saveSession(role) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ role: role, savedAt: Date.now() }));
  } catch (e) {}
}

function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch (e) {}
}

function trackedWho() {
  var s = getSession();
  if (!s) return null;
  return s.role === "guy" ? "me" : "her";
}

function loadData() {
  appData.memories = [];
  appData.snaps = [];
  coords.me = null;
  coords.her = null;
  var legacySnaps = null;
  try {
    var raw = localStorage.getItem(DB_KEY);
    if (raw) {
      var o = JSON.parse(raw);
      if (Array.isArray(o.memories)) appData.memories = o.memories.slice();
      if (o.coords && typeof o.coords === "object") {
        coords.me = o.coords.me || null;
        coords.her = o.coords.her || null;
      }
      if (Array.isArray(o.snaps) && o.snaps.length) legacySnaps = o.snaps.slice();
    }
    var snapRaw = localStorage.getItem(SNAPS_KEY);
    if (snapRaw) {
      var arr = JSON.parse(snapRaw);
      if (Array.isArray(arr) && arr.length) appData.snaps = arr;
    } else if (legacySnaps && legacySnaps.length) {
      appData.snaps = legacySnaps;
      try {
        localStorage.setItem(SNAPS_KEY, JSON.stringify(legacySnaps));
        var o2 = JSON.parse(localStorage.getItem(DB_KEY) || "{}");
        delete o2.snaps;
        o2.memories = appData.memories;
        o2.coords = { me: coords.me, her: coords.her };
        o2.v = 2;
        localStorage.setItem(DB_KEY, JSON.stringify(o2));
      } catch (migErr) {}
    }
  } catch (e) {}
}

function saveMainPayload() {
  return JSON.stringify({
    memories: appData.memories,
    coords: { me: coords.me, her: coords.her },
    v: 2,
  });
}

function saveSnapsPayload() {
  return JSON.stringify(appData.snaps);
}

function saveMainToStorage() {
  try {
    localStorage.setItem(DB_KEY, saveMainPayload());
    return true;
  } catch (e) {
    console.warn("coupleapp: could not save memories/locations", e);
    return false;
  }
}

function saveSnapsToStorage() {
  while (appData.snaps.length > MAX_SNAPS) {
    appData.snaps.pop();
  }
  try {
    localStorage.setItem(SNAPS_KEY, saveSnapsPayload());
    return true;
  } catch (e) {
    if (e && (e.name === "QuotaExceededError" || e.code === 22)) {
      while (appData.snaps.length > 1) {
        appData.snaps.pop();
        try {
          localStorage.setItem(SNAPS_KEY, saveSnapsPayload());
          alert("Phone storage was almost full — oldest snaps were removed to keep saving.");
          return true;
        } catch (e2) {}
      }
      try {
        localStorage.setItem(SNAPS_KEY, "[]");
      } catch (e3) {}
      alert("Could not save photos — try deleting snaps or using less storage in the browser.");
    } else {
      console.warn("coupleapp: could not save snaps", e);
    }
    return false;
  }
}

/**
 * @param {{ coordsOnly?: boolean }} [opts] — if coordsOnly, only memories+coords are written (not huge snaps). Use after GPS/distance updates.
 */
function saveData(opts) {
  opts = opts || {};
  saveMainToStorage();
  if (!opts.coordsOnly) {
    saveSnapsToStorage();
  }
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(d) {
  if (!d) return "";
  var parts = d.split("-");
  if (parts.length !== 3) return d;
  var months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return parseInt(parts[2], 10) + " " + months[parseInt(parts[1], 10) - 1] + " " + parts[0];
}

function gpsButtonDefaultHtml() {
  return '<span class="loc-btn-icon" aria-hidden="true">📍</span> use GPS';
}

function gpsButtonDoneHtml() {
  return '<span class="loc-btn-icon" aria-hidden="true">✓</span> got it';
}

function isPartnerGpsDisabled(who) {
  var s = getSession();
  if (!s) return false;
  if (s.role === "guy" && who === "her") return true;
  if (s.role === "august" && who === "me") return true;
  return false;
}

function applyRoleUI() {
  var w = trackedWho();
  var meBtn = document.getElementById("me-gps-btn");
  var meLive = document.getElementById("me-live-badge");
  var herBtn = document.getElementById("her-gps-btn");
  var herLive = document.getElementById("her-live-badge");
  if (!meBtn || !herBtn || !meLive || !herLive) return;

  meBtn.disabled = false;
  herBtn.disabled = false;
  meBtn.classList.remove("loc-btn--partner-locked");
  herBtn.classList.remove("loc-btn--partner-locked");
  meBtn.removeAttribute("title");
  herBtn.removeAttribute("title");

  if (w === "me") {
    if (liveGpsBlocked) {
      meBtn.hidden = false;
      meLive.hidden = true;
    } else {
      meBtn.hidden = true;
      meLive.hidden = false;
    }
    herBtn.hidden = false;
    herLive.hidden = true;
    herBtn.disabled = true;
    herBtn.classList.add("loc-btn--partner-locked");
    herBtn.setAttribute(
      "title",
      "August’s location comes from her phone when she opens the app and logs in."
    );
  } else if (w === "her") {
    if (liveGpsBlocked) {
      herBtn.hidden = false;
      herLive.hidden = true;
    } else {
      herBtn.hidden = true;
      herLive.hidden = false;
    }
    meBtn.hidden = false;
    meLive.hidden = true;
    meBtn.disabled = true;
    meBtn.classList.add("loc-btn--partner-locked");
    meBtn.setAttribute(
      "title",
      "Guy’s location comes from his phone when he opens the app and logs in."
    );
  } else {
    meBtn.hidden = false;
    meLive.hidden = true;
    herBtn.hidden = false;
    herLive.hidden = true;
  }
}

function stopLiveGps() {
  if (watchId !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

function reverseLabel(lat, lon) {
  var url =
    "https://nominatim.openstreetmap.org/reverse?lat=" +
    encodeURIComponent(lat) +
    "&lon=" +
    encodeURIComponent(lon) +
    "&format=json";
  return fetch(url, { headers: { "Accept-Language": "en" } })
    .then(function (res) {
      return res.json();
    })
    .then(function (d) {
      var addr = (d && d.address) || {};
      var city =
        addr.city || addr.town || addr.village || addr.county || "";
      var country = addr.country || "";
      var parts = [city, country].filter(Boolean);
      if (parts.length) return parts.join(", ");
      return lat.toFixed(4) + ", " + lon.toFixed(4);
    })
    .catch(function () {
      return lat.toFixed(4) + ", " + lon.toFixed(4);
    });
}

function updateLocRowFromCoords(who) {
  var elId = who === "me" ? "me-loc-text" : "her-loc-text";
  var txt = document.getElementById(elId);
  if (!txt || !coords[who] || typeof coords[who].lat !== "number") return;
  var label = coords[who].label || coords[who].lat.toFixed(5) + ", " + coords[who].lon.toFixed(5);
  txt.innerHTML = '<span class="status-dot dot-green"></span>' + esc(label);
}

function maybeReverseGeocode(who, lat, lon) {
  var now = Date.now();
  if (now - (lastGeocodeAt[who] || 0) < GEOCODE_MIN_INTERVAL_MS) return;
  lastGeocodeAt[who] = now;
  reverseLabel(lat, lon).then(function (label) {
    if (!coords[who] || coords[who].lat !== lat || coords[who].lon !== lon) return;
    coords[who].label = label;
    updateLocRowFromCoords(who);
    saveData({ coordsOnly: true });
  });
}

function onWatchPosition(pos) {
  var who = trackedWho();
  if (!who) return;
  if (liveGpsBlocked) {
    liveGpsBlocked = false;
    applyRoleUI();
  }
  var lat = pos.coords.latitude;
  var lon = pos.coords.longitude;
  if (!coords[who]) coords[who] = {};
  coords[who].lat = lat;
  coords[who].lon = lon;
  if (!coords[who].label) coords[who].label = lat.toFixed(5) + ", " + lon.toFixed(5);

  var elId = who === "me" ? "me-loc-text" : "her-loc-text";
  var txt = document.getElementById(elId);
  if (txt) {
    var short = lat.toFixed(5) + ", " + lon.toFixed(5);
    txt.innerHTML =
      '<span class="status-dot dot-green dot-pulse" aria-hidden="true"></span>' +
      esc(short) +
      ' <span style="font-size:11px;color:#639922;font-weight:600;">live</span>';
  }

  calcDistance();

  var t = Date.now();
  if (t - lastCoordsSaveAt >= SAVE_COORDS_MIN_INTERVAL_MS) {
    lastCoordsSaveAt = t;
    saveData({ coordsOnly: true });
  }

  maybeReverseGeocode(who, lat, lon);
}

function onWatchError(err) {
  var who = trackedWho();
  if (!who) return;
  liveGpsBlocked = true;
  stopLiveGps();

  var elId = who === "me" ? "me-loc-text" : "her-loc-text";
  var txt = document.getElementById(elId);
  if (!txt) return;
  var msg = "location off";
  if (err && err.code === 1) msg = "permission denied";
  if (err && err.code === 2) msg = "location unavailable";
  if (err && err.code === 3) msg = "timed out";

  var hint = "";
  if (err && err.code === 1) {
    hint =
      '<div class="loc-perm-hint">On <strong>iPhone</strong>: Settings → Privacy &amp; Security → <strong>Location Services</strong> → scroll to <strong>Safari</strong> (or <strong>Safari Websites</strong>) → choose <strong>While Using</strong>. If you use a home-screen icon, location may be under that site’s name.</div>';
  } else if (!window.isSecureContext) {
    hint =
      '<div class="loc-perm-hint">This page is not using <strong>https://</strong>. Many phones block GPS on plain <strong>http</strong> except <strong>localhost</strong>. Try an https host (e.g. Netlify) or test with <code>http://127.0.0.1</code> on the same device.</div>';
  }

  txt.innerHTML = '<span class="status-dot dot-gray"></span>' + esc(msg) + hint;
  applyRoleUI();
}

function startLiveGps() {
  stopLiveGps();
  var who = trackedWho();
  if (!who || !navigator.geolocation) return;

  watchId = navigator.geolocation.watchPosition(
    onWatchPosition,
    onWatchError,
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 30000,
    }
  );
}

function restoreCoordsFromStorage() {
  function paint(who, elId) {
    var c = coords[who];
    var txt = document.getElementById(elId);
    if (!txt || !c || typeof c.lat !== "number") return;
    var label = c.label || c.lat.toFixed(4) + ", " + c.lon.toFixed(4);
    txt.innerHTML = '<span class="status-dot dot-green"></span>' + esc(label);
    var btn = document.getElementById(who + "-gps-btn");
    if (btn && trackedWho() !== who) btn.innerHTML = gpsButtonDoneHtml();
  }
  paint("me", "me-loc-text");
  paint("her", "her-loc-text");
  calcDistance();
}

function showMainApp() {
  var loginEl = document.getElementById("login-screen");
  var mainEl = document.getElementById("main-app");
  if (loginEl) loginEl.hidden = true;
  if (mainEl) mainEl.hidden = false;

  liveGpsBlocked = false;

  loadData();
  renderMemories();
  renderSnaps();
  restoreCoordsFromStorage();
  applyRoleUI();
  startLiveGps();

  var info = document.getElementById("gps-info-text");
  var s = getSession();
  if (info && s) {
    if (
      !window.isSecureContext &&
      location.hostname !== "localhost" &&
      location.hostname !== "127.0.0.1"
    ) {
      info.textContent =
        "If GPS never works: this address uses http (not https). Many phones only allow location on https or localhost. Upload the site to Netlify (free https) or use the same Wi‑Fi link from the install section.";
    } else if (s.role === "guy") {
      info.textContent =
        "Your position (Guy) updates continuously while this tab is open. August can open the same page on her phone, log in with her password, and her line will track the same way.";
    } else {
      info.textContent =
        "Your position (August) updates continuously while this tab is open. Guy can log in on his phone the same way. Distance updates when both locations are known.";
    }
  }
}

function tryLogin() {
  var input = document.getElementById("login-password");
  var errEl = document.getElementById("login-error");
  if (!input || !errEl) return;
  var raw = input.value.trim();
  errEl.hidden = true;
  errEl.textContent = "";

  if (raw === PASS_AUGUST) {
    saveSession("august");
    input.value = "";
    showMainApp();
    return;
  }
  if (raw === PASS_GUY) {
    saveSession("guy");
    input.value = "";
    showMainApp();
    return;
  }

  errEl.textContent = "Wrong password. Use AUGUST 11 or GUY11 (capital letters as shown).";
  errEl.hidden = false;
}

function signOut() {
  if (!confirm("Sign out on this device? You can log in again with your password.")) return;
  stopLiveGps();
  clearSession();
  location.reload();
}

function showScreen(name, btn) {
  var screens = document.querySelectorAll(".screen");
  for (var i = 0; i < screens.length; i++) screens[i].classList.remove("active");
  var navBtns = document.querySelectorAll(".bottom-nav .nav-btn");
  for (var j = 0; j < navBtns.length; j++) navBtns[j].classList.remove("active");
  var screen = document.getElementById("screen-" + name);
  if (screen) screen.classList.add("active");
  if (btn) btn.classList.add("active");
}

function toggleManual() {
  var sec = document.getElementById("manual-section");
  if (sec) sec.classList.toggle("open");
}

function getGPS(who) {
  if (trackedWho() === who && !liveGpsBlocked) return;
  if (isPartnerGpsDisabled(who)) return;

  var btn = document.getElementById(who + "-gps-btn");
  var txt = document.getElementById(who === "me" ? "me-loc-text" : "her-loc-text");
  if (!btn || !txt) return;
  btn.textContent = "locating...";
  btn.disabled = true;
  if (!navigator.geolocation) {
    txt.innerHTML = '<span class="status-dot dot-gray"></span>GPS not supported';
    btn.innerHTML = gpsButtonDefaultHtml();
    btn.disabled = false;
    return;
  }
  navigator.geolocation.getCurrentPosition(
    function (pos) {
      var lat = pos.coords.latitude;
      var lon = pos.coords.longitude;
      var label = lat.toFixed(4) + ", " + lon.toFixed(4);
      reverseLabel(lat, lon)
        .then(function (resolved) {
          label = resolved;
        })
        .catch(function () {})
        .then(function () {
          coords[who] = { lat: lat, lon: lon, label: label };
          lastGeocodeAt[who] = Date.now();
          saveData({ coordsOnly: true });
          txt.innerHTML = '<span class="status-dot dot-green"></span>' + esc(label);
          btn.innerHTML = gpsButtonDoneHtml();
          btn.disabled = false;
          calcDistance();
          if (trackedWho() === who) {
            liveGpsBlocked = false;
            applyRoleUI();
            startLiveGps();
          }
        });
    },
    function (err) {
      var msg = "permission denied";
      if (err.code === 2) msg = "location unavailable";
      if (err.code === 3) msg = "timed out";
      txt.innerHTML = '<span class="status-dot dot-gray"></span>' + esc(msg);
      btn.innerHTML = gpsButtonDefaultHtml();
      btn.disabled = false;
    },
    { enableHighAccuracy: true, timeout: 12000 }
  );
}

function haversine(lat1, lon1, lat2, lon2) {
  var R = 6371;
  var dLat = ((lat2 - lat1) * Math.PI) / 180;
  var dLon = ((lon2 - lon1) * Math.PI) / 180;
  var a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calcDistance() {
  var numEl = document.getElementById("dist-num");
  var unitEl = document.getElementById("dist-unit");
  if (!numEl || !unitEl) return;
  if (!coords.me || !coords.her) {
    numEl.textContent = "—";
    unitEl.textContent = "need both locations";
    saveData({ coordsOnly: true });
    return;
  }
  var km = haversine(coords.me.lat, coords.me.lon, coords.her.lat, coords.her.lon);
  numEl.textContent =
    km < 1 ? String(Math.round(km * 1000)) : String(Math.round(km)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  unitEl.textContent = km < 1 ? "meters apart 💕" : "km apart";
  saveData({ coordsOnly: true });
}

function geocode(place) {
  return fetch(
    "https://nominatim.openstreetmap.org/search?q=" +
      encodeURIComponent(place) +
      "&format=json&limit=1",
    { headers: { "Accept-Language": "en" } }
  )
    .then(function (res) {
      return res.json();
    })
    .then(function (data) {
      if (!data || !data.length) throw new Error("Place not found: " + place);
      return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
    });
}

function calcManual() {
  var me = document.getElementById("loc-me");
  var her = document.getElementById("loc-her");
  var unitEl = document.getElementById("dist-unit");
  if (!me || !her || !unitEl) return;
  var meV = me.value.trim();
  var herV = her.value.trim();
  if (!meV || !herV) {
    alert("Enter both city names");
    return;
  }
  unitEl.textContent = "looking up...";
  Promise.all([geocode(meV), geocode(herV)])
    .then(function (results) {
      coords.me = { lat: results[0].lat, lon: results[0].lon, label: meV };
      coords.her = { lat: results[1].lat, lon: results[1].lon, label: herV };
      saveData({ coordsOnly: true });
      document.getElementById("me-loc-text").innerHTML =
        '<span class="status-dot dot-green"></span>' + esc(meV);
      document.getElementById("her-loc-text").innerHTML =
        '<span class="status-dot dot-green"></span>' + esc(herV);
      var meBtn = document.getElementById("me-gps-btn");
      var herBtn = document.getElementById("her-gps-btn");
      if (meBtn && trackedWho() !== "me") meBtn.innerHTML = gpsButtonDoneHtml();
      if (herBtn && trackedWho() !== "her") herBtn.innerHTML = gpsButtonDoneHtml();
      calcDistance();
    })
    .catch(function (e) {
      unitEl.textContent = (e && e.message) || "place not found";
    });
}

function addMemory() {
  var titleEl = document.getElementById("mem-title");
  var dateEl = document.getElementById("mem-date");
  var noteEl = document.getElementById("mem-note");
  var tagEl = document.getElementById("mem-tag");
  if (!titleEl) return;
  var title = titleEl.value.trim();
  var date = dateEl ? dateEl.value : "";
  var note = noteEl ? noteEl.value.trim() : "";
  var tag = tagEl ? tagEl.value.trim() : "";
  if (!title) {
    alert("Please add a title");
    return;
  }
  appData.memories.unshift({ id: Date.now(), title: title, date: date, note: note, tag: tag });
  saveData();
  renderMemories();
  titleEl.value = "";
  if (dateEl) dateEl.value = "";
  if (noteEl) noteEl.value = "";
  if (tagEl) tagEl.value = "";
}

function deleteMemory(id) {
  appData.memories = appData.memories.filter(function (m) {
    return m.id !== id;
  });
  saveData();
  renderMemories();
}

function renderMemories() {
  var list = document.getElementById("mem-list");
  if (!list) return;
  if (!appData.memories.length) {
    list.innerHTML =
      '<div class="empty-state"><span class="empty-state-icon" aria-hidden="true">♥</span>no memories yet — add your first one!</div>';
    return;
  }
  list.innerHTML = appData.memories
    .map(function (m) {
      var dateHtml = m.date ? '<div class="memory-date">' + esc(formatDate(m.date)) + "</div>" : "";
      var noteHtml = m.note ? '<div class="memory-note">' + esc(m.note) + "</div>" : "";
      var tagHtml = m.tag ? '<span class="tag">' + esc(m.tag) + "</span>" : "";
      return (
        '<div class="memory-item">' +
        '<div class="memory-img" aria-hidden="true">🖼</div>' +
        '<div class="memory-info">' +
        '<div class="memory-title">' +
        esc(m.title) +
        "</div>" +
        dateHtml +
        noteHtml +
        tagHtml +
        "</div>" +
        '<button type="button" onclick="deleteMemory(' +
        m.id +
        ')" style="background:none;border:none;cursor:pointer;color:var(--color-text-secondary);padding:4px;" aria-label="Delete memory">🗑</button>' +
        "</div>"
      );
    })
    .join("");
}

function stopCam() {
  if (camStream) {
    camStream.getTracks().forEach(function (t) {
      t.stop();
    });
    camStream = null;
  }
}

function startCam() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert("Camera not available — please allow camera access.");
    return;
  }
  var constraints = {
    video: { facingMode: { ideal: camFacingMode } },
    audio: false,
  };
  navigator.mediaDevices
    .getUserMedia(constraints)
    .then(function (stream) {
      camStream = stream;
      var video = document.getElementById("cam-video");
      video.srcObject = stream;
      video.style.display = "block";
      document.getElementById("cam-placeholder").style.display = "none";
      document.getElementById("cam-canvas").style.display = "none";
      document.getElementById("cam-start-btn").style.display = "none";
      document.getElementById("cam-flip-btn").style.display = "inline-flex";
      document.getElementById("shutter-btn").style.display = "flex";
      document.getElementById("retake-btn").style.display = "none";
      return video.play();
    })
    .catch(function () {
      alert("Camera not available — please allow camera access.");
    });
}

function takeSnap() {
  var video = document.getElementById("cam-video");
  var canvas = document.getElementById("cam-canvas");
  if (!video || !canvas) return;
  canvas.width = video.videoWidth || 480;
  canvas.height = video.videoHeight || 640;
  canvas.getContext("2d").drawImage(video, 0, 0);
  var dataUrl = canvas.toDataURL("image/jpeg", SNAP_JPEG_QUALITY);
  video.style.display = "none";
  canvas.style.display = "block";
  stopCam();
  document.getElementById("shutter-btn").style.display = "none";
  document.getElementById("retake-btn").style.display = "inline-flex";
  appData.snaps.unshift({ id: Date.now(), img: dataUrl });
  while (appData.snaps.length > MAX_SNAPS) {
    appData.snaps.pop();
  }
  saveData();
  renderSnaps();
}

function retake() {
  var video = document.getElementById("cam-video");
  if (video) {
    video.srcObject = null;
    video.style.display = "none";
  }
  document.getElementById("cam-canvas").style.display = "none";
  document.getElementById("retake-btn").style.display = "none";
  document.getElementById("cam-flip-btn").style.display = "none";
  document.getElementById("cam-start-btn").style.display = "inline-flex";
  document.getElementById("cam-placeholder").style.display = "flex";
}

function flipCam() {
  camFacingMode = camFacingMode === "user" ? "environment" : "user";
  var video = document.getElementById("cam-video");
  var shutter = document.getElementById("shutter-btn");
  if (video && video.style.display === "block" && shutter && shutter.style.display !== "none") {
    stopCam();
    startCam();
  } else {
    var modeLabel = camFacingMode === "user" ? "front camera" : "back camera";
    alert("Camera set to " + modeLabel + ". Tap start camera.");
  }
}

function deleteSnap(id) {
  appData.snaps = appData.snaps.filter(function (s) {
    return s.id !== id;
  });
  saveData();
  renderSnaps();
}

function renderSnaps() {
  var gallery = document.getElementById("snap-gallery");
  if (!gallery) return;
  if (!appData.snaps.length) {
    gallery.innerHTML =
      '<div style="grid-column:1/-1; text-align:center; color:var(--color-text-secondary); font-size:13px; padding:12px 0;">no snaps yet — take your first one!</div>';
    return;
  }
  gallery.innerHTML = appData.snaps
    .map(function (s) {
      var src = typeof s.img === "string" && s.img.indexOf("data:image/") === 0 ? s.img : "";
      return (
        '<div class="snap-thumb">' +
        '<img src="' +
        src +
        '" alt="snap" />' +
        '<button type="button" class="snap-delete" onclick="deleteSnap(' +
        s.id +
        ')" aria-label="Delete snap">✕</button>' +
        "</div>"
      );
    })
    .join("");
}

function setupInstallHelpers() {
  var urlEl = document.getElementById("install-page-url");
  if (urlEl) {
    urlEl.textContent = location.href.split("#")[0];
  }
  var installBtn = document.getElementById("pwa-install-btn");
  var copyBtn = document.getElementById("copy-app-link-btn");

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredInstallPrompt = e;
    if (installBtn) installBtn.hidden = false;
  });

  if (installBtn) {
    installBtn.addEventListener("click", function () {
      if (!deferredInstallPrompt) {
        alert('Use your browser menu: look for "Install app" or "Add to Home screen".');
        return;
      }
      deferredInstallPrompt.prompt();
      deferredInstallPrompt.userChoice.then(function () {
        deferredInstallPrompt = null;
        installBtn.hidden = true;
      });
    });
  }

  function copyPageLinkToClipboard(onDone) {
    var url = location.href.split("#")[0];
    function done() {
      if (typeof onDone === "function") onDone();
      else alert("Copied! On your phone: paste into Safari (iPhone) or Chrome (Android), then use Add to Home Screen.");
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(function () {
        window.prompt("Copy this address:", url);
      });
    } else {
      window.prompt("Copy this address:", url);
    }
  }

  if (copyBtn) {
    copyBtn.addEventListener("click", function () {
      copyPageLinkToClipboard();
    });
  }

  var loginCopyBtn = document.getElementById("login-copy-link-btn");
  if (loginCopyBtn) {
    loginCopyBtn.addEventListener("click", function () {
      copyPageLinkToClipboard();
    });
  }

  if ("serviceWorker" in navigator) {
    var allowSw =
      location.protocol === "https:" ||
      location.hostname === "localhost" ||
      location.hostname === "127.0.0.1";
    if (allowSw) {
      navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(function () {});
    }
  }
}

document.addEventListener("DOMContentLoaded", function () {
  var submit = document.getElementById("login-submit");
  var pw = document.getElementById("login-password");
  var signOutBtn = document.getElementById("sign-out-btn");
  if (submit) submit.addEventListener("click", tryLogin);
  if (pw)
    pw.addEventListener("keydown", function (e) {
      if (e.key === "Enter") tryLogin();
    });
  if (signOutBtn) signOutBtn.addEventListener("click", signOut);

  function flushAllData() {
    try {
      if (getSession()) saveData();
    } catch (e) {}
  }

  window.addEventListener("beforeunload", function () {
    flushAllData();
    stopLiveGps();
  });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flushAllData();
  });
  window.addEventListener("pagehide", flushAllData);

  if (getSession()) {
    showMainApp();
  } else {
    document.getElementById("login-screen").hidden = false;
    document.getElementById("main-app").hidden = true;
  }

  setupInstallHelpers();
});
