import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT_DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(process.env.DATA_DIR || resolve(ROOT_DIR, ".data"));
const DB_PATH = resolve(DATA_DIR, "suno-timeline.sqlite");
const OEMBED_ENDPOINT = "https://studio-api-prod.suno.com/api/oembed?url=";
const TRACK_LIFETIME_MS = 24 * 60 * 60 * 1000;
const POST_COOLDOWN_MS = 10 * 1000;
const POST_WINDOW_MS = 60 * 60 * 1000;
const POST_WINDOW_LIMIT = 10;
const INVALID_URL_WINDOW_MS = 15 * 60 * 1000;
const INVALID_URL_LIMIT = 5;
const INVALID_URL_BLOCK_MS = 15 * 60 * 1000;
const ABUSE_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_JSON_BODY_BYTES = 8 * 1024;
const MAX_SUNO_URL_LENGTH = 2048;
const ABUSE_HASH_SECRET = process.env.ABUSE_HASH_SECRET || "suno-timeline-local-abuse-secret";
const TRUST_PROXY = process.env.TRUST_PROXY === "true";
const ADMIN_PURGE_KEY = String(process.env.ADMIN_PURGE_KEY || "").trim();
const ADMIN_PURGE_PATH = ADMIN_PURGE_KEY ? `/admin/purge/${encodeURIComponent(ADMIN_PURGE_KEY)}` : "";
const ID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const ANONYMOUS_CLIENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const SUNO_HOSTNAMES = new Set(["suno.com", "www.suno.com"]);
const SUNO_SHARE_KEY_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;
const PUBLIC_FILES = new Set(["/index.html", "/styles.css", "/app.js"]);
const ASSETS_DIR = resolve(ROOT_DIR, "assets");

mkdirSync(DATA_DIR, {
  recursive: true,
});

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_url TEXT NOT NULL,
    canonical_url TEXT NOT NULL,
    embed_url TEXT NOT NULL,
    track_key TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL DEFAULT '',
    artist TEXT NOT NULL DEFAULT '',
    image_url TEXT NOT NULL DEFAULT '',
    play_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS likes (
    track_id INTEGER NOT NULL,
    anonymous_client_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (track_id, anonymous_client_id),
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS abuse_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_type TEXT NOT NULL,
    subject_key TEXT NOT NULL,
    event_type TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS abuse_blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_type TEXT NOT NULL,
    subject_key TEXT NOT NULL,
    reason TEXT NOT NULL,
    blocked_until TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS abuse_events_lookup_idx
  ON abuse_events (subject_type, subject_key, event_type, created_at);

  CREATE INDEX IF NOT EXISTS abuse_blocks_lookup_idx
  ON abuse_blocks (subject_type, subject_key, blocked_until);
`);

ensureTracksColumn("title", "TEXT NOT NULL DEFAULT ''");
ensureTracksColumn("artist", "TEXT NOT NULL DEFAULT ''");
ensureTracksColumn("image_url", "TEXT NOT NULL DEFAULT ''");
ensureTracksColumn("play_count", "INTEGER NOT NULL DEFAULT 0");

const selectTimelineStatement = db.prepare(`
  SELECT
    t.id,
    t.source_url,
    t.canonical_url,
    t.embed_url,
    t.track_key,
    t.title,
    t.artist,
    t.image_url,
    t.play_count,
    t.created_at,
    (
      SELECT COUNT(*)
      FROM likes l
      WHERE l.track_id = t.id
    ) AS like_count,
    EXISTS(
      SELECT 1
      FROM likes l
      WHERE l.track_id = t.id
        AND l.anonymous_client_id = ?
    ) AS liked
  FROM tracks t
  ORDER BY t.created_at DESC, t.id DESC
`);

const selectTrackByIdStatement = db.prepare(`
  SELECT
    t.id,
    t.source_url,
    t.canonical_url,
    t.embed_url,
    t.track_key,
    t.title,
    t.artist,
    t.image_url,
    t.play_count,
    t.created_at,
    (
      SELECT COUNT(*)
      FROM likes l
      WHERE l.track_id = t.id
    ) AS like_count,
    EXISTS(
      SELECT 1
      FROM likes l
      WHERE l.track_id = t.id
        AND l.anonymous_client_id = ?
    ) AS liked
  FROM tracks t
  WHERE t.id = ?
`);

const selectTrackByKeyStatement = db.prepare(`
  SELECT
    t.id,
    t.source_url,
    t.canonical_url,
    t.embed_url,
    t.track_key,
    t.title,
    t.artist,
    t.image_url,
    t.play_count,
    t.created_at,
    (
      SELECT COUNT(*)
      FROM likes l
      WHERE l.track_id = t.id
    ) AS like_count,
    EXISTS(
      SELECT 1
      FROM likes l
      WHERE l.track_id = t.id
        AND l.anonymous_client_id = ?
    ) AS liked
  FROM tracks t
  WHERE t.track_key = ?
`);

const insertTrackStatement = db.prepare(`
  INSERT OR IGNORE INTO tracks (
    source_url,
    canonical_url,
    embed_url,
    track_key,
    title,
    artist,
    image_url,
    created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertLikeStatement = db.prepare(`
  INSERT OR IGNORE INTO likes (
    track_id,
    anonymous_client_id,
    created_at
  ) VALUES (?, ?, ?)
`);

const deleteLikeStatement = db.prepare(`
  DELETE FROM likes
  WHERE track_id = ?
    AND anonymous_client_id = ?
`);

const incrementPlayCountStatement = db.prepare(`
  UPDATE tracks
  SET play_count = play_count + 1
  WHERE id = ?
`);

const deleteExpiredTracksStatement = db.prepare(`
  DELETE FROM tracks
  WHERE created_at < ?
`);

const deleteAllTracksStatement = db.prepare(`
  DELETE FROM tracks
`);

const deleteAllAbuseEventsStatement = db.prepare(`
  DELETE FROM abuse_events
`);

const deleteAllAbuseBlocksStatement = db.prepare(`
  DELETE FROM abuse_blocks
`);

const selectTrackCountStatement = db.prepare(`
  SELECT COUNT(*) AS count
  FROM tracks
`);

const insertAbuseEventStatement = db.prepare(`
  INSERT INTO abuse_events (
    subject_type,
    subject_key,
    event_type,
    created_at
  ) VALUES (?, ?, ?, ?)
`);

const countRecentAbuseEventsStatement = db.prepare(`
  SELECT COUNT(*) AS count
  FROM abuse_events
  WHERE subject_type = ?
    AND subject_key = ?
    AND event_type = ?
    AND created_at >= ?
`);

const selectLatestAbuseEventStatement = db.prepare(`
  SELECT created_at
  FROM abuse_events
  WHERE subject_type = ?
    AND subject_key = ?
    AND event_type = ?
  ORDER BY created_at DESC
  LIMIT 1
`);

const selectOldestRecentAbuseEventStatement = db.prepare(`
  SELECT created_at
  FROM abuse_events
  WHERE subject_type = ?
    AND subject_key = ?
    AND event_type = ?
    AND created_at >= ?
  ORDER BY created_at ASC
  LIMIT 1
`);

const selectActiveAbuseBlockStatement = db.prepare(`
  SELECT reason, blocked_until
  FROM abuse_blocks
  WHERE subject_type = ?
    AND subject_key = ?
    AND blocked_until > ?
  ORDER BY blocked_until DESC
  LIMIT 1
`);

const insertAbuseBlockStatement = db.prepare(`
  INSERT INTO abuse_blocks (
    subject_type,
    subject_key,
    reason,
    blocked_until,
    created_at
  ) VALUES (?, ?, ?, ?, ?)
`);

const deleteExpiredAbuseEventsStatement = db.prepare(`
  DELETE FROM abuse_events
  WHERE created_at < ?
`);

const deleteExpiredAbuseBlocksStatement = db.prepare(`
  DELETE FROM abuse_blocks
  WHERE blocked_until <= ?
`);

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);

  try {
    pruneExpiredTracks();
    pruneExpiredAbuseData();

    if (request.method === "GET" && requestUrl.pathname === "/api/timeline") {
      await handleTimeline(request, response);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/resolve") {
      await handleResolve(requestUrl, response);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/tracks") {
      await handleTrackCreate(request, response);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname.match(/^\/api\/tracks\/\d+\/play$/)) {
      await handlePlayCountUpdate(request, requestUrl, response);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname.match(/^\/api\/tracks\/\d+\/like$/)) {
      await handleLikeUpdate(request, requestUrl, response);
      return;
    }

    if (ADMIN_PURGE_PATH && requestUrl.pathname === ADMIN_PURGE_PATH) {
      await handleAdminPurge(request, requestUrl, response);
      return;
    }

    await handleStatic(requestUrl.pathname, response);
  } catch (error) {
    console.error("Request failed", error);
    sendJson(response, 500, {
      message: "Internal server error",
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`SUNO Timeline server running on ${HOST}:${PORT}`);
  console.log(`Local access: http://127.0.0.1:${PORT}`);

  if (ADMIN_PURGE_PATH) {
    console.log(`Admin purge page: http://127.0.0.1:${PORT}${ADMIN_PURGE_PATH}`);
  } else {
    console.log("Admin purge page is disabled. Set ADMIN_PURGE_KEY to enable it.");
  }
});

async function handleTimeline(request, response) {
  const anonymousClientId = readAnonymousClientId(request);
  const rows = selectTimelineStatement.all(anonymousClientId);

  sendJson(response, 200, {
    tracks: rows.map(serializeTrackRow),
  });
}

async function handleResolve(requestUrl, response) {
  const sourceUrl = requestUrl.searchParams.get("url")?.trim();

  if (!sourceUrl) {
    sendJson(response, 400, {
      message: "Missing url query parameter",
    });
    return;
  }

  const validation = validateSunoUrl(sourceUrl);

  if (!validation.ok) {
    sendJson(response, 400, {
      message: validation.message,
    });
    return;
  }

  try {
    const resolved = await resolveTrack(validation.sourceUrl);
    sendJson(response, 200, resolved);
  } catch (error) {
    console.error("Track resolve failed", error);
    sendJson(response, 502, {
      message: "Failed to resolve Suno track",
    });
  }
}

async function handleTrackCreate(request, response) {
  const anonymousClientId = requireAnonymousClientId(request, response);

  if (!anonymousClientId) {
    return;
  }

  const moderationContext = createModerationContext(request, anonymousClientId);
  const now = new Date();
  const activeBlock = findActiveBlock(moderationContext.subjects, now);

  if (activeBlock) {
    sendModerationError(response, activeBlock);
    return;
  }

  const payload = await readJsonBody(request, response);

  if (!payload) {
    return;
  }

  const validation = validateSunoUrl(payload.sourceUrl);

  if (!validation.ok) {
    const invalidUrlBlock = recordInvalidUrlFailure(moderationContext.subjects, now);

    if (invalidUrlBlock) {
      sendModerationError(response, invalidUrlBlock);
      return;
    }

    sendJson(response, 400, {
      message: validation.message,
    });
    return;
  }

  const postLimitResult = evaluatePostRateLimit(moderationContext.subjects, now);

  if (!postLimitResult.ok) {
    sendModerationError(response, postLimitResult);
    return;
  }

  try {
    const resolved = await resolveTrack(validation.sourceUrl);
    const createdAt = now.toISOString();

    recordPostAttempt(moderationContext.subjects, createdAt);

    const insertResult = insertTrackStatement.run(
      validation.sourceUrl,
      resolved.sourceUrl,
      resolved.embedUrl,
      resolved.trackKey,
      resolved.title,
      resolved.artist,
      resolved.imageUrl,
      createdAt
    );
    const row = selectTrackByKeyStatement.get(anonymousClientId, resolved.trackKey);

    sendJson(response, 200, {
      wasCreated: insertResult.changes > 0,
      track: serializeTrackRow(row),
    });
  } catch (error) {
    console.error("Track create failed", error);
    sendJson(response, 502, {
      message: "Suno\u30ea\u30f3\u30af\u306e\u89e3\u6c7a\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002",
    });
  }
}

async function handleLikeUpdate(request, requestUrl, response) {
  const anonymousClientId = requireAnonymousClientId(request, response);

  if (!anonymousClientId) {
    return;
  }

  const payload = await readJsonBody(request, response);

  if (!payload || typeof payload.liked !== "boolean") {
    sendJson(response, 400, {
      message: "Invalid like payload",
    });
    return;
  }

  const trackId = Number(requestUrl.pathname.match(/^\/api\/tracks\/(\d+)\/like$/)?.[1] || 0);

  if (!Number.isInteger(trackId) || trackId <= 0) {
    sendJson(response, 400, {
      message: "Invalid track id",
    });
    return;
  }

  const existing = selectTrackByIdStatement.get(anonymousClientId, trackId);

  if (!existing) {
    sendJson(response, 404, {
      message: "Track not found",
    });
    return;
  }

  if (payload.liked) {
    insertLikeStatement.run(trackId, anonymousClientId, new Date().toISOString());
  } else {
    deleteLikeStatement.run(trackId, anonymousClientId);
  }

  const updated = selectTrackByIdStatement.get(anonymousClientId, trackId);

  sendJson(response, 200, {
    track: serializeTrackRow(updated),
  });
}

async function handlePlayCountUpdate(request, requestUrl, response) {
  const anonymousClientId = requireAnonymousClientId(request, response);

  if (!anonymousClientId) {
    return;
  }

  const trackId = Number(requestUrl.pathname.match(/^\/api\/tracks\/(\d+)\/play$/)?.[1] || 0);

  if (!Number.isInteger(trackId) || trackId <= 0) {
    sendJson(response, 400, {
      message: "Invalid track id",
    });
    return;
  }

  const existing = selectTrackByIdStatement.get(anonymousClientId, trackId);

  if (!existing) {
    sendJson(response, 404, {
      message: "Track not found",
    });
    return;
  }

  incrementPlayCountStatement.run(trackId);

  const updated = selectTrackByIdStatement.get(anonymousClientId, trackId);

  sendJson(response, 200, {
    track: serializeTrackRow(updated),
  });
}

async function handleAdminPurge(request, requestUrl, response) {
  if (request.method === "GET") {
    sendAdminPage(response, {
      trackCount: readTrackCount(),
      didPurge: requestUrl.searchParams.get("done") === "1",
    });
    return;
  }

  if (request.method === "POST") {
    purgeAllTimelineData();
    response.writeHead(303, {
      "Cache-Control": "no-store",
      Location: `${ADMIN_PURGE_PATH}?done=1`,
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    });
    response.end();
    return;
  }

  sendPlain(response, 405, "Method not allowed");
}

async function handleStatic(pathname, response) {
  const filePath = pathname === "/" ? "/index.html" : pathname;
  const absolutePath = resolve(ROOT_DIR, `.${filePath}`);
  const isRootPublicFile = PUBLIC_FILES.has(filePath);
  const isAssetFile = filePath.startsWith("/assets/") && isPathInside(absolutePath, ASSETS_DIR);

  if (!isRootPublicFile && !isAssetFile) {
    sendPlain(response, 404, "Not found");
    return;
  }

  try {
    const body = await readFile(absolutePath);
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": getMimeType(filePath),
    });
    response.end(body);
  } catch (error) {
    sendPlain(response, 404, "Not found");
  }
}

async function resolveTrack(sourceUrl) {
  const directTrackKey = extractTrackKey(sourceUrl);

  if (directTrackKey && isUuid(directTrackKey)) {
    const metadata = await fetchTrackMetadata(buildSongUrl(directTrackKey));
    return {
      sourceUrl: buildSongUrl(directTrackKey),
      embedUrl: buildEmbedUrl(directTrackKey),
      trackKey: directTrackKey,
      title: metadata.title,
      artist: metadata.artist,
      imageUrl: metadata.imageUrl,
    };
  }

  const redirectResponse = await fetch(sourceUrl, {
    redirect: "follow",
  });
  const redirectedTrackKey = extractTrackKey(redirectResponse.url);

  if (redirectedTrackKey && isUuid(redirectedTrackKey)) {
    const metadata = await fetchTrackMetadata(buildSongUrl(redirectedTrackKey));
    return {
      sourceUrl: buildSongUrl(redirectedTrackKey),
      embedUrl: buildEmbedUrl(redirectedTrackKey),
      trackKey: redirectedTrackKey,
      title: metadata.title,
      artist: metadata.artist,
      imageUrl: metadata.imageUrl,
    };
  }

  const response = await fetch(`${OEMBED_ENDPOINT}${encodeURIComponent(sourceUrl)}`, {
    headers: {
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`oEmbed request failed with status ${response.status}`);
  }

  const data = await response.json();
  const iframeUrl = extractIframeUrl(data);
  const resolvedTrackKey = extractTrackKey(iframeUrl);

  if (!iframeUrl || !resolvedTrackKey || !isUuid(resolvedTrackKey)) {
    throw new Error("Could not extract a valid embed URL");
  }

  const metadata = await fetchTrackMetadata(buildSongUrl(resolvedTrackKey));

  return {
    sourceUrl: buildSongUrl(resolvedTrackKey),
    embedUrl: iframeUrl,
    trackKey: resolvedTrackKey,
    title: metadata.title,
    artist: metadata.artist,
    imageUrl: metadata.imageUrl,
  };
}

function requireAnonymousClientId(request, response) {
  const anonymousClientId = readAnonymousClientId(request);

  if (anonymousClientId) {
    return anonymousClientId;
  }

  sendJson(response, 400, {
    message: "Invalid anonymous client id",
  });
  return "";
}

function readAnonymousClientId(request) {
  const value = String(request.headers["x-anonymous-client-id"] || "").trim();
  return ANONYMOUS_CLIENT_ID_PATTERN.test(value) ? value : "";
}

async function readJsonBody(request, response) {
  try {
    const chunks = [];
    let totalBytes = 0;

    for await (const chunk of request) {
      totalBytes += chunk.length;

      if (totalBytes > MAX_JSON_BODY_BYTES) {
        sendJson(response, 413, {
          message: "Request body is too large",
        });
        return null;
      }

      chunks.push(chunk);
    }

    if (chunks.length === 0) {
      return {};
    }

    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      sendJson(response, 400, {
        message: "Invalid JSON body",
      });
      return null;
    }

    return parsed;
  } catch (error) {
    sendJson(response, 400, {
      message: "Invalid JSON body",
    });
    return null;
  }
}

function validateSunoUrl(value) {
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

  let url;

  try {
    url = new URL(trimmedValue);
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

function serializeTrackRow(row) {
  return {
    id: row.id,
    sourceUrl: row.source_url,
    canonicalUrl: row.canonical_url,
    embedUrl: row.embed_url,
    trackKey: row.track_key,
    title: row.title,
    artist: row.artist,
    imageUrl: row.image_url,
    playCount: Number(row.play_count || 0),
    createdAt: row.created_at,
    likeCount: Number(row.like_count || 0),
    liked: Boolean(row.liked),
  };
}

function extractTrackKey(value) {
  if (!value) {
    return "";
  }

  const uuidMatch = String(value).match(ID_PATTERN);
  return uuidMatch ? uuidMatch[0] : "";
}

function extractIframeUrl(data) {
  if (typeof data?.iframe_url === "string" && data.iframe_url) {
    return data.iframe_url;
  }

  if (typeof data?.html !== "string") {
    return "";
  }

  const srcMatch = data.html.match(/src=['"]([^'"]+)['"]/i);
  return srcMatch ? srcMatch[1] : "";
}

function isUuid(value) {
  return ID_PATTERN.test(value);
}

function buildSongUrl(trackKey) {
  return `https://suno.com/song/${encodeURIComponent(trackKey)}`;
}

function buildEmbedUrl(trackKey) {
  return `https://suno.com/embed/${encodeURIComponent(trackKey)}`;
}

function pruneExpiredTracks() {
  const cutoff = new Date(Date.now() - TRACK_LIFETIME_MS).toISOString();
  deleteExpiredTracksStatement.run(cutoff);
}

function pruneExpiredAbuseData() {
  const now = new Date();
  const retentionCutoff = new Date(now.getTime() - ABUSE_EVENT_RETENTION_MS).toISOString();
  const nowIso = now.toISOString();
  deleteExpiredAbuseEventsStatement.run(retentionCutoff);
  deleteExpiredAbuseBlocksStatement.run(nowIso);
}

function purgeAllTimelineData() {
  db.exec("BEGIN IMMEDIATE");

  try {
    deleteAllTracksStatement.run();
    deleteAllAbuseEventsStatement.run();
    deleteAllAbuseBlocksStatement.run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function readTrackCount() {
  return Number(selectTrackCountStatement.get()?.count || 0);
}

function ensureTracksColumn(columnName, columnDefinition) {
  const columns = db.prepare("PRAGMA table_info(tracks)").all();
  const exists = columns.some((column) => column.name === columnName);

  if (!exists) {
    db.exec(`ALTER TABLE tracks ADD COLUMN ${columnName} ${columnDefinition}`);
  }
}

async function fetchTrackMetadata(canonicalUrl) {
  const response = await fetch(canonicalUrl, {
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Metadata request failed with status ${response.status}`);
  }

  const html = await response.text();
  const titleTag = extractMeta(html, /<title>([^<]+)<\/title>/i);
  const ogTitle = extractMeta(html, /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
  const description = extractMeta(html, /<meta[^>]+name="description"[^>]+content="([^"]+)"/i);
  const imageUrl = extractMeta(html, /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);

  return {
    title: ogTitle || parseTitleFromTitleTag(titleTag),
    artist: parseArtist(titleTag, description),
    imageUrl,
  };
}

function extractMeta(html, pattern) {
  return html.match(pattern)?.[1] || "";
}

function parseTitleFromTitleTag(titleTag) {
  const match = titleTag.match(/^(.*?)\s+by\s+.*?\s+\|\s+Suno$/i);
  return match ? decodeHtml(match[1].trim()) : decodeHtml(titleTag.replace(/\s+\|\s+Suno$/i, "").trim());
}

function parseArtist(titleTag, description) {
  const titleMatch = titleTag.match(/^.*?\s+by\s+(.*?)\s+\|\s+Suno$/i);

  if (titleMatch) {
    return decodeHtml(titleMatch[1].trim());
  }

  const descriptionMatch = description.match(/^.*?\s+by\s+(.*?)\s+\(@/i);
  return descriptionMatch ? decodeHtml(descriptionMatch[1].trim()) : "";
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function isPathInside(targetPath, parentPath) {
  return targetPath === parentPath || targetPath.startsWith(`${parentPath}${sep}`);
}

function createModerationContext(request, anonymousClientId) {
  const ipAddress = getRequestIpAddress(request);
  const subjects = [];

  if (ipAddress) {
    subjects.push({
      type: "ip",
      key: hashAbuseSubject(`ip:${ipAddress}`),
    });
  }

  if (anonymousClientId) {
    subjects.push({
      type: "client",
      key: hashAbuseSubject(`client:${anonymousClientId}`),
    });
  }

  return {
    subjects,
  };
}

function getRequestIpAddress(request) {
  if (TRUST_PROXY) {
    const forwardedFor = String(request.headers["x-forwarded-for"] || "")
      .split(",")[0]
      ?.trim();

    if (forwardedFor) {
      return forwardedFor;
    }

    const realIp = String(request.headers["x-real-ip"] || "").trim();

    if (realIp) {
      return realIp;
    }
  }

  return String(request.socket?.remoteAddress || "").trim();
}

function hashAbuseSubject(value) {
  return createHash("sha256")
    .update(ABUSE_HASH_SECRET)
    .update("\0")
    .update(value)
    .digest("hex");
}

function findActiveBlock(subjects, now) {
  const nowIso = now.toISOString();
  let strongestBlock = null;

  for (const subject of subjects) {
    const row = selectActiveAbuseBlockStatement.get(subject.type, subject.key, nowIso);

    if (!row) {
      continue;
    }

    const retryAfterSeconds = toRetryAfterSeconds(now, row.blocked_until);

    if (!strongestBlock || retryAfterSeconds > strongestBlock.retryAfterSeconds) {
      strongestBlock = buildModerationResult(row.reason, row.blocked_until, retryAfterSeconds);
    }
  }

  return strongestBlock;
}

function recordInvalidUrlFailure(subjects, now) {
  const nowIso = now.toISOString();
  const invalidWindowStart = new Date(now.getTime() - INVALID_URL_WINDOW_MS).toISOString();
  let newestBlock = null;

  for (const subject of subjects) {
    insertAbuseEventStatement.run(subject.type, subject.key, "invalid_url", nowIso);
    const recentCount =
      Number(
        countRecentAbuseEventsStatement.get(
          subject.type,
          subject.key,
          "invalid_url",
          invalidWindowStart
        )?.count || 0
      );

    if (recentCount < INVALID_URL_LIMIT) {
      continue;
    }

    const blockedUntil = new Date(now.getTime() + INVALID_URL_BLOCK_MS).toISOString();
    insertAbuseBlockStatement.run(
      subject.type,
      subject.key,
      "invalid_url_spam",
      blockedUntil,
      nowIso
    );

    const block = buildModerationResult(
      "invalid_url_spam",
      blockedUntil,
      toRetryAfterSeconds(now, blockedUntil)
    );

    if (!newestBlock || block.retryAfterSeconds > newestBlock.retryAfterSeconds) {
      newestBlock = block;
    }
  }

  return newestBlock;
}

function evaluatePostRateLimit(subjects, now) {
  const postWindowStart = new Date(now.getTime() - POST_WINDOW_MS).toISOString();
  let strongestResult = { ok: true };

  for (const subject of subjects) {
    const latestEvent = selectLatestAbuseEventStatement.get(subject.type, subject.key, "post");

    if (latestEvent?.created_at) {
      const retryAfterMs = new Date(latestEvent.created_at).getTime() + POST_COOLDOWN_MS - now.getTime();

      if (retryAfterMs > 0) {
        const result = buildModerationResult(
          "post_cooldown",
          new Date(now.getTime() + retryAfterMs).toISOString(),
          Math.ceil(retryAfterMs / 1000)
        );

        if (!strongestResult.retryAfterSeconds || result.retryAfterSeconds > strongestResult.retryAfterSeconds) {
          strongestResult = result;
        }
      }
    }

    const recentCount =
      Number(
        countRecentAbuseEventsStatement.get(subject.type, subject.key, "post", postWindowStart)?.count || 0
      );

    if (recentCount < POST_WINDOW_LIMIT) {
      continue;
    }

    const oldestRecentEvent = selectOldestRecentAbuseEventStatement.get(
      subject.type,
      subject.key,
      "post",
      postWindowStart
    );

    if (!oldestRecentEvent?.created_at) {
      continue;
    }

    const retryAfterMs =
      new Date(oldestRecentEvent.created_at).getTime() + POST_WINDOW_MS - now.getTime();

    if (retryAfterMs <= 0) {
      continue;
    }

    const result = buildModerationResult(
      "post_hourly_limit",
      new Date(now.getTime() + retryAfterMs).toISOString(),
      Math.ceil(retryAfterMs / 1000)
    );

    if (!strongestResult.retryAfterSeconds || result.retryAfterSeconds > strongestResult.retryAfterSeconds) {
      strongestResult = result;
    }
  }

  return strongestResult;
}

function recordPostAttempt(subjects, createdAt) {
  for (const subject of subjects) {
    insertAbuseEventStatement.run(subject.type, subject.key, "post", createdAt);
  }
}

function buildModerationResult(reason, blockedUntil, retryAfterSeconds) {
  return {
    ok: false,
    reason,
    blockedUntil,
    retryAfterSeconds: Math.max(1, retryAfterSeconds || 1),
    message: buildModerationMessage(reason, retryAfterSeconds),
  };
}

function buildModerationMessage(reason, retryAfterSeconds) {
  if (reason === "invalid_url_spam") {
    return `無効なURLの送信が続いたため、${formatRetryAfter(retryAfterSeconds)}後にもう一度お試しください。`;
  }

  if (reason === "post_hourly_limit") {
    return `短時間に投稿が集中しています。${formatRetryAfter(retryAfterSeconds)}後にもう一度お試しください。`;
  }

  return `連続投稿は${formatRetryAfter(Math.ceil(POST_COOLDOWN_MS / 1000))}ごとにお願いします。${formatRetryAfter(retryAfterSeconds)}後にもう一度お試しください。`;
}

function formatRetryAfter(retryAfterSeconds) {
  if (retryAfterSeconds >= 60) {
    const minutes = Math.ceil(retryAfterSeconds / 60);
    return `${minutes}分`;
  }

  return `${retryAfterSeconds}秒`;
}

function toRetryAfterSeconds(now, blockedUntil) {
  return Math.max(1, Math.ceil((new Date(blockedUntil).getTime() - now.getTime()) / 1000));
}

function sendModerationError(response, moderationResult) {
  sendJson(
    response,
    429,
    {
      message: moderationResult.message,
      blockedUntil: moderationResult.blockedUntil,
      retryAfterSeconds: moderationResult.retryAfterSeconds,
      reason: moderationResult.reason,
    },
    {
      "Retry-After": String(moderationResult.retryAfterSeconds),
    }
  );
}

function sendAdminPage(response, { trackCount, didPurge }) {
  const body = `<!DOCTYPE html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex,nofollow,noarchive" />
    <title>SUNO Timeline Admin</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7f4ef;
        --panel: rgba(255, 255, 255, 0.92);
        --line: rgba(25, 33, 38, 0.12);
        --text: #17191d;
        --soft: rgba(23, 25, 29, 0.65);
        --accent: #a66a47;
        --danger: #1d2024;
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        background:
          radial-gradient(circle at top left, rgba(255, 255, 255, 0.88), transparent 34%),
          linear-gradient(180deg, #fcfbf9 0%, var(--bg) 46%, #f2eeea 100%);
        color: var(--text);
        font-family: "Avenir Next", "Yu Gothic", "Hiragino Sans", sans-serif;
      }

      main {
        width: min(560px, 100%);
        padding: 28px;
        border: 1px solid rgba(255, 255, 255, 0.82);
        border-radius: 28px;
        background: var(--panel);
        box-shadow: 0 24px 60px rgba(17, 24, 28, 0.1);
        backdrop-filter: blur(18px);
      }

      p {
        margin: 0;
        line-height: 1.7;
      }

      .eyebrow {
        color: var(--soft);
        letter-spacing: 0.14em;
        text-transform: uppercase;
        font-size: 0.74rem;
      }

      h1 {
        margin: 10px 0 12px;
        font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
        font-size: clamp(2rem, 5vw, 2.8rem);
        letter-spacing: -0.04em;
      }

      .meta {
        margin-top: 14px;
        color: var(--soft);
      }

      .status {
        margin-top: 18px;
        padding: 14px 16px;
        border: 1px solid rgba(166, 106, 71, 0.18);
        border-radius: 18px;
        background: rgba(255, 249, 244, 0.92);
        color: var(--accent);
      }

      form {
        margin-top: 24px;
      }

      button {
        width: 100%;
        padding: 16px 20px;
        border: 0;
        border-radius: 999px;
        background: linear-gradient(180deg, #1d2024 0%, #121417 100%);
        color: #f8f5f1;
        font: inherit;
        cursor: pointer;
        box-shadow: 0 16px 30px rgba(17, 24, 28, 0.18);
      }

      button:hover {
        transform: translateY(-1px);
      }

      .note {
        margin-top: 14px;
        color: var(--soft);
        font-size: 0.92rem;
      }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">Private Admin</p>
      <h1>タイムライン初期化</h1>
      <p>このページから、現在タイムラインに残っている全曲と関連データをまとめて削除できます。</p>
      <p class="meta">現在の曲数: ${trackCount}曲</p>
      ${didPurge ? '<p class="status">タイムラインを初期化しました。</p>' : ""}
      <form method="post" onsubmit="return window.confirm('タイムラインを初期化します。全曲削除してもよいですか？');">
        <button type="submit">全曲削除する</button>
      </form>
      <p class="note">このURLを知っている人だけが操作できます。公開先では必ず長い秘密文字列を使ってください。</p>
    </main>
  </body>
</html>`;

  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "text/html; charset=utf-8",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  });
  response.end(body);
}

function getMimeType(filePath) {
  switch (extname(filePath)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    default:
      return "text/plain; charset=utf-8";
  }
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}

function sendPlain(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end(body);
}
