const ANONYMOUS_CLIENT_ID_KEY = "suno-timeline-anonymous-client-id";
const TIMELINE_ENDPOINT = "/api/timeline";
const TRACKS_ENDPOINT = "/api/tracks";
const MAX_SUNO_URL_LENGTH = 2048;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const SUNO_HOSTNAMES = new Set(["suno.com", "www.suno.com"]);
const SUNO_SHARE_KEY_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;

const form = document.querySelector("#track-form");
const urlInput = document.querySelector("#track-url");
const feedback = document.querySelector("#form-feedback");
const timelineList = document.querySelector("#timeline-list");
const emptyState = document.querySelector("#empty-state");
const emptyStateMessage = emptyState.querySelector("p");
const trackTemplate = document.querySelector("#track-template");
const submitButton = form.querySelector('button[type="submit"]');
const playerDock = document.querySelector("#player-dock");
const playerDockArtist = document.querySelector("#player-dock-artist");
const playerDockIframe = document.querySelector("#player-dock-iframe");

const anonymousClientId = ensureAnonymousClientId();
const pendingLikeIds = new Set();
const prefetchedEmbedUrls = new Set();

let tracks = [];
let activeTrackId = null;

initializeApp();

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const rawUrl = urlInput.value.trim();
  const parsed = parseSunoUrl(rawUrl);

  if (!parsed.ok) {
    setFeedback(parsed.message);
    return;
  }

  setSubmitting(true);
  setFeedback("\u66f2\u3092\u8aad\u307f\u8fbc\u3093\u3067\u3044\u307e\u3059\u3002");

  try {
    const response = await fetchJson(TRACKS_ENDPOINT, {
      method: "POST",
      body: JSON.stringify({
        sourceUrl: parsed.sourceUrl,
      }),
    });

    if (!response.ok) {
      setFeedback(response.message || "\u66f2\u306e\u6295\u7a3f\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002");
      return;
    }

    await fetchTimeline();
    form.reset();
    urlInput.focus();
    setFeedback(
      response.wasCreated
        ? "\u66f2\u3092\u6d41\u3057\u307e\u3057\u305f\u3002"
        : "\u3053\u306e\u66f2\u306f\u3059\u3067\u306b\u6d41\u308c\u3066\u3044\u307e\u3059\u3002"
    );
  } finally {
    setSubmitting(false);
  }
});

async function initializeApp() {
  updateEmptyState("\u66f2\u3092\u8aad\u307f\u8fbc\u3093\u3067\u3044\u307e\u3059\u3002");
  emptyState.hidden = false;
  await fetchTimeline();
}

async function fetchTimeline() {
  const response = await fetchJson(TIMELINE_ENDPOINT);

  if (!response.ok) {
    tracks = [];
    renderTimeline();
    renderPlayerDock();
    updateEmptyState(response.message || "\u30bf\u30a4\u30e0\u30e9\u30a4\u30f3\u306e\u8aad\u307f\u8fbc\u307f\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002");
    emptyState.hidden = false;
    return;
  }

  tracks = Array.isArray(response.tracks) ? response.tracks : [];
  renderTimeline();
  renderPlayerDock();
  updateEmptyState("\u307e\u3060\u66f2\u306f\u3042\u308a\u307e\u305b\u3093\u3002\u6700\u521d\u306e1\u66f2\u3092\u6d41\u3057\u3066\u304f\u3060\u3055\u3044\u3002");
}

function renderTimeline() {
  timelineList.replaceChildren();
  emptyState.hidden = tracks.length !== 0;

  const fragment = document.createDocumentFragment();

  tracks.forEach((track) => {
    const node = trackTemplate.content.firstElementChild.cloneNode(true);
    const stamp = node.querySelector(".track-card__stamp");
    const link = node.querySelector(".track-card__link");
    const art = node.querySelector(".track-card__art");
    const title = node.querySelector(".track-card__title");
    const artist = node.querySelector(".track-card__artist");
    const playButton = node.querySelector(".track-card__play-button");
    const playCount = node.querySelector(".track-stat__count");
    const likeButton = node.querySelector(".like-button");
    const likeIcon = node.querySelector(".like-button__icon");
    const likeCount = node.querySelector(".like-button__count");

    stamp.textContent = formatStamp(track);
    link.href = track.canonicalUrl || track.sourceUrl;
    if (track.imageUrl) {
      art.src = track.imageUrl;
      art.alt = `${track.title} artwork`;
    } else {
      art.removeAttribute("src");
      art.alt = "";
    }
    title.textContent = track.title || "Untitled";
    artist.textContent = track.artist || "Unknown artist";
    playCount.textContent = String(track.playCount ?? 0);
    likeCount.textContent = String(track.likeCount ?? 0);
    playButton.dataset.active = String(track.id === activeTrackId);
    playButton.textContent =
      track.id === activeTrackId ? "\u518d\u751f\u4e2d\u306e\u66f2" : "\u3053\u306e\u66f2\u3092\u518d\u751f";

    updateLikeButton(likeButton, likeIcon, track);
    likeButton.disabled = pendingLikeIds.has(track.id);

    playButton.addEventListener("pointerenter", () => {
      prefetchEmbed(track.embedUrl);
    });

    playButton.addEventListener("focus", () => {
      prefetchEmbed(track.embedUrl);
    });

    playButton.addEventListener("pointerdown", () => {
      activateTrack(track, playCount);
    });

    playButton.addEventListener("click", () => {
      activateTrack(track, playCount);
    });

    likeButton.addEventListener("click", async () => {
      if (pendingLikeIds.has(track.id)) {
        return;
      }

      pendingLikeIds.add(track.id);
      likeButton.disabled = true;

      try {
        const response = await fetchJson(`/api/tracks/${track.id}/like`, {
          method: "POST",
          body: JSON.stringify({
            liked: !track.liked,
          }),
        });

        if (!response.ok || !response.track) {
          setFeedback(response.message || "\u3044\u3044\u306d\u306e\u66f4\u65b0\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002");
          return;
        }

        syncTrack(track, response.track);
        syncTrackInCollection(response.track);
        likeCount.textContent = String(track.likeCount ?? 0);
        updateLikeButton(likeButton, likeIcon, track);
      } finally {
        pendingLikeIds.delete(track.id);
        likeButton.disabled = false;
      }
    });

    fragment.appendChild(node);
  });

  timelineList.appendChild(fragment);
}

function renderPlayerDock() {
  const activeTrack = tracks.find((track) => track.id === activeTrackId);

  if (!activeTrack) {
    playerDock.hidden = true;
    playerDockIframe.src = "about:blank";
    playerDockArtist.textContent = "";
    document.body.classList.remove("has-player-dock");
    return;
  }

  playerDock.hidden = false;
  playerDockArtist.textContent = activeTrack.artist || "Unknown artist";
  playerDockIframe.src = buildAutoplayEmbedUrl(activeTrack.embedUrl);

  document.body.classList.add("has-player-dock");
}

function updateLikeButton(button, icon, track) {
  const isLiked = Boolean(track.liked);
  button.dataset.liked = String(isLiked);
  button.setAttribute("aria-pressed", String(isLiked));
  icon.textContent = isLiked ? "\u2665" : "\u2661";
}

function syncTrack(currentTrack, nextTrack) {
  currentTrack.sourceUrl = nextTrack.sourceUrl;
  currentTrack.canonicalUrl = nextTrack.canonicalUrl;
  currentTrack.embedUrl = nextTrack.embedUrl;
  currentTrack.trackKey = nextTrack.trackKey;
  currentTrack.title = nextTrack.title;
  currentTrack.artist = nextTrack.artist;
  currentTrack.imageUrl = nextTrack.imageUrl;
  currentTrack.playCount = nextTrack.playCount;
  currentTrack.createdAt = nextTrack.createdAt;
  currentTrack.likeCount = nextTrack.likeCount;
  currentTrack.liked = nextTrack.liked;
}

function syncTrackInCollection(nextTrack) {
  const existingTrack = tracks.find((track) => track.id === nextTrack.id);

  if (!existingTrack) {
    return;
  }

  syncTrack(existingTrack, nextTrack);
}

function parseSunoUrl(value) {
  if (typeof value !== "string") {
    return {
      ok: false,
      message: "Sunoの共有リンクを貼ってください。",
    };
  }

  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return {
      ok: false,
      message: "URLを入力してください。",
    };
  }

  if (trimmedValue.length > MAX_SUNO_URL_LENGTH) {
    return {
      ok: false,
      message: "URLが長すぎます。",
    };
  }

  if (CONTROL_CHARACTER_PATTERN.test(trimmedValue)) {
    return {
      ok: false,
      message: "URLの形式が正しくありません。",
    };
  }

  const normalizedValue = /^https?:\/\//i.test(trimmedValue) ? trimmedValue : `https://${trimmedValue}`;
  let url;

  try {
    url = new URL(normalizedValue);
  } catch (error) {
    return {
      ok: false,
      message: "URL\u306e\u5f62\u5f0f\u304c\u6b63\u3057\u304f\u3042\u308a\u307e\u305b\u3093\u3002",
    };
  }

  if (url.protocol !== "https:") {
    return {
      ok: false,
      message: "https:// から始まるSunoリンクを貼ってください。",
    };
  }

  if (url.username || url.password) {
    return {
      ok: false,
      message: "URLの形式が正しくありません。",
    };
  }

  if (!SUNO_HOSTNAMES.has(url.hostname.toLowerCase())) {
    return {
      ok: false,
      message: "Suno\u306e\u5171\u6709\u30ea\u30f3\u30af\u3092\u8cbc\u3063\u3066\u304f\u3060\u3055\u3044\u3002",
    };
  }

  const pathValidation = validateSunoPath(url.pathname);

  if (!pathValidation.ok) {
    return pathValidation;
  }

  url.hash = "";

  return {
    ok: true,
    sourceUrl: url.toString(),
  };
}

function validateSunoPath(pathname) {
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length !== 2) {
    return {
      ok: false,
      message: "Sunoの共有リンクを貼ってください。",
    };
  }

  const [kind, value] = segments;

  if (kind === "song" && isUuid(value)) {
    return { ok: true };
  }

  if (kind === "s" && SUNO_SHARE_KEY_PATTERN.test(value)) {
    return { ok: true };
  }

  return {
    ok: false,
    message: "Sunoの共有リンクを貼ってください。",
  };
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function ensureAnonymousClientId() {
  const existing = window.localStorage.getItem(ANONYMOUS_CLIENT_ID_KEY);

  if (existing) {
    return existing;
  }

  const created = crypto.randomUUID();
  window.localStorage.setItem(ANONYMOUS_CLIENT_ID_KEY, created);
  return created;
}

async function fetchJson(url, options = {}) {
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Anonymous-Client-Id": anonymousClientId,
        ...(options.headers || {}),
      },
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) : {};

    return {
      ok: response.ok,
      status: response.status,
      ...data,
    };
  } catch (error) {
    console.error("Request failed", error);
    return {
      ok: false,
      status: 0,
      message: "\u30b5\u30fc\u30d0\u30fc\u3068\u306e\u901a\u4fe1\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002",
    };
  }
}

function formatStamp(track) {
  const date = new Date(track.createdAt);
  const stamp = new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);

  return `${stamp} / ${track.trackKey.slice(0, 8)}`;
}

function buildAutoplayEmbedUrl(embedUrl) {
  const url = new URL(embedUrl);
  url.searchParams.set("autoplay", "1");
  return url.toString();
}

function updateEmptyState(message) {
  emptyStateMessage.textContent = message;
}

function setFeedback(message) {
  feedback.textContent = message;
}

function setSubmitting(isSubmitting) {
  submitButton.disabled = isSubmitting;
}

async function recordPlay(trackId, playCountElement) {
  const response = await fetchJson(`/api/tracks/${trackId}/play`, {
    method: "POST",
  });

  if (!response.ok || !response.track) {
    return;
  }

  syncTrackInCollection(response.track);

  if (activeTrackId === trackId) {
    renderTimeline();
    return;
  }

  const updatedTrack = tracks.find((track) => track.id === trackId);

  if (updatedTrack && playCountElement?.isConnected) {
    playCountElement.textContent = String(updatedTrack.playCount ?? 0);
  }
}

function activateTrack(track, playCountElement) {
  if (track.id === activeTrackId) {
    return;
  }

  activeTrackId = track.id;
  renderPlayerDock();
  renderTimeline();

  void recordPlay(track.id, playCountElement);
}

function prefetchEmbed(embedUrl) {
  const href = buildAutoplayEmbedUrl(embedUrl);

  if (prefetchedEmbedUrls.has(href)) {
    return;
  }

  const link = document.createElement("link");
  link.rel = "prefetch";
  link.href = href;
  link.crossOrigin = "anonymous";
  document.head.append(link);
  prefetchedEmbedUrls.add(href);
}
