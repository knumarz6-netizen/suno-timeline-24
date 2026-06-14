const ANONYMOUS_CLIENT_ID_KEY = "suno-timeline-anonymous-client-id";
const TIMELINE_ENDPOINT = "/api/timeline";
const TRACKS_ENDPOINT = "/api/tracks";
const TRACK_LIFETIME_MS = 24 * 60 * 60 * 1000;
const REPORT_LIFETIME_MS = 60 * 60 * 1000;
const TIMELINE_LIVE_REFRESH_MS = 5000;
const DEFAULT_DURATION_SECONDS = 4 * 60;
const AUTO_ADVANCE_BUFFER_MS = 2000;
const SUPER_LIKE_SPOTLIGHT_COLLAPSED_COUNT = 6;
const MAX_SUNO_URL_LENGTH = 2048;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const SUNO_HOSTNAMES = new Set(["suno.com", "www.suno.com"]);
const SUNO_SHARE_KEY_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;

const form = document.querySelector("#track-form");
const layout = document.querySelector(".layout");
const urlInput = document.querySelector("#track-url");
const feedback = document.querySelector("#form-feedback");
const timelineList = document.querySelector("#timeline-list");
const timelinePick = document.querySelector("#timeline-pick");
const timelinePickCard = document.querySelector("#timeline-pick-card");
const timelineStatTrackCount = document.querySelector("#timeline-stat-track-count");
const timelineStatLikeCount = document.querySelector("#timeline-stat-like-count");
const timelineStatPlayCount = document.querySelector("#timeline-stat-play-count");
const timelineStatSuperLikeCount = document.querySelector("#timeline-stat-super-like-count");
const superLikeSpotlight = document.querySelector("#super-like-spotlight");
const superLikeSpotlightList = document.querySelector("#super-like-spotlight-list");
const superLikeSpotlightToggle = document.querySelector("#super-like-spotlight-toggle");
const emptyState = document.querySelector("#empty-state");
const emptyStateMessage = emptyState.querySelector("p");
const trackTemplate = document.querySelector("#track-template");
const autoPlayToggle = document.querySelector("#autoplay-toggle");
const autoPlayShuffleToggle = document.querySelector("#autoplay-shuffle-toggle");
const autoPlaySuperLikeToggle = document.querySelector("#autoplay-super-like-toggle");
const submitButton = form.querySelector('button[type="submit"]');
const playerDock = document.querySelector("#player-dock");
const playerDockArtist = document.querySelector("#player-dock-artist");
const playerDockIframe = document.querySelector("#player-dock-iframe");
const playerDockFrame = document.querySelector(".player-dock__frame");
const radioControls = document.querySelector("#radio-controls");
const startTrackButton = document.querySelector("#start-track-button");
const nextTrackButton = document.querySelector("#next-track-button");
const stopRadioButton = document.querySelector("#stop-radio-button");
const playerDockLikeButton = document.querySelector("#player-dock-like-button");
const playerDockLikeIcon = document.querySelector("#player-dock-like-icon");
const playerDockLikeCount = document.querySelector("#player-dock-like-count");
const playerDockOpenLink = document.querySelector("#player-dock-open-link");

const anonymousClientId = ensureAnonymousClientId();
const pendingLikeIds = new Set();
const pendingSuperLikeIds = new Set();
const pendingReportIds = new Set();
const prefetchedEmbedUrls = new Set();

let tracks = [];
let activeTrackId = null;
let autoPlayMode = false;
let autoPlayShuffleMode = false;
let autoPlaySuperLikeOnlyMode = false;
let autoPlayQueueIds = [];
let sequenceTrackId = null;
let autoPlayTimeout = null;
let autoPlayScheduledTrackId = null;
let autoPlayAdvanceAtMs = 0;
let timelineClock = null;
let timelineLiveRefresh = null;
let timelineRefreshInFlight = false;
let recommendation = null;
let timelineStats = createEmptyTimelineStats();
let currentUserSuperLikeTrackId = null;
let isSuperLikeSpotlightExpanded = false;

initializeApp();

superLikeSpotlightToggle?.addEventListener("click", () => {
  isSuperLikeSpotlightExpanded = !isSuperLikeSpotlightExpanded;
  renderSuperLikeSpotlight();
});

startTrackButton?.addEventListener("click", () => {
  startCurrentSequenceTrack();
});

autoPlayToggle?.addEventListener("click", () => {
  if (autoPlayMode && !autoPlayShuffleMode) {
    stopAutoPlayMode();
    return;
  }

  startAutoPlayFromTop();
});

autoPlayShuffleToggle?.addEventListener("click", () => {
  if (autoPlayMode && autoPlayShuffleMode) {
    stopAutoPlayMode();
    return;
  }

  startAutoPlayFromTop({
    shuffle: true,
  });
});

autoPlaySuperLikeToggle?.addEventListener("click", () => {
  if (autoPlayMode && autoPlaySuperLikeOnlyMode) {
    stopAutoPlayMode();
    return;
  }

  startAutoPlayFromTop({
    superLikeOnly: true,
  });
});

nextTrackButton?.addEventListener("click", () => {
  advanceToNextTrack();
});

stopRadioButton?.addEventListener("click", () => {
  stopAutoPlayMode();
});

playerDockLikeButton?.addEventListener("click", async () => {
  const currentTrack = getPlayerDockTrack();

  if (!currentTrack || pendingLikeIds.has(currentTrack.id)) {
    return;
  }

  pendingLikeIds.add(currentTrack.id);
  playerDockLikeButton.disabled = true;

  try {
    const response = await fetchJson(`/api/tracks/${currentTrack.id}/like`, {
      method: "POST",
      body: JSON.stringify({
        liked: !currentTrack.liked,
      }),
    });

    if (!response.ok || !response.track) {
      setFeedback(response.message || "\u3044\u3044\u306d\u306e\u66f4\u65b0\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002");
      return;
    }

    syncTrackInCollection(response.track);
    syncRecommendationTrack(response.track);
    updateTrackPlayCount(currentTrack.id, response.track.playCount);
    renderPlayerDock();
    renderTimeline();
  } finally {
    pendingLikeIds.delete(currentTrack.id);
    if (playerDockLikeButton) {
      playerDockLikeButton.disabled = false;
    }
  }
});

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
  startTimelineClock();
  startLiveTimelineRefresh();
  updateEmptyState("\u66f2\u3092\u8aad\u307f\u8fbc\u3093\u3067\u3044\u307e\u3059\u3002");
  emptyState.hidden = false;
  await fetchTimeline();
}

async function fetchTimeline() {
  const response = await fetchJson(TIMELINE_ENDPOINT);

  if (!response.ok) {
    autoPlayMode = false;
    autoPlayShuffleMode = false;
    autoPlaySuperLikeOnlyMode = false;
    autoPlayQueueIds = [];
    clearAutoPlayAdvance();
    tracks = [];
    timelineStats = createEmptyTimelineStats();
    recommendation = null;
    currentUserSuperLikeTrackId = null;
    renderTimeline();
    renderPlayerDock();
    renderAutoPlayToggle();
    renderRadioControls();
    renderRadioMode();
    updateEmptyState(response.message || "\u30bf\u30a4\u30e0\u30e9\u30a4\u30f3\u306e\u8aad\u307f\u8fbc\u307f\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002");
    emptyState.hidden = false;
    return;
  }

  const nextTracks = Array.isArray(response.tracks) ? response.tracks : [];
  const nextTimelineStats = normalizeTimelineStats(response.stats, nextTracks);
  const nextRecommendation =
    response.recommendation && typeof response.recommendation === "object"
      ? response.recommendation
      : null;
  const previousSignature = buildTimelineSignature(tracks);
  const nextSignature = buildTimelineSignature(nextTracks);
  const previousRecommendationSignature = buildRecommendationSignature(recommendation);
  const nextRecommendationSignature = buildRecommendationSignature(nextRecommendation);
  const shouldRerenderTimeline =
    previousSignature !== nextSignature ||
    previousRecommendationSignature !== nextRecommendationSignature;

  tracks = nextTracks;
  timelineStats = nextTimelineStats;
  recommendation = nextRecommendation;
  currentUserSuperLikeTrackId = getCurrentUserSuperLikeTrackId(nextTracks);
  syncActiveTrack();
  syncSequenceTrack();

  if (shouldRerenderTimeline) {
    renderTimeline();
  }

  renderTimelineStats();
  renderPlayerDock();
  renderAutoPlayToggle();
  renderRadioControls();
  renderRadioMode();
  updateEmptyState("\u307e\u3060\u66f2\u306f\u3042\u308a\u307e\u305b\u3093\u3002\u6700\u521d\u306e1\u66f2\u3092\u6d41\u3057\u3066\u304f\u3060\u3055\u3044\u3002");

  if (autoPlayMode) {
    if (tracks.length === 0) {
      stopAutoPlayMode({
        quiet: true,
      });
    } else if (usesManualSequenceMode()) {
      clearAutoPlayAdvance();
    } else if (activeTrackId === null) {
      activateQueuedTrackFromStart();
    } else {
      scheduleAutoPlayAdvance();
    }
  }
}

function renderTimeline() {
  renderTimelineStats();
  renderSuperLikeSpotlight();
  renderRecommendation();
  timelineList.textContent = "";
  emptyState.hidden = tracks.length !== 0;

  const fragment = document.createDocumentFragment();
  const visibleTracks = recommendation
    ? tracks.filter((track) => track.id !== recommendation.id)
    : tracks;

  visibleTracks.forEach((track) => {
    const node = trackTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.trackId = String(track.id);
    const stamp = node.querySelector(".track-card__stamp");
    const link = node.querySelector(".track-card__link");
    const art = node.querySelector(".track-card__art");
    const title = node.querySelector(".track-card__title");
    const artist = node.querySelector(".track-card__artist");
    const playButton = node.querySelector(".track-card__play-button");
    const meterFill = node.querySelector(".track-card__meter-fill");
    const meterLabel = node.querySelector(".track-card__meter-label");
    const playCount = node.querySelector(".track-stat__count");
    const likeButton = node.querySelector(".like-button");
    const likeIcon = node.querySelector(".like-button__icon");
    const likeCount = node.querySelector(".like-button__count");
    const superLikeButton = node.querySelector(".super-like-button");
    const superLikeCount = node.querySelector(".super-like-button__count");
    const reportButton = node.querySelector(".report-button");

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
    playCount.dataset.trackId = String(track.id);
    likeCount.textContent = String(track.likeCount ?? 0);
    superLikeCount.textContent = String(track.superLikeCount ?? 0);
    renderTrackPlayButton(playButton, track.id === activeTrackId);

    updateLikeButton(likeButton, likeIcon, track);
    likeButton.disabled = pendingLikeIds.has(track.id);
    updateSuperLikeButton(superLikeButton, track);
    superLikeButton.dataset.busy = String(pendingSuperLikeIds.has(track.id));
    superLikeButton.disabled = pendingSuperLikeIds.has(track.id) || isSuperLikeLockedForTrack(track);
    updateReportButton(reportButton, track);
    reportButton.disabled = pendingReportIds.has(track.id);
    updateTrackMeter(meterFill, meterLabel, track);

    playButton.addEventListener("pointerenter", () => {
      prefetchEmbed(track.embedUrl);
    });

    playButton.addEventListener("focus", () => {
      prefetchEmbed(track.embedUrl);
    });

    playButton.addEventListener("pointerdown", () => {
      prefetchEmbed(track.embedUrl);
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

    superLikeButton.addEventListener("click", async () => {
      if (pendingSuperLikeIds.size > 0 || isSuperLikeLockedForTrack(track)) {
        return;
      }

      pendingSuperLikeIds.add(track.id);
      superLikeButton.dataset.busy = "true";
      superLikeButton.disabled = true;

      try {
        const response = await fetchJson(`/api/tracks/${track.id}/super-like`, {
          method: "POST",
          body: JSON.stringify({
            liked: !track.superLiked,
          }),
        });

        if (!response.ok || !response.track) {
          setFeedback(response.message || "超推し！の更新に失敗しました。");
          return;
        }

        await fetchTimeline();
      } finally {
        pendingSuperLikeIds.delete(track.id);
        superLikeButton.dataset.busy = "false";
        superLikeButton.disabled = pendingSuperLikeIds.has(track.id) || isSuperLikeLockedForTrack(track);
        renderTimeline();
      }
    });

    reportButton.addEventListener("click", async () => {
      if (pendingReportIds.has(track.id)) {
        return;
      }

      pendingReportIds.add(track.id);
      reportButton.disabled = true;

      try {
        const response = await fetchJson(`/api/tracks/${track.id}/report`, {
          method: "POST",
          body: JSON.stringify({
            reported: !track.reportActive,
          }),
        });

        if (!response.ok || !response.track) {
          setFeedback(response.message || "通報状態の更新に失敗しました。");
          return;
        }

        syncTrack(track, response.track);
        syncTrackInCollection(response.track);
        updateReportButton(reportButton, track);
        updateTrackMeter(meterFill, meterLabel, track);
      } finally {
        pendingReportIds.delete(track.id);
        reportButton.disabled = false;
      }
    });

    fragment.appendChild(node);
  });

  timelineList.appendChild(fragment);
  updateCountdownMeters();
}

function renderTimelineStats() {
  if (
    !timelineStatTrackCount ||
    !timelineStatLikeCount ||
    !timelineStatPlayCount ||
    !timelineStatSuperLikeCount
  ) {
    return;
  }

  timelineStatTrackCount.textContent = formatTimelineStat(timelineStats.trackCount);
  timelineStatLikeCount.textContent = formatTimelineStat(timelineStats.likeCount);
  timelineStatPlayCount.textContent = formatTimelineStat(timelineStats.playCount);
  timelineStatSuperLikeCount.textContent = formatTimelineStat(timelineStats.superLikeCount);
}

function normalizeTimelineStats(rawStats, trackList) {
  if (rawStats && typeof rawStats === "object") {
    return {
      trackCount: normalizeStatCount(rawStats.trackCount),
      likeCount: normalizeStatCount(rawStats.likeCount),
      playCount: normalizeStatCount(rawStats.playCount),
      superLikeCount: normalizeStatCount(rawStats.superLikeCount),
    };
  }

  return trackList.reduce(
    (summary, track) => {
      summary.trackCount += 1;
      summary.likeCount += normalizeStatCount(track.likeCount);
      summary.playCount += normalizeStatCount(track.playCount);
      summary.superLikeCount += normalizeStatCount(track.superLikeCount);
      return summary;
    },
    createEmptyTimelineStats(),
  );
}

function createEmptyTimelineStats() {
  return {
    trackCount: 0,
    likeCount: 0,
    playCount: 0,
    superLikeCount: 0,
  };
}

function normalizeStatCount(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return 0;
  }

  return Math.floor(numericValue);
}

function formatTimelineStat(value) {
  return normalizeStatCount(value).toLocaleString("ja-JP");
}

function renderRecommendation() {
  if (!timelinePick || !timelinePickCard) {
    return;
  }

  timelinePickCard.textContent = "";

  if (!recommendation) {
    timelinePick.hidden = true;
    return;
  }

  timelinePickCard.appendChild(buildRecommendationCard(recommendation));
  timelinePick.hidden = false;
}

function renderSuperLikeSpotlight() {
  if (!superLikeSpotlight || !superLikeSpotlightList || !superLikeSpotlightToggle) {
    return;
  }

  superLikeSpotlightList.textContent = "";

  const spotlightTracks = [...tracks]
    .filter((track) => normalizeStatCount(track.superLikeCount) > 0)
    .sort((left, right) => {
      if (left.superLiked !== right.superLiked) {
        return left.superLiked ? -1 : 1;
      }

      return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    });

  if (spotlightTracks.length === 0) {
    superLikeSpotlight.hidden = true;
    superLikeSpotlightToggle.hidden = true;
    isSuperLikeSpotlightExpanded = false;
    return;
  }

  const hasOverflow = spotlightTracks.length > SUPER_LIKE_SPOTLIGHT_COLLAPSED_COUNT;
  const visibleTracks =
    hasOverflow && !isSuperLikeSpotlightExpanded
      ? spotlightTracks.slice(0, SUPER_LIKE_SPOTLIGHT_COLLAPSED_COUNT)
      : spotlightTracks;

  const fragment = document.createDocumentFragment();

  visibleTracks.forEach((track) => {
    fragment.appendChild(buildSuperLikeSpotlightCard(track));
  });

  superLikeSpotlightList.appendChild(fragment);
  superLikeSpotlight.hidden = false;

  if (!hasOverflow) {
    superLikeSpotlightToggle.hidden = true;
    superLikeSpotlightToggle.setAttribute("aria-expanded", "false");
    isSuperLikeSpotlightExpanded = false;
    return;
  }

  const hiddenCount = spotlightTracks.length - SUPER_LIKE_SPOTLIGHT_COLLAPSED_COUNT;
  superLikeSpotlightToggle.hidden = false;
  superLikeSpotlightToggle.textContent = isSuperLikeSpotlightExpanded
    ? "Show less"
    : `+${hiddenCount} more`;
  superLikeSpotlightToggle.setAttribute("aria-expanded", String(isSuperLikeSpotlightExpanded));
}

function buildSuperLikeSpotlightCard(track) {
  const article = document.createElement("article");
  article.className = "super-like-spotlight-card";

  const title = document.createElement("h4");
  title.className = "super-like-spotlight-card__title";
  title.textContent = track.title || "Untitled";

  const artist = document.createElement("p");
  artist.className = "super-like-spotlight-card__artist";
  artist.textContent = track.artist || "Unknown artist";

  const meta = document.createElement("div");
  meta.className = "super-like-spotlight-card__meta";

  const badge = document.createElement("p");
  badge.className = "super-like-spotlight-card__count";
  badge.textContent = `👍 超推し！ ${normalizeStatCount(track.superLikeCount)}`;

  const mine = document.createElement("p");
  mine.className = "super-like-spotlight-card__mine";
  mine.hidden = !track.superLiked;
  mine.textContent = "YOUR PICK";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "super-like-spotlight-card__button";
  button.textContent = "VIEW";
  button.addEventListener("click", () => {
    scrollTrackIntoView(track.id);
  });

  meta.append(badge, mine, button);
  article.append(title, artist, meta);
  return article;
}

function scrollTrackIntoView(trackId) {
  const target = document.querySelector(`.track-card[data-track-id="${trackId}"]`);

  if (!target) {
    return;
  }

  target.scrollIntoView({
    behavior: "smooth",
    block: "center",
  });

  target.classList.add("track-card--spotlighted");
  window.setTimeout(() => {
    target.classList.remove("track-card--spotlighted");
  }, 1600);
}

function buildRecommendationCard(track) {
  const node = trackTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.trackId = String(track.id);
  node.classList.add("track-card--featured");

  const stamp = node.querySelector(".track-card__stamp");
  const link = node.querySelector(".track-card__link");
  const art = node.querySelector(".track-card__art");
  const title = node.querySelector(".track-card__title");
  const artist = node.querySelector(".track-card__artist");
  const playButton = node.querySelector(".track-card__play-button");
  const meterFill = node.querySelector(".track-card__meter-fill");
  const meterLabel = node.querySelector(".track-card__meter-label");
  const playCount = node.querySelector(".track-stat__count");
  const likeButton = node.querySelector(".like-button");
  const likeIcon = node.querySelector(".like-button__icon");
  const likeCount = node.querySelector(".like-button__count");
  const superLikeButton = node.querySelector(".super-like-button");
  const superLikeCount = node.querySelector(".super-like-button__count");
  const reportButton = node.querySelector(".report-button");

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
  playCount.dataset.trackId = String(track.id);
  likeCount.textContent = String(track.likeCount ?? 0);
  superLikeCount.textContent = String(track.superLikeCount ?? 0);
  renderTrackPlayButton(playButton, track.id === activeTrackId);

  updateLikeButton(likeButton, likeIcon, track);
  likeButton.disabled = pendingLikeIds.has(track.id);
  updateSuperLikeButton(superLikeButton, track);
  superLikeButton.dataset.busy = String(pendingSuperLikeIds.has(track.id));
  superLikeButton.disabled = pendingSuperLikeIds.has(track.id) || isSuperLikeLockedForTrack(track);
  updateReportButton(reportButton, track);
  reportButton.disabled = pendingReportIds.has(track.id);
  updateTrackMeter(meterFill, meterLabel, track);

  playButton.addEventListener("pointerenter", () => {
    prefetchEmbed(track.embedUrl);
  });

  playButton.addEventListener("focus", () => {
    prefetchEmbed(track.embedUrl);
  });

  playButton.addEventListener("pointerdown", () => {
    prefetchEmbed(track.embedUrl);
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
      syncRecommendationTrack(response.track);
      likeCount.textContent = String(track.likeCount ?? 0);
      updateLikeButton(likeButton, likeIcon, track);
    } finally {
      pendingLikeIds.delete(track.id);
      likeButton.disabled = false;
    }
  });

  superLikeButton.addEventListener("click", async () => {
    if (pendingSuperLikeIds.size > 0 || isSuperLikeLockedForTrack(track)) {
      return;
    }

    pendingSuperLikeIds.add(track.id);
    superLikeButton.dataset.busy = "true";
    superLikeButton.disabled = true;

    try {
      const response = await fetchJson(`/api/tracks/${track.id}/super-like`, {
        method: "POST",
        body: JSON.stringify({
          liked: !track.superLiked,
        }),
      });

      if (!response.ok || !response.track) {
        setFeedback(response.message || "超推し！の更新に失敗しました。");
        return;
      }

      await fetchTimeline();
    } finally {
      pendingSuperLikeIds.delete(track.id);
      superLikeButton.dataset.busy = "false";
      superLikeButton.disabled = pendingSuperLikeIds.has(track.id) || isSuperLikeLockedForTrack(track);
      renderTimeline();
    }
  });

  reportButton.addEventListener("click", async () => {
    if (pendingReportIds.has(track.id)) {
      return;
    }

    pendingReportIds.add(track.id);
    reportButton.disabled = true;

    try {
      const response = await fetchJson(`/api/tracks/${track.id}/report`, {
        method: "POST",
        body: JSON.stringify({
          reported: !track.reportActive,
        }),
      });

      if (!response.ok || !response.track) {
        setFeedback(response.message || "\u901a\u5831\u306e\u66f4\u65b0\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002");
        return;
      }

      syncTrack(track, response.track);
      syncTrackInCollection(response.track);
      syncRecommendationTrack(response.track);
      updateReportButton(reportButton, track);
      updateTrackMeter(meterFill, meterLabel, track);
    } finally {
      pendingReportIds.delete(track.id);
      reportButton.disabled = false;
    }
  });

  return node;
}

function renderTrackPlayButton(button, isActive) {
  button.dataset.active = String(isActive);
  button.setAttribute("aria-label", isActive ? "Now playing" : "Play");
  button.innerHTML = isActive
    ? '<span class="track-card__play-status">NOW PLAYING</span>'
    : '<span class="track-card__play-icon" aria-hidden="true">&#9654;</span><span class="sr-only">Play</span>';
}

function renderPlayerDock(options = {}) {
  const currentTrack = getPlayerDockTrack();

  if (!currentTrack) {
    playerDock.hidden = true;
    playerDockIframe.src = "about:blank";
    playerDockArtist.textContent = "";
    if (playerDockFrame) {
      playerDockFrame.hidden = true;
    }
    document.body.classList.remove("has-player-dock");
    renderRadioControls();
    return;
  }

  const shouldShowFrame = activeTrackId === currentTrack.id;
  playerDock.hidden = false;
  playerDockArtist.textContent = currentTrack.artist || "Unknown artist";

  if (playerDockLikeButton && playerDockLikeIcon && playerDockLikeCount) {
    updateLikeButton(playerDockLikeButton, playerDockLikeIcon, currentTrack);
    playerDockLikeCount.textContent = String(currentTrack.likeCount ?? 0);
    playerDockLikeButton.hidden = !autoPlayMode;
    playerDockLikeButton.disabled = pendingLikeIds.has(currentTrack.id);
  }

  if (playerDockOpenLink) {
    playerDockOpenLink.href = currentTrack.canonicalUrl || currentTrack.sourceUrl;
    playerDockOpenLink.hidden = !autoPlayMode;
  }

  if (playerDockFrame) {
    playerDockFrame.hidden = !shouldShowFrame;
  }

  if (shouldShowFrame) {
    updatePlayerDockEmbed(currentTrack.embedUrl, Boolean(options.forceRestart));
  } else {
    playerDockIframe.src = "about:blank";
  }

  renderRadioControls();

  document.body.classList.add("has-player-dock");
}

function syncTrackPlaybackButtons(previousTrackId, nextTrackId) {
  const trackIds = new Set([previousTrackId, nextTrackId].filter((value) => value !== null));

  trackIds.forEach((trackId) => {
    document.querySelectorAll(`[data-track-id="${trackId}"]`).forEach((card) => {
      const playButton = card.querySelector(".track-card__play-button");

      if (playButton) {
        renderTrackPlayButton(playButton, trackId === nextTrackId);
      }
    });
  });
}

function updateTrackPlayCount(trackId, playCount) {
  document
    .querySelectorAll(`.track-stat__count[data-track-id="${trackId}"]`)
    .forEach((playCountElement) => {
      playCountElement.textContent = String(playCount ?? 0);
    });
}

function updateLikeButton(button, icon, track) {
  const isLiked = Boolean(track.liked);
  button.dataset.liked = String(isLiked);
  button.setAttribute("aria-pressed", String(isLiked));
  icon.textContent = isLiked ? "\u2665" : "\u2661";
}

function updateSuperLikeButton(button, track) {
  const isSuperLiked = Boolean(track.superLiked);
  button.dataset.superLiked = String(isSuperLiked);
  button.setAttribute("aria-pressed", String(isSuperLiked));
}

function updateReportButton(button, track) {
  const isReported = Boolean(track.reportActive);
  button.dataset.active = String(isReported);
  button.setAttribute("aria-pressed", String(isReported));
  button.querySelector(".report-button__label").textContent = isReported ? "通報中" : "通報";
}

function syncTrack(currentTrack, nextTrack) {
  currentTrack.sourceUrl = nextTrack.sourceUrl;
  currentTrack.canonicalUrl = nextTrack.canonicalUrl;
  currentTrack.embedUrl = nextTrack.embedUrl;
  currentTrack.trackKey = nextTrack.trackKey;
  currentTrack.title = nextTrack.title;
  currentTrack.artist = nextTrack.artist;
  currentTrack.imageUrl = nextTrack.imageUrl;
  currentTrack.durationSeconds = nextTrack.durationSeconds;
  currentTrack.playCount = nextTrack.playCount;
  currentTrack.reportActive = nextTrack.reportActive;
  currentTrack.reportStartedAt = nextTrack.reportStartedAt;
  currentTrack.createdAt = nextTrack.createdAt;
  currentTrack.likeCount = nextTrack.likeCount;
  currentTrack.liked = nextTrack.liked;
  currentTrack.superLikeCount = nextTrack.superLikeCount;
  currentTrack.superLiked = nextTrack.superLiked;
}

function buildTimelineSignature(trackList) {
  return JSON.stringify(
    trackList.map((track) => [
      track.id,
      track.trackKey,
      track.title,
      track.artist,
      track.imageUrl,
      track.durationSeconds,
      track.playCount,
      track.likeCount,
      track.liked,
      track.superLikeCount,
      track.superLiked,
      track.reportActive,
      track.reportStartedAt,
      track.createdAt,
    ])
  );
}

function syncActiveTrack() {
  if (tracks.some((track) => track.id === activeTrackId)) {
    return;
  }

  activeTrackId = null;
  clearAutoPlayAdvance();
}

function syncSequenceTrack() {
  if (!autoPlayMode || !usesManualSequenceMode()) {
    sequenceTrackId = null;
    return;
  }

  if (tracks.some((track) => track.id === sequenceTrackId)) {
    return;
  }

  const fallbackTrack = getFirstAutoPlayTrack();
  sequenceTrackId = fallbackTrack ? fallbackTrack.id : null;
}

function syncTrackInCollection(nextTrack) {
  const existingTrack = tracks.find((track) => track.id === nextTrack.id);

  if (!existingTrack) {
    return;
  }

  syncTrack(existingTrack, nextTrack);
}

function syncRecommendationTrack(nextTrack) {
  if (!recommendation || recommendation.id !== nextTrack.id) {
    return;
  }

  syncTrack(recommendation, nextTrack);
}

function getCurrentUserSuperLikeTrackId(trackList = tracks) {
  const selectedTrack = trackList.find((track) => track.superLiked);
  return selectedTrack ? selectedTrack.id : null;
}

function isSuperLikeLockedForTrack(track) {
  if (!currentUserSuperLikeTrackId) {
    return false;
  }

  return currentUserSuperLikeTrackId !== track.id;
}

function buildRecommendationSignature(track) {
  if (!track) {
    return "null";
  }

  return JSON.stringify([
    track.id,
    track.trackKey,
    track.title,
    track.artist,
    track.imageUrl,
    track.durationSeconds,
    track.playCount,
    track.likeCount,
    track.liked,
    track.superLikeCount,
    track.superLiked,
    track.reportActive,
    track.reportStartedAt,
    track.createdAt,
  ]);
}

function parseSunoUrl(value) {
  if (typeof value !== "string") {
    return {
      ok: false,
      message: "SUNOの共有リンクを貼ってください。",
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
      message: "https:// から始まるSUNOリンクを貼ってください。",
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
      message: "SUNO\u306e\u5171\u6709\u30ea\u30f3\u30af\u3092\u8cbc\u3063\u3066\u304f\u3060\u3055\u3044\u3002",
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
      message: "SUNOの共有リンクを貼ってください。",
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
    message: "SUNOの共有リンクを貼ってください。",
  };
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function ensureAnonymousClientId() {
  const existing = readLocalStorage(ANONYMOUS_CLIENT_ID_KEY);

  if (existing && isUuid(existing)) {
    return existing;
  }

  const created = createAnonymousClientId();
  writeLocalStorage(ANONYMOUS_CLIENT_ID_KEY, created);
  return created;
}

function createAnonymousClientId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  const randomBytes = new Uint8Array(16);

  if (window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(randomBytes);
  } else {
    for (let index = 0; index < randomBytes.length; index += 1) {
      randomBytes[index] = Math.floor(Math.random() * 256);
    }
  }

  randomBytes[6] = (randomBytes[6] & 0x0f) | 0x40;
  randomBytes[8] = (randomBytes[8] & 0x3f) | 0x80;

  const hex = Array.from(randomBytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readLocalStorage(key) {
  try {
    return window.localStorage.getItem(key);
  } catch (error) {
    return null;
  }
}

function writeLocalStorage(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch (error) {
    // Ignore storage write failures and continue with the in-memory identifier.
  }
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
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function buildAutoplayEmbedUrl(embedUrl) {
  const url = new URL(embedUrl);
  url.searchParams.set("autoplay", "1");
  return url.toString();
}

function updatePlayerDockEmbed(embedUrl, forceRestart = false) {
  const nextSrc = buildAutoplayEmbedUrl(embedUrl);

  if (playerDockIframe.src === nextSrc && !forceRestart) {
    return;
  }

  if (playerDockIframe.src === nextSrc && forceRestart) {
    playerDockIframe.src = "about:blank";
    window.requestAnimationFrame(() => {
      playerDockIframe.src = nextSrc;
    });
    return;
  }

  playerDockIframe.src = nextSrc;
}

function startTimelineClock() {
  if (timelineClock) {
    return;
  }

  timelineClock = window.setInterval(() => {
    updateCountdownMeters();
  }, 1000);
}

function startLiveTimelineRefresh() {
  if (timelineLiveRefresh) {
    return;
  }

  timelineLiveRefresh = window.setInterval(() => {
    if (document.hidden || timelineRefreshInFlight) {
      return;
    }

    timelineRefreshInFlight = true;
    void fetchTimeline().finally(() => {
      timelineRefreshInFlight = false;
    });
  }, TIMELINE_LIVE_REFRESH_MS);
}

function updateCountdownMeters() {
  let hasExpiredTrack = false;

  timelineList.querySelectorAll(".track-card").forEach((node) => {
    const trackId = Number(node.dataset.trackId || 0);
    const track = tracks.find((item) => item.id === trackId);

    if (!track) {
      return;
    }

    const meterFill = node.querySelector(".track-card__meter-fill");
    const meterLabel = node.querySelector(".track-card__meter-label");
    updateTrackMeter(meterFill, meterLabel, track);

    const countdown = getTrackCountdown(track);
    if (countdown.remainingMs <= 0) {
      hasExpiredTrack = true;
    }
  });

  if (hasExpiredTrack && !timelineRefreshInFlight) {
    timelineRefreshInFlight = true;
    void fetchTimeline().finally(() => {
      timelineRefreshInFlight = false;
    });
  }
}

function updateTrackMeter(fill, label, track) {
  const countdown = getTrackCountdown(track);
  const progress = Math.min(100, Math.max(0, (countdown.remainingMs / countdown.totalMs) * 100));

  fill.style.width = `${progress}%`;
  fill.dataset.mode = countdown.mode;
  label.textContent = buildCountdownLabel(countdown);
}

function getTrackCountdown(track) {
  const now = Date.now();
  const naturalDeadline = new Date(track.createdAt).getTime() + TRACK_LIFETIME_MS;
  const reportDeadline =
    track.reportActive && track.reportStartedAt
      ? new Date(track.reportStartedAt).getTime() + REPORT_LIFETIME_MS
      : Number.POSITIVE_INFINITY;

  if (reportDeadline < naturalDeadline) {
    return {
      mode: "report",
      totalMs: REPORT_LIFETIME_MS,
      remainingMs: Math.max(0, reportDeadline - now),
    };
  }

  return {
    mode: "timeline",
    totalMs: TRACK_LIFETIME_MS,
    remainingMs: Math.max(0, naturalDeadline - now),
  };
}

function buildCountdownLabel(countdown) {
  if (countdown.remainingMs <= 0) {
    return "まもなく消えます";
  }

  const parts = [];
  let remainingSeconds = Math.ceil(countdown.remainingMs / 1000);
  const hours = Math.floor(remainingSeconds / 3600);
  remainingSeconds -= hours * 3600;
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds - minutes * 60;

  if (hours > 0) {
    parts.push(`${hours}時間`);
  }

  if (minutes > 0) {
    parts.push(`${minutes}分`);
  }

  if (hours === 0 && seconds > 0) {
    parts.push(`${seconds}秒`);
  }

  const prefix = countdown.mode === "report" ? "通報で消えるまで" : "24時間で消えるまで";
  return `${prefix} 残り${parts.join(" ")}`;
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

function renderAutoPlayToggle() {
  if (!autoPlayToggle || !autoPlayShuffleToggle || !autoPlaySuperLikeToggle) {
    return;
  }

  const isDisabled = tracks.length === 0;
  const hasSuperLikeTracks = tracks.some((track) => normalizeStatCount(track.superLikeCount) > 0);
  autoPlayToggle.disabled = isDisabled;
  autoPlayShuffleToggle.disabled = isDisabled;
  autoPlaySuperLikeToggle.disabled = isDisabled || !hasSuperLikeTracks;
  autoPlayToggle.dataset.active = String(
    autoPlayMode && !autoPlayShuffleMode && !autoPlaySuperLikeOnlyMode,
  );
  autoPlayShuffleToggle.dataset.active = String(autoPlayMode && autoPlayShuffleMode);
  autoPlaySuperLikeToggle.dataset.active = String(autoPlayMode && autoPlaySuperLikeOnlyMode);
  autoPlayToggle.setAttribute(
    "aria-pressed",
    String(autoPlayMode && !autoPlayShuffleMode && !autoPlaySuperLikeOnlyMode),
  );
  autoPlayShuffleToggle.setAttribute("aria-pressed", String(autoPlayMode && autoPlayShuffleMode));
  autoPlaySuperLikeToggle.setAttribute("aria-pressed", String(autoPlayMode && autoPlaySuperLikeOnlyMode));
  autoPlayToggle.textContent = "AUTO PLAY";
  autoPlayShuffleToggle.textContent = "AUTO PLAY (SHUFFLE)";
  autoPlaySuperLikeToggle.textContent = "AUTO PLAY (超推し！のみ)";
}

function renderRadioControls() {
  if (!radioControls || !startTrackButton || !nextTrackButton || !stopRadioButton) {
    return;
  }

  if (!autoPlayMode) {
    radioControls.hidden = true;
    startTrackButton.hidden = true;
    nextTrackButton.hidden = true;
    stopRadioButton.hidden = true;
    if (playerDockLikeButton) {
      playerDockLikeButton.hidden = true;
    }
    if (playerDockOpenLink) {
      playerDockOpenLink.hidden = true;
    }
    startTrackButton.disabled = true;
    nextTrackButton.disabled = true;
    stopRadioButton.disabled = true;
    return;
  }

  if (usesManualSequenceMode()) {
    radioControls.hidden = !autoPlayMode || sequenceTrackId === null;
    startTrackButton.hidden = false;
    nextTrackButton.hidden = false;
    stopRadioButton.hidden = false;
    startTrackButton.disabled = sequenceTrackId === null;
    nextTrackButton.disabled = !canAdvanceToNextTrack();
  } else {
    radioControls.hidden = !autoPlayMode || activeTrackId === null;
    startTrackButton.hidden = true;
    nextTrackButton.hidden = false;
    stopRadioButton.hidden = false;
    startTrackButton.disabled = true;
    nextTrackButton.disabled = !canAdvanceToNextTrack();
  }

  stopRadioButton.disabled = !autoPlayMode;

  if (playerDockLikeButton) {
    playerDockLikeButton.hidden = !autoPlayMode;
  }

  if (playerDockOpenLink) {
    playerDockOpenLink.hidden = !autoPlayMode;
  }
}

function renderRadioMode() {
  document.body.classList.toggle("radio-mode", autoPlayMode);

  if (layout) {
    layout.inert = autoPlayMode;
  }
}

function startAutoPlayFromTop(options = {}) {
  if (tracks.length === 0) {
    return;
  }

  autoPlayShuffleMode = Boolean(options.shuffle);
  autoPlaySuperLikeOnlyMode = Boolean(options.superLikeOnly);
  autoPlayQueueIds = buildAutoPlayQueueIds({
    shuffle: autoPlayShuffleMode,
    superLikeOnly: autoPlaySuperLikeOnlyMode,
  });
  autoPlayMode = true;

  if (usesManualSequenceMode()) {
    const firstTrack = getFirstAutoPlayTrack();
    sequenceTrackId = firstTrack ? firstTrack.id : null;
    activeTrackId = null;
    clearAutoPlayAdvance();
    renderPlayerDock();
    renderAutoPlayToggle();
    renderRadioControls();
    renderRadioMode();
  } else {
    const firstTrack = getFirstAutoPlayTrack();

    if (!firstTrack) {
      autoPlayMode = false;
      autoPlayShuffleMode = false;
      autoPlaySuperLikeOnlyMode = false;
      return;
    }

    activateTrack(firstTrack, null, {
      force: true,
      suppressAutoPlayRefresh: true,
    });

    renderAutoPlayToggle();
    renderRadioControls();
    renderRadioMode();
    scheduleAutoPlayAdvance();
  }

  if (!options.quiet) {
    setFeedback("連続再生モードで上から流します。");
  }
}

function stopAutoPlayMode(options = {}) {
  autoPlayMode = false;
  autoPlayShuffleMode = false;
  autoPlaySuperLikeOnlyMode = false;
  autoPlayQueueIds = [];
  sequenceTrackId = null;
  const previousActiveTrackId = activeTrackId;
  activeTrackId = null;
  clearAutoPlayAdvance();
  renderPlayerDock();
  syncTrackPlaybackButtons(previousActiveTrackId, activeTrackId);
  renderAutoPlayToggle();
  renderRadioControls();
  renderRadioMode();

  if (!options.quiet) {
    setFeedback("連続再生モードを止めました。");
  }
}

function buildAutoPlayQueueIds(options = {}) {
  const shuffle = Boolean(options.shuffle);
  const superLikeOnly = Boolean(options.superLikeOnly);
  const queueIds = tracks
    .filter((track) => !superLikeOnly || normalizeStatCount(track.superLikeCount) > 0)
    .map((track) => track.id);

  if (!shuffle) {
    return queueIds;
  }

  for (let index = queueIds.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const current = queueIds[index];
    queueIds[index] = queueIds[swapIndex];
    queueIds[swapIndex] = current;
  }

  return queueIds;
}

function clearAutoPlayAdvance() {
  if (autoPlayTimeout === null) {
    autoPlayScheduledTrackId = null;
    autoPlayAdvanceAtMs = 0;
    return;
  }

  window.clearTimeout(autoPlayTimeout);
  autoPlayTimeout = null;
  autoPlayScheduledTrackId = null;
  autoPlayAdvanceAtMs = 0;
}

function scheduleAutoPlayAdvance() {
  if (!autoPlayMode || usesManualSequenceMode()) {
    clearAutoPlayAdvance();
    return;
  }

  const currentTrack = tracks.find((track) => track.id === activeTrackId);

  if (!currentTrack) {
    return;
  }

  if (autoPlayTimeout !== null && autoPlayScheduledTrackId === currentTrack.id) {
    return;
  }

  clearAutoPlayAdvance();
  const delayMs = getAutoAdvanceDelay(currentTrack);
  autoPlayScheduledTrackId = currentTrack.id;
  autoPlayAdvanceAtMs = Date.now() + delayMs;

  autoPlayTimeout = window.setTimeout(() => {
    autoPlayTimeout = null;
    autoPlayScheduledTrackId = null;
    autoPlayAdvanceAtMs = 0;

    if (!autoPlayMode) {
      return;
    }

    const nextTrack = getNextAutoPlayTrack(currentTrack.id);

    if (!nextTrack) {
      stopAutoPlayMode({
        quiet: true,
      });
      return;
    }

    activateTrack(nextTrack, null, {
      force: true,
    });
  }, delayMs);
}

function getNextAutoPlayTrack(currentTrackId) {
  const currentIndex = autoPlayQueueIds.indexOf(currentTrackId);

  if (currentIndex < 0) {
    return null;
  }

  for (let index = currentIndex + 1; index < autoPlayQueueIds.length; index += 1) {
    const nextTrack = tracks.find((track) => track.id === autoPlayQueueIds[index]);

    if (nextTrack) {
      return nextTrack;
    }
  }

  return null;
}

function getFirstAutoPlayTrack() {
  for (const trackId of autoPlayQueueIds) {
    const track = tracks.find((item) => item.id === trackId);

    if (track) {
      return track;
    }
  }

  return null;
}

function canAdvanceToNextTrack() {
  if (!autoPlayMode) {
    return false;
  }

  if (usesManualSequenceMode()) {
    return sequenceTrackId !== null && Boolean(getNextAutoPlayTrack(sequenceTrackId));
  }

  if (activeTrackId === null) {
    return false;
  }

  return Boolean(getNextAutoPlayTrack(activeTrackId));
}

function advanceToNextTrack() {
  if (!autoPlayMode) {
    return;
  }

  const currentTrackId = usesManualSequenceMode() ? sequenceTrackId : activeTrackId;
  const nextTrack = getNextAutoPlayTrack(currentTrackId);

  if (!nextTrack) {
    stopAutoPlayMode({
      quiet: true,
    });
    return;
  }

  if (usesManualSequenceMode()) {
    playSequenceTrack(nextTrack, {
      force: true,
    });
    return;
  }

  activateTrack(nextTrack, null, {
    force: true,
  });
}

function activateQueuedTrackFromStart() {
  const firstTrack = getFirstAutoPlayTrack();

  if (!firstTrack) {
    stopAutoPlayMode({
      quiet: true,
    });
    return;
  }

  activateTrack(firstTrack, null, {
    force: true,
  });
}

function startCurrentSequenceTrack() {
  if (!usesManualSequenceMode() || sequenceTrackId === null) {
    return;
  }

  const currentTrack = tracks.find((track) => track.id === sequenceTrackId);

  if (!currentTrack) {
    return;
  }

  playSequenceTrack(currentTrack, {
    force: true,
  });
}

function playSequenceTrack(track, options = {}) {
  sequenceTrackId = track.id;
  activateTrack(track, null, options);
}

function getAutoAdvanceDelay(track) {
  const durationSeconds =
    typeof track?.durationSeconds === "number" && track.durationSeconds > 0
      ? track.durationSeconds
      : DEFAULT_DURATION_SECONDS;

  return Math.max(4000, Math.round(durationSeconds * 1000 + AUTO_ADVANCE_BUFFER_MS));
}

async function recordPlay(trackId, playCountElement) {
  const response = await fetchJson(`/api/tracks/${trackId}/play`, {
    method: "POST",
  });

  if (!response.ok || !response.track) {
    return;
  }

  syncTrackInCollection(response.track);
  updateTrackPlayCount(trackId, response.track.playCount);

  if (activeTrackId === trackId) {
    return;
  }

  const updatedTrack = tracks.find((track) => track.id === trackId);

  if (updatedTrack && playCountElement?.isConnected) {
    playCountElement.textContent = String(updatedTrack.playCount ?? 0);
  }
}

function activateTrack(track, playCountElement, options = {}) {
  const force = Boolean(options.force);
  const suppressAutoPlayRefresh = Boolean(options.suppressAutoPlayRefresh);

  if (track.id === activeTrackId && !force) {
    return;
  }

  const previousActiveTrackId = activeTrackId;
  activeTrackId = track.id;

  if (autoPlayMode && usesManualSequenceMode()) {
    sequenceTrackId = track.id;
  }

  renderPlayerDock({
    forceRestart: force,
  });
  syncTrackPlaybackButtons(previousActiveTrackId, activeTrackId);

  if (!suppressAutoPlayRefresh) {
    renderAutoPlayToggle();
    renderRadioControls();
    renderRadioMode();

    if (autoPlayMode) {
      scheduleAutoPlayAdvance();
    } else {
      clearAutoPlayAdvance();
    }
  }

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

function getPlayerDockTrack() {
  if (autoPlayMode && usesManualSequenceMode() && sequenceTrackId !== null) {
    return tracks.find((track) => track.id === sequenceTrackId) || null;
  }

  return tracks.find((track) => track.id === activeTrackId) || null;
}

function usesManualSequenceMode() {
  return isIphoneSafari();
}

function isIphoneSafari() {
  const userAgent = navigator.userAgent || "";
  const isIphone = /iPhone/.test(userAgent);
  const isSafari = /Safari/.test(userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|GSA/.test(userAgent);
  return isIphone && isSafari;
}
