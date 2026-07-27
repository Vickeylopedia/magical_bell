/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  Audius Feed Bot — Live Telegram Streaming, Controls & Interactive Menu
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Features & Capabilities:
 *    • Telegram Command Menu: Auto-registers bot commands via setMyCommands & reply_markup keyboard
 *    • Interactive Control Polling: Listens for /start_bot, /stop_bot, /status from Chat ID 5876482404
 *    • Live Terminal Streaming: Real-time CMD-style HTML logs streamed to Telegram
 *    • Persistent Sessions: Preserves Chromium login profile in audius_session_profile/
 *    • Session Bloat Prevention: Low disk cache limits, CDP cache flushing, page cache disabled
 *    • Engagement Threshold Guardrails: Skips popular tracks (>= 10 Likes OR >= 10 Reposts)
 *    • Human-like Delays: Random delays (400-900ms) between actions
 *    • Error Resilient: Resilient try/catch wrappers keep main loop running continuously
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Resolve __dirname in ESM ──────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── Configuration ─────────────────────────────────────────────────────────
const CONFIG = Object.freeze({
  /** Embedded Credentials for Telegram Telemetry & Controls */
  TELEGRAM_BOT_TOKEN: '8642974069:AAFlbCRWUn3IUwoSicQogakNxcF_5UptgkM',
  TELEGRAM_CHAT_ID:   '5876482404',

  /** Persistent Chromium profile so auth tokens survive restarts */
  USER_DATA_DIR:     path.join(__dirname, 'audius_session_profile'),

  /** File that caches processed tracks to avoid duplicates */
  CACHE_FILE:        path.join(__dirname, 'cache.json'),

  /** Target Feed URL */
  FEED_URL:          'https://audius.co/feed',

  /** Main loop interval (ms) — 15 seconds */
  REFRESH_INTERVAL:  15_000,

  /** Navigation & selector timeouts */
  NAV_TIMEOUT:       60_000,
  SELECTOR_TIMEOUT:  10_000,

  /** Maximum time (ms) to wait for manual user login */
  LOGIN_WAIT_TIMEOUT: 600_000, // 10 minutes

  /** Max retries for network navigation */
  MAX_RETRIES:       3,
  RETRY_BASE_DELAY:  2_000,

  /** SPA hydration delay (5 seconds) */
  SPA_HYDRATION_WAIT: 5_000,

  /** Fixed Viewport Dimensions */
  VIEWPORT:          { width: 1440, height: 900 },

  /** Standard Desktop User-Agent */
  USER_AGENT:        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',

  /** Engagement Threshold Guardrails */
  MAX_LIKES_THRESHOLD:   10,
  MAX_REPOSTS_THRESHOLD: 10,
});

// ─── Bot Global State ──────────────────────────────────────────────────────
let isBotActive = true;
let lastUpdateId = 0;
const startTime = Date.now();

// ─── System Uptime Helper ──────────────────────────────────────────────────
function getUptime() {
  const totalSeconds = Math.floor((Date.now() - startTime) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

// ─── Logging Helpers ───────────────────────────────────────────────────────
const timestamp = () => new Date().toLocaleTimeString('en-GB', { hour12: false });

const log = {
  info:  (msg) => console.log(`  [${timestamp()}]  ℹ️  ${msg}`),
  ok:    (msg) => console.log(`  [${timestamp()}]  ✅  ${msg}`),
  warn:  (msg) => console.log(`  [${timestamp()}]  ⚠️  ${msg}`),
  error: (msg) => console.error(`  [${timestamp()}]  ❌  ${msg}`),
  idle:  (msg) => console.log(`  [${timestamp()}]  💤  ${msg}`),
  bot:   (msg) => console.log(`  [${timestamp()}]  🤖  ${msg}`),
};

// ─── Telegram Telemetry, Menu Registration & Live Streaming ────────────────

/**
 * Auto-register Telegram Bot command menu (/start_bot, /stop_bot, /status).
 */
async function registerTelegramMenu() {
  const token = CONFIG.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  const url = `https://api.telegram.org/bot${token}/setMyCommands`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands: [
          { command: 'start_bot', description: '▶️ Resume feed monitoring' },
          { command: 'stop_bot', description: '⏸️ Pause feed monitoring' },
          { command: 'status', description: '📊 View live bot state & metrics' },
        ],
      }),
    });

    if (res.ok) {
      log.ok('Telegram command menu registered successfully.');
    }
  } catch (err) {
    log.warn(`Failed to register Telegram bot command menu: ${err.message}`);
  }
}

/**
 * Send a standard HTML alert to Telegram (link preview disabled).
 * Used for status messages, standby notices, errors, and skipped alerts.
 */
async function sendTelegramAlert(htmlText, includeMenuKeyboard = false) {
  const token = CONFIG.TELEGRAM_BOT_TOKEN;
  const chatId = CONFIG.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  const payload = {
    chat_id: chatId,
    text: htmlText,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };

  if (includeMenuKeyboard) {
    payload.reply_markup = {
      keyboard: [
        [{ text: '/start_bot' }, { text: '/stop_bot' }],
        [{ text: '/status' }],
      ],
      resize_keyboard: true,
      persistent: true,
    };
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      log.warn(`Telegram API warning (${res.status}): ${errBody}`);
    }
  } catch (err) {
    log.error(`Failed to dispatch Telegram alert: ${err.message}`);
  }
}

/**
 * Send a rich track card to Telegram with link preview ENABLED.
 * Telegram will automatically render the embedded Audius music player card.
 */
async function sendTrackCard(htmlText, includeMenuKeyboard = false) {
  const token = CONFIG.TELEGRAM_BOT_TOKEN;
  const chatId = CONFIG.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  const payload = {
    chat_id: chatId,
    text: htmlText,
    parse_mode: 'HTML',
    disable_web_page_preview: false,  // Enable Telegram link preview for rich Audius card
  };

  if (includeMenuKeyboard) {
    payload.reply_markup = {
      keyboard: [
        [{ text: '/start_bot' }, { text: '/stop_bot' }],
        [{ text: '/status' }],
      ],
      resize_keyboard: true,
      persistent: true,
    };
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      log.warn(`Telegram API warning (${res.status}): ${errBody}`);
    }
  } catch (err) {
    log.error(`Failed to dispatch Telegram track card: ${err.message}`);
  }
}

// ─── Interactive Telegram Command Polling Loop ─────────────────────────────

/**
 * Poll Telegram API for incoming commands (/start_bot, /stop_bot, /status).
 */
async function pollTelegramUpdates(processedTrackIdsSet) {
  const token = CONFIG.TELEGRAM_BOT_TOKEN;
  const targetChatId = String(CONFIG.TELEGRAM_CHAT_ID);
  if (!token || !targetChatId) return;

  const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${lastUpdateId + 1}&timeout=3`;

  try {
    const res = await fetch(url);
    if (!res.ok) return;

    const data = await res.json();
    if (!data.ok || !Array.isArray(data.result)) return;

    for (const update of data.result) {
      lastUpdateId = Math.max(lastUpdateId, update.update_id);

      const message = update.message || update.edited_message;
      if (!message || !message.text) continue;

      const chatId = String(message.chat?.id || '');
      if (chatId !== targetChatId) continue;

      const text = message.text.trim();

      if (text.startsWith('/start_bot')) {
        isBotActive = true;
        log.ok('Received Telegram command: /start_bot');
        await sendTelegramAlert('▶️ <b>Audius Bot Resumed</b> — Monitoring feed every 15 seconds.', true);
      } else if (text.startsWith('/stop_bot')) {
        isBotActive = false;
        log.warn('Received Telegram command: /stop_bot');
        await sendTelegramAlert('⏸️ <b>Audius Bot Paused</b> — Feed monitoring is currently on hold.', true);
      } else if (text.startsWith('/status')) {
        log.info('Received Telegram command: /status');
        const stateStr = isBotActive ? '🟢 Active' : '🔴 Paused';
        const count = processedTrackIdsSet ? processedTrackIdsSet.size : 0;
        const statusMsg = `📊 <b>Audius Bot Status</b>\n\n<b>State:</b> ${stateStr}\n<b>Processed Tracks:</b> ${count} items\n<b>Uptime:</b> ${getUptime()}`;
        await sendTelegramAlert(statusMsg, true);
      }
    }
  } catch {
    // Non-fatal network polling error — ignore and retry next cycle
  }
}

/**
 * Start non-blocking background polling interval for Telegram commands.
 */
function startTelegramPoller(processedTrackIdsSet) {
  setInterval(async () => {
    await pollTelegramUpdates(processedTrackIdsSet);
  }, 3000);
}

// ─── Cache Management ─────────────────────────────────────────────────────

function loadCache() {
  try {
    if (fs.existsSync(CONFIG.CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG.CACHE_FILE, 'utf-8'));
      if (Array.isArray(data.processedTrackIds)) {
        return new Set(data.processedTrackIds);
      }
      if (data.lastProcessedTrackId) {
        return new Set([data.lastProcessedTrackId]);
      }
    }
  } catch {
    log.warn('Cache file unreadable or missing — initializing fresh set.');
  }
  return new Set();
}

function saveCache(processedTrackIdsSet) {
  const processedArray = Array.from(processedTrackIdsSet);
  if (processedArray.length > 200) {
    processedArray.splice(0, processedArray.length - 200);
  }
  const payload = {
    processedTrackIds: processedArray,
    updatedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(CONFIG.CACHE_FILE, JSON.stringify(payload, null, 2), 'utf-8');
  } catch (err) {
    log.error(`Failed to save cache file: ${err.message}`);
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────

function humanDelay(min = 400, max = 900) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── CDP & Bloat Prevention Helpers ────────────────────────────────────────

async function clearCDPCache(page) {
  try {
    const client = await page.target().createCDPSession();
    await client.send('Network.clearBrowserCache');
  } catch (err) {
    log.warn(`CDP cache cleanup notice: ${err.message}`);
  }
}

// ─── Resilient Navigation Helpers ─────────────────────────────────────────

async function retryAsync(fn, label = 'operation', maxRetries = CONFIG.MAX_RETRIES) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) {
        log.error(`${label} failed after ${maxRetries} attempts: ${err.message}`);
        throw err;
      }
      const delay = CONFIG.RETRY_BASE_DELAY * attempt;
      log.warn(`${label} attempt ${attempt}/${maxRetries} failed — retrying in ${delay / 1000}s… (${err.message})`);
      await sleep(delay);
    }
  }
}

async function resilientNavigation(page, url, label = 'Navigation') {
  return retryAsync(async () => {
    await page.setCacheEnabled(false);
    await clearCDPCache(page);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.NAV_TIMEOUT });
    await sleep(CONFIG.SPA_HYDRATION_WAIT);
  }, label);
}

async function resilientReload(page, label = 'Reload') {
  return retryAsync(async () => {
    await page.setCacheEnabled(false);
    await clearCDPCache(page);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: CONFIG.NAV_TIMEOUT });
    await sleep(CONFIG.SPA_HYDRATION_WAIT);
  }, label);
}

// ─── DOM Helpers ───────────────────────────────────────────────────────────

async function safeWaitFor(page, selector, timeout = CONFIG.SELECTOR_TIMEOUT) {
  try {
    return await page.waitForSelector(selector, { visible: true, timeout });
  } catch {
    return null;
  }
}

async function findByText(page, tag, text, exact = false) {
  const xpath = exact
    ? `//${tag}[normalize-space(text())="${text}"]`
    : `//${tag}[contains(normalize-space(.), "${text}")]`;

  try {
    await page.waitForSelector(tag, { timeout: CONFIG.SELECTOR_TIMEOUT });
    const elements = await page.$$(`xpath/${xpath}`);
    return elements.length > 0 ? elements[0] : null;
  } catch {
    return null;
  }
}

// ─── Phase 1: Launch Browser & Handle Authentication ─────────────────────

async function launchBrowser() {
  log.bot('Launching Chromium browser instance…');

  const launchOptions = {
    headless: 'new',
    userDataDir: CONFIG.USER_DATA_DIR,
    defaultViewport: CONFIG.VIEWPORT,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disk-cache-size=1',
      '--media-cache-size=1',
      '--disable-application-cache',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-default-apps',
      '--no-first-run',
    ],
  };

  const customExecutable = process.env.CHROMIUM_PATH || process.env.CHROME_PATH;
  if (customExecutable && fs.existsSync(customExecutable)) {
    launchOptions.executablePath = customExecutable;
    log.info(`Using custom browser executable: ${customExecutable}`);
  }

  const browser = await puppeteer.launch(launchOptions);
  const page = (await browser.pages())[0] || await browser.newPage();

  page.setDefaultTimeout(CONFIG.SELECTOR_TIMEOUT);
  page.setDefaultNavigationTimeout(CONFIG.NAV_TIMEOUT);
  await page.setUserAgent(CONFIG.USER_AGENT);

  await page.setCacheEnabled(false);
  await clearCDPCache(page);

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  return { browser, page };
}

async function ensureAuthenticated(page) {
  log.info('Navigating to Audius feed & checking session authentication…');
  await resilientNavigation(page, CONFIG.FEED_URL, 'Auth check navigation');

  const currentUrl = page.url();
  const isOnFeed = currentUrl.includes('/feed');

  const signInBtn = await findByText(page, 'button', 'Sign In')
                 || await findByText(page, 'a', 'Sign In')
                 || await findByText(page, 'button', 'Sign Up')
                 || await findByText(page, 'a', 'Sign Up');

  if (isOnFeed && !signInBtn) {
    log.ok('Authenticated session restored successfully.');
    return;
  }

  log.warn('Authentication required. Waiting for manual login completion…');
  if (!currentUrl.includes('/signin')) {
    await resilientNavigation(page, 'https://audius.co/signin', 'Sign-in navigation');
  }

  try {
    await page.waitForFunction(
      () => window.location.pathname.includes('/feed'),
      { timeout: CONFIG.LOGIN_WAIT_TIMEOUT, polling: 2000 }
    );
  } catch {
    const errMsg = 'Login wait timed out after 10 minutes.';
    log.error(errMsg);
    await sendTelegramAlert(`❌ <b>Error Encountered:</b>\n<pre>Details: ${errMsg}</pre>`);
    process.exit(1);
  }

  await sleep(CONFIG.SPA_HYDRATION_WAIT);
  log.ok('Login detected — session cached in persistent profile.');
}

// ─── Phase 2: Feed & Filter Verification ─────────────────────────────────

async function ensureFeedPage(page) {
  const url = page.url();
  if (!url.includes('/feed')) {
    log.warn('Not on feed page — navigating back to feed…');
    await resilientNavigation(page, CONFIG.FEED_URL, 'Feed page navigation');
  }
}

async function ensureLatestFilter(page) {
  log.info('Verifying feed filter is set to "Latest"…');

  try {
    const result = await page.evaluate(() => {
      const allClickable = Array.from(document.querySelectorAll('button, a, [role="tab"]'));
      const tab = allClickable.find(el => /^(latest|following)$/i.test(el.textContent?.trim()));
      if (!tab) return 'not-found';

      const ariaSelected = tab.getAttribute('aria-selected');
      if (ariaSelected === 'true') return 'already-active';
      if (/active|selected|current/i.test(tab.className || '')) return 'already-active';
      if (tab.dataset?.active === 'true') return 'already-active';

      tab.click();
      return 'clicked';
    });

    if (result === 'clicked') {
      await sleep(1500);
      log.ok('Switched feed filter to "Latest" ✓');
    } else if (result === 'already-active') {
      log.ok('Feed filter is "Latest" ✓');
    } else {
      log.warn('Could not confirm filter tab — assuming default feed list.');
    }
  } catch (err) {
    log.error(`Filter verification error: ${err.message}`);
  }
}

// ─── Phase 3: Track Scraping & Engagement Inspection ────────────────────

/**
 * Scrape the feed for track cards, extracting permalink, title, and the
 * card container element index so stats can be scoped precisely.
 *
 * Strategy:
 *  1. Find all top-level track card containers in the feed lineup.
 *  2. Inside each card, locate the primary title link (/user/slug pattern).
 *  3. Filter out nav routes, user sub-pages, and noise text.
 *  4. Deduplicate strictly by permalink slug at card level.
 */
async function getLatestTracks(page) {
  try {
    // Wait for at least one track link to appear before scraping
    await safeWaitFor(page, 'a[href]', CONFIG.SELECTOR_TIMEOUT);

    const tracks = await page.evaluate(() => {
      // ── Ignored text patterns in title links ─────────────────────────
      const NOISE_PATTERNS = /comments?|leave a comment|repost|favorite|share|follow|upload/i;

      // ── Nav routes that are page-level paths, not user handles ────────
      const NAV_ROUTES = new Set([
        'feed', 'trending', 'explore', 'library', 'upload',
        'settings', 'signin', 'signup', 'messages', 'notifications',
        'dashboard', 'audio', 'premium', 'search', 'favorites',
        'history', 'reposts', 'playlists', 'albums', 'tracks',
      ]);

      // ── User profile sub-pages that are not track slugs ───────────────
      const SUB_PAGES = new Set([
        'tracks', 'albums', 'playlists', 'reposts', 'followers',
        'following', 'favorites', 'collectibles',
      ]);

      /**
       * Given any element, walk up DOM parents (up to 15 levels) to find
       * the nearest track card container — an element that wraps multiple
       * buttons (play, like, repost) and a track title link.
       */
      function findCardContainer(el) {
        let node = el;
        for (let i = 0; i < 15; i++) {
          node = node?.parentElement;
          if (!node) break;
          const cls = (node.className || '').toString();
          const hasManyButtons = node.querySelectorAll('button').length >= 2;
          const looksLikeCard = /tile|card|track|lineup|item|row/i.test(cls);
          if (hasManyButtons || looksLikeCard) return node;
        }
        return null;
      }

      // ── Step 1: Collect all candidate track permalink links ───────────
      const allLinks = Array.from(document.querySelectorAll('a[href]'));
      const seen = new Set();       // dedup by permalink
      const seenCards = new WeakSet(); // dedup by card DOM node
      const results = [];

      for (const link of allLinks) {
        const href = (link.getAttribute('href') || '').trim();

        // Must match /user/slug — exactly two non-empty path segments
        const segments = href.split('/').filter(Boolean);
        if (segments.length !== 2) continue;

        const [user, slug] = segments;
        if (NAV_ROUTES.has(user.toLowerCase())) continue;
        if (SUB_PAGES.has(slug.toLowerCase())) continue;

        // Skip duplicate permalinks already collected
        if (seen.has(href)) continue;

        // ── Step 2: Extract a clean title from this link ──────────────
        const rawText = (link.textContent || '').trim();

        // Reject empty, noisy, or action-button text
        if (!rawText || NOISE_PATTERNS.test(rawText)) continue;

        // The primary title link is usually short (< 120 chars)
        // Reject links that look like multi-line description blobs
        if (rawText.length > 150) continue;

        // ── Step 3: Scope deduplication to the card container ─────────
        const card = findCardContainer(link);
        if (card && seenCards.has(card)) continue;   // same card, skip
        if (card) seenCards.add(card);

        seen.add(href);

        results.push({
          trackId: href,
          title: rawText.substring(0, 120),
        });
      }

      return results;
    });

    return tracks;
  } catch (err) {
    log.error(`Track extraction failed: ${err.message}`);
    return [];
  }
}

/**
 * Inspect engagement counts (Likes & Reposts) for a given track permalink.
 *
 * Approach:
 *  1. Locate the title link by exact href.
 *  2. Walk UP the DOM to find the track card container.
 *  3. Run three extraction methods inside that container only:
 *       A. Regex scan of container innerText for "N reposts" / "N favorites".
 *       B. aria-label / title attribute inspection on interactive elements.
 *       C. SVG <title> tag association (Audius uses "Reposts" / "Favorites").
 */
async function getTrackEngagementCounts(page, trackPermalink) {
  try {
    return await page.evaluate((permalink) => {
      // ── Locate the title anchor ───────────────────────────────────────
      const link = document.querySelector(`a[href="${permalink}"]`);
      if (!link) return { likes: 0, reposts: 0 };

      // ── Walk up DOM to find the card container ────────────────────────
      let container = link.parentElement;
      for (let i = 0; i < 15; i++) {
        if (!container) break;
        const cls = (container.className || '').toString();
        const hasManyButtons = container.querySelectorAll('button').length >= 2;
        const looksLikeCard = /tile|card|track|lineup|item|row/i.test(cls);
        if (hasManyButtons || looksLikeCard) break;
        container = container.parentElement;
      }

      // Fallback: use the link's direct parent if traversal found nothing
      if (!container) container = link.parentElement;
      if (!container) return { likes: 0, reposts: 0 };

      // ── Number parser: handles "12", "1.2k", "1.5M" etc ──────────────
      const parseNumber = (text) => {
        if (!text) return 0;
        const clean = text.trim().toLowerCase().replace(/,/g, '');
        if (clean.includes('k')) {
          const val = parseFloat(clean.replace(/[^0-9.]/g, ''));
          return isNaN(val) ? 0 : Math.round(val * 1000);
        }
        if (clean.includes('m')) {
          const val = parseFloat(clean.replace(/[^0-9.]/g, ''));
          return isNaN(val) ? 0 : Math.round(val * 1_000_000);
        }
        const val = parseInt(clean.replace(/[^0-9]/g, ''), 10);
        return isNaN(val) ? 0 : val;
      };

      let likes = 0;
      let reposts = 0;

      // ── Method A: Regex over container innerText ──────────────────────
      // Audius renders counts as "12 Reposts" / "5 Favorites" in accessible text
      const containerText = container.innerText || container.textContent || '';

      const repostTextMatch = containerText.match(/(\d[\d.,]*(?:\.\d+)?[km]?)\s*repost/i);
      if (repostTextMatch) reposts = Math.max(reposts, parseNumber(repostTextMatch[1]));

      const likeTextMatch = containerText.match(/(\d[\d.,]*(?:\.\d+)?[km]?)\s*(?:favorite|like)/i);
      if (likeTextMatch) likes = Math.max(likes, parseNumber(likeTextMatch[1]));

      // ── Method B: aria-label / title attributes on interactive elements
      // e.g. aria-label="12 Reposts" or aria-label="Favorite (5)"
      const interactiveEls = Array.from(container.querySelectorAll('[aria-label], [title]'));
      for (const el of interactiveEls) {
        const aria  = (el.getAttribute('aria-label') || '').trim();
        const title = (el.getAttribute('title') || '').trim();

        for (const attr of [aria, title]) {
          if (!attr) continue;
          const attrLow = attr.toLowerCase();

          if (attrLow.includes('repost')) {
            const m = attr.match(/(\d[\d.,]*(?:\.\d+)?[km]?)/i);
            if (m) reposts = Math.max(reposts, parseNumber(m[1]));
          }
          if (attrLow.includes('favorite') || attrLow.includes('like')) {
            const m = attr.match(/(\d[\d.,]*(?:\.\d+)?[km]?)/i);
            if (m) likes = Math.max(likes, parseNumber(m[1]));
          }
        }
      }

      // ── Method C: SVG <title> associations ───────────────────────────
      // Audius embeds <title>Reposts</title> / <title>Favorites</title> in SVG icons.
      // The numeric count usually sits in the parent wrapper's text.
      const svgTitles = Array.from(container.querySelectorAll('svg title'));
      for (const titleEl of svgTitles) {
        const iconLabel = (titleEl.textContent || '').trim().toLowerCase();
        // Walk up to a wrapper that contains both the icon and the count text
        const wrapper = titleEl.parentElement?.parentElement || titleEl.parentElement;
        if (!wrapper) continue;

        const wrapText = (wrapper.innerText || wrapper.textContent || '').trim();
        const count = parseNumber(wrapText);
        if (count === 0) continue;

        if (iconLabel.includes('repost')) reposts = Math.max(reposts, count);
        if (iconLabel.includes('favorite') || iconLabel.includes('like')) likes = Math.max(likes, count);
      }

      return { likes, reposts };
    }, trackPermalink);
  } catch (err) {
    log.error(`Engagement calculation error: ${err.message}`);
    return { likes: 0, reposts: 0 };
  }
}


// ─── Phase 4: Interaction Pipeline (Play -> Like -> Repost) ───────────────

async function clickPlay(page, trackPermalink) {
  log.info('▶  Executing Play action…');
  try {
    const played = await page.evaluate((permalink) => {
      const link = document.querySelector(`a[href="${permalink}"]`);
      if (!link) return false;

      let container = link;
      for (let i = 0; i < 10; i++) {
        container = container.parentElement;
        if (!container) break;

        const playBtn = container.querySelector(
          'button[aria-label*="play" i], button[aria-label*="Play" i]'
        );
        if (playBtn) {
          playBtn.click();
          return true;
        }
      }

      container = link;
      for (let i = 0; i < 10; i++) {
        container = container.parentElement;
        if (!container) break;

        const artwork = container.querySelector(
          '[class*="artwork" i], [class*="cover" i], [class*="play" i][class*="overlay" i]'
        );
        if (artwork) {
          artwork.click();
          return true;
        }
      }
      return false;
    }, trackPermalink);

    if (played) {
      log.ok('▶  Play button triggered successfully.');
      return true;
    }
    log.warn('▶  Play button not found or click unsuccessful.');
    return false;
  } catch (err) {
    log.error(`▶  Play error: ${err.message}`);
    return false;
  }
}

async function clickLike(page, trackPermalink) {
  log.info('❤️  Executing Like action…');
  try {
    const result = await page.evaluate((permalink) => {
      const link = document.querySelector(`a[href="${permalink}"]`);
      if (!link) return 'no-link';

      let container = link;
      for (let i = 0; i < 10; i++) {
        container = container.parentElement;
        if (!container) break;

        const favBtn = container.querySelector(
          'button[aria-label*="favorite" i], button[aria-label*="Favorite" i], button[aria-label*="like" i]'
        );

        if (favBtn) {
          const label = (favBtn.getAttribute('aria-label') || '').toLowerCase();
          if (label.includes('unfavorite') || label.includes('unlike')) {
            return 'already-liked';
          }
          favBtn.click();
          return 'liked';
        }
      }

      container = link;
      for (let i = 0; i < 10; i++) {
        container = container.parentElement;
        if (!container) break;
        const heartBtn = container.querySelector('button[class*="heart" i], button[class*="like" i], button[class*="favorite" i]');
        if (heartBtn) {
          heartBtn.click();
          return 'liked';
        }
      }

      return 'not-found';
    }, trackPermalink);

    if (result === 'liked' || result === 'already-liked') {
      log.ok(`❤️  Like status: ${result}`);
      return true;
    }
    log.warn(`❤️  Like button not interacted (${result})`);
    return false;
  } catch (err) {
    log.error(`❤️  Like error: ${err.message}`);
    return false;
  }
}

async function clickRepost(page, trackPermalink) {
  log.info('🔁  Executing Repost action…');
  try {
    const result = await page.evaluate((permalink) => {
      const link = document.querySelector(`a[href="${permalink}"]`);
      if (!link) return 'no-link';

      let container = link;
      for (let i = 0; i < 10; i++) {
        container = container.parentElement;
        if (!container) break;

        const repostBtn = container.querySelector(
          'button[aria-label*="repost" i], button[aria-label*="Repost" i]'
        );

        if (repostBtn) {
          const label = (repostBtn.getAttribute('aria-label') || '').toLowerCase();
          if (label.includes('unrepost')) {
            return 'already-reposted';
          }
          repostBtn.click();
          return 'reposted';
        }
      }

      container = link;
      for (let i = 0; i < 10; i++) {
        container = container.parentElement;
        if (!container) break;
        const btn = container.querySelector('button[class*="repost" i], button[class*="share" i]');
        if (btn) {
          btn.click();
          return 'reposted';
        }
      }

      return 'not-found';
    }, trackPermalink);

    if (result === 'reposted') {
      await humanDelay(400, 800);
      const confirmBtn = await findByText(page, 'button', 'Repost');
      if (confirmBtn) {
        await confirmBtn.click();
        log.ok('🔁  Confirmed repost via modal dialog.');
      } else {
        log.ok('🔁  Repost button clicked successfully.');
      }
      return true;
    }

    if (result === 'already-reposted') {
      log.ok('🔁  Track was already reposted.');
      return true;
    }

    log.warn(`🔁  Repost button not interacted (${result})`);
    return false;
  } catch (err) {
    log.error(`🔁  Repost error: ${err.message}`);
    return false;
  }
}

/**
 * Handle new track processing with a single rich card summary sent to Telegram.
 */
async function processNewTrack(page, track, processedTrackIds) {
  log.bot(`🎵 NEW TRACK DETECTED: "${track.title}" (${track.trackId})`);

  // Step 1: Hydration delay — wait for React DOM & stats to fully render
  log.info('Waiting 5s hydration delay for DOM elements and stats to settle…');
  await sleep(CONFIG.SPA_HYDRATION_WAIT);

  // Step 2: Inspect Engagement Counts
  const stats = await getTrackEngagementCounts(page, track.trackId);
  log.info(`Track Engagement Stats — Likes: ${stats.likes}, Reposts: ${stats.reposts}`);

  // Build the full Audius track URL for the link preview card
  const trackUrl = `https://audius.co${track.trackId}`;

  // Check Engagement Guardrails (Likes >= 10 OR Reposts >= 10)
  if (stats.likes >= CONFIG.MAX_LIKES_THRESHOLD || stats.reposts >= CONFIG.MAX_REPOSTS_THRESHOLD) {
    const skipLogMsg = `Skipped: "${track.title}" reached thresholds (Likes: ${stats.likes}, Reposts: ${stats.reposts})`;
    log.warn(`⚠️ ${skipLogMsg}`);

    // Clean bold alert — no pre block
    const skippedAlert =
      `⚠️ <b>Skipped Track:</b> "${track.title}"

` +
      `❤️ ${stats.likes} Likes  |  🔁 ${stats.reposts} Reposts
` +
      `⛔ Threshold reached — track skipped (Likes/Reposts ≥ 10)`;
    await sendTelegramAlert(skippedAlert);

    processedTrackIds.add(track.trackId);
    saveCache(processedTrackIds);
    return false;
  }

  // Step A: Execute Play
  await clickPlay(page, track.trackId);
  await humanDelay(400, 900);

  // Step B: Execute Like
  await clickLike(page, track.trackId);
  await humanDelay(400, 900);

  // Step C: Execute Repost
  await clickRepost(page, track.trackId);

  // Persist Cache
  processedTrackIds.add(track.trackId);
  saveCache(processedTrackIds);

  // Single rich track card summary — link preview ENABLED so Telegram renders the Audius card
  const trackCard =
    `🎵 <b>New Track Processed!</b>

` +
    `<b>Title:</b> <a href="${trackUrl}">${track.title}</a>
` +
    `<b>Stats:</b> ❤️ ${stats.likes} Likes  |  🔁 ${stats.reposts} Reposts
` +
    `<b>Actions:</b> ❤️ Liked  |  🔁 Reposted`;

  log.ok(`✅ Processed: "${track.title}"`);
  await sendTrackCard(trackCard);

  return true;
}

// ─── Phase 5: Primary Refresh Loop ─────────────────────────────────────────

async function runLoop(page) {
  const processedTrackIds = loadCache();
  let cycleCount = 0;

  log.info(`Bot engine ready — tracking history initialized with ${processedTrackIds.size} cached items.`);
  log.info(`Main execution loop active (interval: ${CONFIG.REFRESH_INTERVAL / 1000}s).`);

  // Start continuous non-blocking Telegram command listener (/start_bot, /stop_bot, /status)
  startTelegramPoller(processedTrackIds);

  while (true) {
    // Check if bot is paused via Telegram /stop_bot command
    if (!isBotActive) {
      log.idle('Bot is currently PAUSED via Telegram control. Standing by…');
      await sleep(CONFIG.REFRESH_INTERVAL);
      continue;
    }

    cycleCount++;

    try {
      await ensureFeedPage(page);

      // Feed Scanning Phase
      log.info(`Cycle #${cycleCount} — reloading feed page…`);
      await sendTelegramAlert('🔄 <b>Scanning feed</b> — checking for new tracks...');
      await resilientReload(page, `Cycle #${cycleCount} reload`);

      await ensureLatestFilter(page);

      const tracks = await getLatestTracks(page);

      if (tracks.length === 0) {
        log.warn('No track items extracted — standing by for next cycle.');
        await sendTelegramAlert('💤 <b>Standby</b> — No new tracks detected. Checking again in 15s...');
        await sleep(CONFIG.REFRESH_INTERVAL);
        continue;
      }

      // Delta detection
      const newTracks = tracks.filter(t => !processedTrackIds.has(t.trackId));

      if (newTracks.length === 0) {
        log.idle(`No new tracks in feed. Top track: "${tracks[0].title}"`);
        await sendTelegramAlert('💤 <b>Standby</b> — No new tracks detected. Checking again in 15s...');
      } else {
        log.bot(`Identified ${newTracks.length} new track(s). Processing chronologically…`);

        // Process from oldest to newest in current view
        newTracks.reverse();

        for (const track of newTracks) {
          if (!isBotActive) break;

          try {
            await processNewTrack(page, track, processedTrackIds);
          } catch (trackErr) {
            const errDetails = `Error processing "${track.title}": ${trackErr.message}`;
            log.error(errDetails);
            await sendTelegramAlert(`❌ <b>Error Encountered</b>\n\n${errDetails}`);
          }
        }
      }
    } catch (err) {
      const loopErrDetails = `Loop cycle execution error: ${err.message}`;
      log.error(loopErrDetails);
      await sendTelegramAlert(`❌ <b>Error Encountered</b>\n\n${loopErrDetails}`);

      try {
        await resilientNavigation(page, CONFIG.FEED_URL, 'Recovery navigation');
      } catch {
        log.error('Recovery navigation unsuccessful — continuing to next loop cycle.');
      }
    }

    // Standby 15 seconds before next cycle
    await sleep(CONFIG.REFRESH_INTERVAL);
  }
}

// ─── Main Entrypoint ───────────────────────────────────────────────────────

async function main() {
  console.log('\n');
  console.log('  ╔══════════════════════════════════════════════════════════╗');
  console.log('  ║    🎧  Audius Feed Bot — Live Telegram Streaming  🎧    ║');
  console.log('  ║    Play · Like · Repost · Controls · Bloat Control       ║');
  console.log('  ╚══════════════════════════════════════════════════════════╝');
  console.log('\n');

  let browser;

  try {
    // 1. Register Telegram command menu & button keyboard
    await registerTelegramMenu();

    // 2. Send Startup Notification straight to Telegram with reply markup menu keyboard
    await sendTelegramAlert('🚀 <b>Audius Bot Online</b> — Initializing browser & sessions...', true);

    const instance = await launchBrowser();
    browser = instance.browser;
    const page = instance.page;

    await ensureAuthenticated(page);
    await ensureFeedPage(page);
    await ensureLatestFilter(page);

    await runLoop(page);

  } catch (err) {
    const fatalMsg = `Fatal startup error: ${err.message}`;
    log.error(fatalMsg);
    await sendTelegramAlert(`❌ <b>Error Encountered:</b>\n<pre>Details: ${fatalMsg}</pre>`);
    console.error(err);
  } finally {
    if (browser) {
      log.info('Terminating browser session…');
      await browser.close();
    }
    process.exit(0);
  }
}

process.on('SIGINT', () => {
  log.info('Received SIGINT — shutting down bot gracefully…');
  process.exit(0);
});

process.on('SIGTERM', () => {
  log.info('Received SIGTERM — shutting down bot gracefully…');
  process.exit(0);
});

main();