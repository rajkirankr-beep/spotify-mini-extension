const CLIENT_ID = "ENTER_CLIENT_ID_HERE";
const REDIRECT_URI = typeof chrome !== "undefined" && chrome.identity?.getRedirectURL
  ? chrome.identity.getRedirectURL()
  : "https://spotify-mini.chromiumapp.org/";

const SCOPES = [
  "user-read-currently-playing",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-recently-played",
  "user-library-read",
  "user-library-modify"
].join(" ");

// --- Persistent Storage Helper (Chrome Storage Local + Fallback) ---
const storage = {
  async get(keys) {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
    }
    const result = {};
    for (const k of [].concat(keys)) {
      result[k] = localStorage.getItem(k);
    }
    return result;
  },
  async set(items) {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      return new Promise((resolve) => chrome.storage.local.set(items, resolve));
    }
    for (const [k, v] of Object.entries(items)) {
      localStorage.setItem(k, typeof v === "object" ? JSON.stringify(v) : v);
    }
  },
  async remove(keys) {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
    }
    for (const k of [].concat(keys)) {
      localStorage.removeItem(k);
    }
  }
};

// --- DOM References ---
const views = {
  login: document.getElementById("login-view"),
  standby: document.getElementById("standby-view"),
  player: document.getElementById("player-view")
};

const bgArt1 = document.getElementById("bg-art-1");
const bgArt2 = document.getElementById("bg-art-2");
let activeBgIndex = 1;

const avatarImg = document.getElementById("avatar-img");
const trackTitleEl = document.getElementById("track-title");
const artistHandleEl = document.getElementById("artist-handle");
const timeElapsedEl = document.getElementById("time-elapsed");
const timeRemainingEl = document.getElementById("time-remaining");
const progressTrackEl = document.getElementById("progress-track");
const progressFillEl = document.getElementById("progress-fill");

const playBtn = document.getElementById("play-btn");
const playIconSvg = document.getElementById("play-icon-svg");
const lyricsBtn = document.getElementById("lyrics-btn");
const likeBtn = document.getElementById("like-btn");
const prevBtn = document.getElementById("prev-btn");
const nextBtn = document.getElementById("next-btn");
const shareBtn = document.getElementById("share-btn");
const controlsRow = document.getElementById("controls-row");
const nextDrawerGroup = document.getElementById("next-drawer-group");
const toast = document.getElementById("toast");

const lyricsOverlay = document.getElementById("lyrics-overlay");
const lyricsScroll = document.getElementById("lyrics-scroll");

const peekPrevPill = document.getElementById("peek-prev-pill");
const prevThumb = document.getElementById("prev-thumb");
const prevSong = document.getElementById("prev-song");
const peekArt1 = document.getElementById("peek-art-1");
const peekArt2 = document.getElementById("peek-art-2");
const peekSong = document.getElementById("peek-song");

// --- Playback State ---
let currentTrackId = null;
let currentTrackUrl = "";
let currentDurationMs = 0;
let currentElapsedMs = 0;
let lastSyncTimestamp = 0;
let isPlaying = false;
let isLiked = false;
let isSeeking = false;
let currentArtUrl = "";

// Lyrics State
let lyricsOpen = false;
let parsedLyrics = [];
let activeLyricIndex = -1;

// Loop & Polling Handles
let pollIntervalId = null;
let animFrameId = null;
let refreshPromise = null;
let rateLimitUntil = 0;
let toastTimeoutId = null;

// --- PKCE Auth Helpers ---
const randomStr = (len = 64) => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
};

const sha256 = (plain) =>
  crypto.subtle.digest("SHA-256", new TextEncoder().encode(plain));

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

// --- View Switcher ---
function showView(name) {
  Object.keys(views).forEach((v) => {
    views[v]?.classList.toggle("active", v === name);
  });
}

// --- Toast Messenger ---
function showToast(text, duration = 2000) {
  if (!toast) return;
  toast.textContent = text;
  toast.classList.add("show");
  clearTimeout(toastTimeoutId);
  toastTimeoutId = setTimeout(() => {
    toast.classList.remove("show");
  }, duration);
}

// --- Rate Limiting (429) ---
function handleRateLimit(res) {
  const retryHeader = res.headers.get("Retry-After");
  const seconds = retryHeader ? Math.max(1, parseInt(retryHeader, 10)) : 5;
  rateLimitUntil = Date.now() + seconds * 1000;
  showToast(`Rate limited. Backing off ${seconds}s`);
}

function isRateLimited() {
  return Date.now() < rateLimitUntil;
}

// --- Token Exchange & Deduplicated Refresh ---
async function exchangeToken(body) {
  try {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CLIENT_ID, ...body }),
    });

    if (res.status === 429) {
      handleRateLimit(res);
      return null;
    }

    const data = await res.json();
    if (data.access_token) {
      const items = {
        access_token: data.access_token,
        expires_at: Date.now() + (data.expires_in || 3600) * 1000,
      };
      if (data.refresh_token) {
        items.refresh_token = data.refresh_token;
      }
      await storage.set(items);
      return data.access_token;
    } else {
      if (body.grant_type === "refresh_token") {
        await storage.remove(["access_token", "refresh_token", "expires_at"]);
        stopPolling();
        showView("login");
      }
      return null;
    }
  } catch {
    return null;
  }
}

async function getToken() {
  const data = await storage.get(["access_token", "refresh_token", "expires_at"]);
  const exp = Number(data.expires_at || 0);
  const tok = data.access_token;

  if (tok && Date.now() < exp - 60000) {
    return tok;
  }

  const ref = data.refresh_token;
  if (!ref) {
    showView("login");
    return null;
  }

  if (!refreshPromise) {
    refreshPromise = exchangeToken({
      grant_type: "refresh_token",
      refresh_token: ref,
    }).finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

// --- PKCE Login Flow ---
async function login() {
  const verifier = randomStr(64);
  const challenge = b64url(await sha256(verifier));
  await storage.set({ code_verifier: verifier });

  console.log("[Spotify Glass] Initiating OAuth PKCE Login...");
  console.log("[Spotify Glass] Configured REDIRECT_URI:", REDIRECT_URI);
  console.log("[Spotify Glass] Configured CLIENT_ID:", CLIENT_ID);

  if (!CLIENT_ID || CLIENT_ID === "your_client_id_here" || CLIENT_ID.length < 16) {
    const err = "Spotify CLIENT_ID is not configured in app.js";
    console.error("[Spotify Glass]", err);
    showToast(err, 4000);
    return;
  }

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });

  if (typeof chrome === "undefined" || !chrome.identity?.launchWebAuthFlow) {
    const err = "chrome.identity.launchWebAuthFlow is unavailable";
    console.error("[Spotify Glass]", err);
    showToast(err, 4000);
    return;
  }

  chrome.identity.launchWebAuthFlow(
    {
      url: `https://accounts.spotify.com/authorize?${params.toString()}`,
      interactive: true,
    },
    async (redirectUrl) => {
      if (chrome.runtime.lastError || !redirectUrl) {
        const errorDetail = chrome.runtime.lastError?.message || "Authentication flow was closed or failed";
        console.error("[Spotify Glass] launchWebAuthFlow Error:", chrome.runtime.lastError, "redirectUrl:", redirectUrl);
        showToast(`OAuth Error: ${errorDetail}`, 4000);
        return;
      }

      try {
        const url = new URL(redirectUrl);
        const error = url.searchParams.get("error");
        if (error) {
          console.error("[Spotify Glass] Spotify OAuth error response:", error);
          showToast(`Auth error: ${error}`, 4000);
          return;
        }

        const code = url.searchParams.get("code");
        if (code) {
          const stored = await storage.get("code_verifier");
          const ok = await exchangeToken({
            grant_type: "authorization_code",
            code,
            redirect_uri: REDIRECT_URI,
            code_verifier: stored.code_verifier || verifier,
          });

          if (ok) {
            console.log("[Spotify Glass] Authentication successful! Syncing player...");
            startPolling();
            syncPlayer();
          } else {
            console.error("[Spotify Glass] Failed to exchange authorization code for tokens");
            showToast("Failed to acquire access token", 3000);
          }
        }
      } catch (err) {
        console.error("[Spotify Glass] Error parsing redirect URL:", err);
        showToast("Authorization flow failed to process redirect", 3000);
      }
    }
  );
}

// --- Format Time Helper ---
function formatTime(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = String(totalSec % 60).padStart(2, "0");
  return `${min}:${sec}`;
}

// --- Spotify Player Command ---
async function playerCmd(endpoint, method = "POST") {
  if (isRateLimited()) return false;
  const token = await getToken();
  if (!token) return false;

  try {
    const res = await fetch(`https://api.spotify.com/v1/me/player/${endpoint}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 429) {
      handleRateLimit(res);
      return false;
    }

    if (res.status === 403) {
      showToast("Premium required or device restricted");
      return false;
    }

    if (res.status === 404) {
      showToast("No active device found");
      return false;
    }

    return res.ok;
  } catch {
    return false;
  }
}

// --- Synced Lyrics Engine (LRCLIB) ---
function parseLRC(lrcText) {
  const lines = lrcText.split("\n");
  const result = [];
  const regex = /\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/;

  for (const line of lines) {
    const match = line.match(regex);
    if (!match) continue;
    const min = parseInt(match[1], 10);
    const sec = parseInt(match[2], 10);
    const ms = match[3].length === 2 ? parseInt(match[3], 10) * 10 : parseInt(match[3], 10);
    const text = match[4].trim();
    if (text) {
      result.push({ timeMs: min * 60000 + sec * 1000 + ms, text });
    }
  }
  return result;
}

async function fetchSyncedLyrics(trackName, artistName, durationSec) {
  parsedLyrics = [];
  activeLyricIndex = -1;
  if (lyricsScroll) {
    lyricsScroll.innerHTML = `<p class="lyric-status">Loading lyrics...</p>`;
  }

  try {
    const params = new URLSearchParams({
      track_name: trackName,
      artist_name: artistName,
      duration: Math.round(durationSec),
    });

    const res = await fetch(`https://lrclib.net/api/get?${params.toString()}`);
    if (!res.ok) throw new Error("Lyrics not found");

    const data = await res.json();
    if (data.syncedLyrics) {
      parsedLyrics = parseLRC(data.syncedLyrics);
      renderLyricsList();
      if (lyricsOpen) syncActiveLyric(currentElapsedMs);
    } else if (data.plainLyrics && lyricsScroll) {
      lyricsScroll.innerHTML = data.plainLyrics
        .split("\n")
        .filter(Boolean)
        .map((line) => `<p class="lyric-line plain">${line}</p>`)
        .join("");
    } else if (lyricsScroll) {
      lyricsScroll.innerHTML = `<p class="lyric-status">No lyrics available</p>`;
    }
  } catch {
    if (lyricsScroll) {
      lyricsScroll.innerHTML = `<p class="lyric-status">No lyrics found</p>`;
    }
  }
}

function renderLyricsList() {
  if (!lyricsScroll) return;
  lyricsScroll.innerHTML = parsedLyrics
    .map((line, idx) => `<p class="lyric-line" data-idx="${idx}">${line.text}</p>`)
    .join("");
}

function syncActiveLyric(elapsedMs) {
  if (!lyricsOpen || parsedLyrics.length === 0) return;

  let idx = -1;
  for (let i = 0; i < parsedLyrics.length; i++) {
    if (elapsedMs >= parsedLyrics[i].timeMs) idx = i;
    else break;
  }

  if (idx !== activeLyricIndex) {
    activeLyricIndex = idx;
    const nodes = lyricsScroll?.querySelectorAll(".lyric-line");
    nodes?.forEach((node, i) => {
      const isCurrent = i === idx;
      node.classList.toggle("active", isCurrent);
      if (isCurrent) {
        node.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  }
}

function toggleLyrics() {
  lyricsOpen = !lyricsOpen;
  lyricsOverlay?.classList.toggle("open", lyricsOpen);
  lyricsBtn?.classList.toggle("active-toggle", lyricsOpen);
  if (lyricsOpen) {
    activeLyricIndex = -1;
    syncActiveLyric(currentElapsedMs);
  }
}

// --- Smooth Progress Bar Interpolation (60fps) ---
function updateProgressUI(elapsed, duration) {
  const safeElapsed = Math.min(Math.max(0, elapsed), duration || 1);
  const pct = duration > 0 ? (safeElapsed / duration) * 100 : 0;

  if (progressFillEl) progressFillEl.style.width = `${pct.toFixed(2)}%`;
  if (timeElapsedEl) timeElapsedEl.textContent = formatTime(safeElapsed);
  if (timeRemainingEl) {
    const remaining = Math.max(0, (duration || 0) - safeElapsed);
    timeRemainingEl.textContent = `-${formatTime(remaining)}`;
  }
  if (progressTrackEl) {
    progressTrackEl.setAttribute("aria-valuenow", Math.round(pct));
  }

  syncActiveLyric(safeElapsed);
}

function interpolationLoop(timestamp) {
  if (isPlaying && !isSeeking && currentDurationMs > 0) {
    const delta = timestamp - lastSyncTimestamp;
    const estElapsed = currentElapsedMs + delta;

    if (estElapsed < currentDurationMs) {
      updateProgressUI(estElapsed, currentDurationMs);
    } else {
      updateProgressUI(currentDurationMs, currentDurationMs);
    }
  }
  animFrameId = requestAnimationFrame(interpolationLoop);
}

function startInterpolation() {
  if (!animFrameId) {
    lastSyncTimestamp = performance.now();
    animFrameId = requestAnimationFrame(interpolationLoop);
  }
}

function stopInterpolation() {
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
}

// --- Single Polling Interval Manager ---
function startPolling() {
  stopPolling();
  pollIntervalId = setInterval(() => {
    if (!isRateLimited()) syncPlayer();
  }, 2500);
  startInterpolation();
}

function stopPolling() {
  if (pollIntervalId) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
  }
  stopInterpolation();
}

// --- Render Play / Pause Icon ---
function renderPlayButton(playing) {
  if (!playIconSvg) return;
  if (playing) {
    playIconSvg.innerHTML = `<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>`;
  } else {
    playIconSvg.innerHTML = `<path d="M8 5v14l11-7z"/>`;
  }
}

// --- Render Like Button State ---
function renderLikeButton(liked) {
  likeBtn?.classList.toggle("liked", liked);
}

// --- Album Art Crossfade ---
function crossfadeArt(newUrl) {
  if (!newUrl || newUrl === currentArtUrl) return;
  currentArtUrl = newUrl;

  const incomingEl = activeBgIndex === 1 ? bgArt2 : bgArt1;
  const currentEl = activeBgIndex === 1 ? bgArt1 : bgArt2;

  const img = new Image();
  img.onload = () => {
    if (incomingEl) {
      incomingEl.src = newUrl;
      incomingEl.classList.add("active");
    }
    if (currentEl) {
      currentEl.classList.remove("active");
    }
    activeBgIndex = activeBgIndex === 1 ? 2 : 1;
  };
  img.src = newUrl;

  if (avatarImg) {
    avatarImg.src = newUrl;
  }
}

// --- Optimistic User Controls ---
async function togglePlayPause() {
  if (!currentTrackId) return;

  const previousPlaying = isPlaying;
  const targetPlaying = !isPlaying;

  // Optimistic UI update
  isPlaying = targetPlaying;
  renderPlayButton(isPlaying);

  if (isPlaying) {
    lastSyncTimestamp = performance.now();
  } else {
    currentElapsedMs = Math.min(
      currentDurationMs,
      currentElapsedMs + (performance.now() - lastSyncTimestamp)
    );
    lastSyncTimestamp = performance.now();
  }

  const success = await playerCmd(targetPlaying ? "play" : "pause", "PUT");
  if (!success) {
    isPlaying = previousPlaying;
    renderPlayButton(isPlaying);
    lastSyncTimestamp = performance.now();
  } else {
    setTimeout(syncPlayer, 350);
  }
}

async function toggleLike() {
  if (!currentTrackId) return;
  const token = await getToken();
  if (!token) return;

  const previousLiked = isLiked;
  const targetLiked = !isLiked;

  isLiked = targetLiked;
  renderLikeButton(isLiked);

  try {
    const res = await fetch(`https://api.spotify.com/v1/me/tracks?ids=${currentTrackId}`, {
      method: targetLiked ? "PUT" : "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      isLiked = previousLiked;
      renderLikeButton(isLiked);
    }
  } catch {
    isLiked = previousLiked;
    renderLikeButton(isLiked);
  }
}

async function seekTrack(event) {
  if (!currentDurationMs) return;

  const rect = event.currentTarget.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  const targetPositionMs = Math.floor(ratio * currentDurationMs);

  currentElapsedMs = targetPositionMs;
  lastSyncTimestamp = performance.now();
  updateProgressUI(currentElapsedMs, currentDurationMs);

  await playerCmd(`seek?position_ms=${targetPositionMs}`, "PUT");
  setTimeout(syncPlayer, 350);
}

function shareTrack() {
  if (!currentTrackUrl) return;
  navigator.clipboard.writeText(currentTrackUrl);
  showToast("Link copied to clipboard");
}

// --- Up Next & Recently Played Peeks ---
async function refreshPeekData() {
  const token = await getToken();
  if (!token || isRateLimited()) return;

  try {
    const [qRes, prevRes] = await Promise.all([
      fetch("https://api.spotify.com/v1/me/player/queue", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      fetch("https://api.spotify.com/v1/me/player/recently-played?limit=2", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ]);

    if (qRes.ok) {
      const qData = await qRes.json();
      const next1 = qData.queue?.[0];
      const next2 = qData.queue?.[1];

      if (next1) {
        const art1 = next1.album?.images?.[1]?.url || next1.album?.images?.[0]?.url || "";
        const art2 = next2?.album?.images?.[1]?.url || next2?.album?.images?.[0]?.url || "";

        if (peekArt1) peekArt1.src = art1;
        if (peekArt2) peekArt2.src = art2;
        if (peekSong) peekSong.textContent = next1.name || "Unknown Track";
      } else {
        if (peekArt1) peekArt1.src = "";
        if (peekArt2) peekArt2.src = "";
        if (peekSong) peekSong.textContent = "Queue empty";
      }
    }

    if (prevRes.ok) {
      const prevData = await prevRes.json();
      const prevItem =
        prevData.items?.find((i) => i.track?.id !== currentTrackId)?.track ||
        prevData.items?.[0]?.track;

      if (prevItem) {
        const prevArt = prevItem.album?.images?.[1]?.url || prevItem.album?.images?.[0]?.url || "";
        if (prevThumb) prevThumb.src = prevArt;
        if (prevSong) prevSong.textContent = prevItem.name || "Previous Track";
      } else {
        if (prevThumb) prevThumb.src = "";
        if (prevSong) prevSong.textContent = "None";
      }
    }
  } catch {
    // Non-blocking peek network failure
  }
}

async function checkSaved(trackId, token) {
  try {
    const res = await fetch(`https://api.spotify.com/v1/me/tracks/contains?ids=${trackId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const [saved] = await res.json();
      isLiked = Boolean(saved);
      renderLikeButton(isLiked);
    }
  } catch {
    // Non-blocking check
  }
}

function setQueueOpen(open) {
  controlsRow?.classList.toggle("queue-open", open);
  if (open) refreshPeekData();
}

// --- Main Player Sync ---
async function syncPlayer() {
  if (isRateLimited()) return;
  const token = await getToken();
  if (!token) return;

  try {
    const res = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 429) {
      handleRateLimit(res);
      return;
    }

    if (res.status === 204 || res.status > 400) {
      isPlaying = false;
      showView("standby");
      return;
    }

    const data = await res.json();
    if (!data || !data.item) {
      isPlaying = false;
      showView("standby");
      return;
    }

    showView("player");

    const track = data.item;
    const isNewTrack = track.id !== currentTrackId;

    currentDurationMs = track.duration_ms || 0;
    currentElapsedMs = data.progress_ms || 0;
    lastSyncTimestamp = performance.now();
    isPlaying = Boolean(data.is_playing);

    renderPlayButton(isPlaying);
    updateProgressUI(currentElapsedMs, currentDurationMs);

    if (isNewTrack) {
      currentTrackId = track.id;
      currentTrackUrl = track.external_urls?.spotify || "";

      if (trackTitleEl) {
        trackTitleEl.textContent = track.name;
        trackTitleEl.title = track.name;
      }

      const primaryArtist = track.artists?.[0]?.name || "Unknown Artist";
      const artistName = track.artists?.map((a) => a.name).join(", ") || primaryArtist;
      const handle = "@" + primaryArtist.toLowerCase().replace(/[^a-z0-9]/g, "");

      if (artistHandleEl) {
        artistHandleEl.textContent = handle;
        artistHandleEl.title = artistName;
      }

      const art = track.album?.images?.[0]?.url || "";
      crossfadeArt(art);

      checkSaved(track.id, token);
      refreshPeekData();
      fetchSyncedLyrics(track.name, primaryArtist, currentDurationMs / 1000);
    }
  } catch {
    // Network hiccup; will retry on next poll
  }
}

// --- Attach CSP-Safe Event Handlers ---
function initEvents() {
  document.getElementById("login-btn")?.addEventListener("click", login);

  document.getElementById("standby-refresh-btn")?.addEventListener("click", () => {
    syncPlayer();
    showToast("Checking playback...");
  });

  document.getElementById("standby-open-btn")?.addEventListener("click", () => {
    window.open("https://open.spotify.com", "_blank");
  });

  lyricsBtn?.addEventListener("click", toggleLyrics);

  // Delegated seek click on lyric lines
  lyricsScroll?.addEventListener("click", async (e) => {
    const lineEl = e.target.closest(".lyric-line");
    if (!lineEl || lineEl.classList.contains("plain")) return;
    const idx = Number(lineEl.dataset.idx);
    const targetMs = parsedLyrics[idx]?.timeMs;
    if (typeof targetMs === "number") {
      currentElapsedMs = targetMs;
      lastSyncTimestamp = performance.now();
      updateProgressUI(currentElapsedMs, currentDurationMs);
      await playerCmd(`seek?position_ms=${targetMs}`, "PUT");
      setTimeout(syncPlayer, 300);
    }
  });

  shareBtn?.addEventListener("click", shareTrack);
  likeBtn?.addEventListener("click", toggleLike);
  progressTrackEl?.addEventListener("click", seekTrack);

  prevBtn?.addEventListener("click", async () => {
    await playerCmd("previous");
    setTimeout(syncPlayer, 300);
  });

  playBtn?.addEventListener("click", togglePlayPause);

  nextBtn?.addEventListener("click", async () => {
    await playerCmd("next");
    setTimeout(syncPlayer, 300);
  });

  nextDrawerGroup?.addEventListener("mouseenter", () => setQueueOpen(true));
  nextDrawerGroup?.addEventListener("mouseleave", () => setQueueOpen(false));

  // Keyboard Shortcuts: Space, Left/Right Arrows, L for Lyrics
  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

    if (e.code === "Space" || e.key === " ") {
      e.preventDefault();
      togglePlayPause();
    } else if (e.code === "ArrowLeft") {
      e.preventDefault();
      prevBtn?.click();
    } else if (e.code === "ArrowRight") {
      e.preventDefault();
      nextBtn?.click();
    } else if (e.code === "KeyL" || e.key === "l" || e.key === "L") {
      e.preventDefault();
      toggleLyrics();
    }
  });
}

// --- Initialization ---
(async () => {
  initEvents();

  console.log("[Spotify Glass] Extension initialized.");
  console.log("[Spotify Glass] Active REDIRECT_URI:", REDIRECT_URI);
  if (!CLIENT_ID || CLIENT_ID === "your_client_id_here") {
    console.warn("[Spotify Glass] Warning: CLIENT_ID is unset or using a placeholder string.");
  }

  const legacyToken = localStorage.getItem("access_token");
  if (legacyToken) {
    await storage.set({
      access_token: legacyToken,
      refresh_token: localStorage.getItem("refresh_token") || "",
      expires_at: Number(localStorage.getItem("expires_at") || 0),
    });
  }

  const token = await getToken();
  if (token) {
    showView("player");
    startPolling();
    syncPlayer();
  } else {
    showView("login");
  }
})();