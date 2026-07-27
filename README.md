# 🎧 Audius Feed Bot

Automated browser bot that monitors your Audius feed and **Plays**, **Likes**, and **Reposts** the newest track every refresh cycle.

## Features

- **Persistent Sessions** — Uses a local Chromium profile (`audius_session_profile/`) so you only log in once
- **Smart Filter Detection** — Automatically switches to the "Latest" (chronological) feed
- **Delta Detection** — Caches the last-processed track in `cache.json` to avoid duplicate actions
- **Human-Like Timing** — Randomised delays (400–900ms) between interactions
- **Error Resilient** — All interactions are wrapped in try/catch; the loop never crashes

## Prerequisites

- **Node.js** ≥ 18
- **npm** ≥ 9

## Quick Start

```bash
# Install dependencies (downloads Puppeteer + Chromium)
npm install

# Run the bot
npm start
```

### First Run

1. The bot opens a Chromium window and navigates to `https://audius.co/feed`
2. If you're not logged in, you'll see a prompt in the terminal:
   ```
   🔒 Please complete your Audius login in the browser window now...
   ```
3. Log in manually in the browser — the bot waits for you
4. Once on `/feed`, the bot saves your session and begins monitoring

### Subsequent Runs

The session is restored automatically from the `audius_session_profile/` directory. No login needed.

## How It Works

```
┌─────────────────────────────────────────────┐
│           Launch Chromium (headful)          │
│        with persistent user-data-dir        │
└─────────────────┬───────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────┐
│        Navigate to /feed                     │
│        Detect login state                    │
│        Wait for manual login if needed       │
└─────────────────┬───────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────┐
│        Ensure "Latest" filter is active      │
└─────────────────┬───────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────┐
│     ┌─── Refresh Loop (every 15s) ───┐      │
│     │                                 │      │
│     │  1. page.reload()              │      │
│     │  2. Verify "Latest" filter     │      │
│     │  3. Extract topmost track ID   │      │
│     │  4. Compare with cache         │      │
│     │                                 │      │
│     │  If NEW track:                  │      │
│     │    ▶ Play   (400-900ms delay)  │      │
│     │    ❤ Like   (400-900ms delay)  │      │
│     │    🔁 Repost                    │      │
│     │    💾 Save to cache.json        │      │
│     │                                 │      │
│     │  If SAME track:                 │      │
│     │    💤 Stand by                  │      │
│     │                                 │      │
│     └────────────────────────────────┘      │
└─────────────────────────────────────────────┘
```

## Configuration

Edit the `CONFIG` object at the top of `bot.mjs`:

| Setting | Default | Description |
|---|---|---|
| `REFRESH_INTERVAL` | `15000` (15s) | How often to refresh the feed |
| `SELECTOR_TIMEOUT` | `12000` (12s) | Max wait for DOM elements to appear |
| `LOGIN_WAIT_TIMEOUT` | `300000` (5m) | Max time to wait for manual login |
| `VIEWPORT` | `1440×900` | Browser viewport dimensions |

## Files

| File | Purpose |
|---|---|
| `bot.mjs` | Main bot script |
| `package.json` | Dependencies & scripts |
| `cache.json` | Auto-generated — tracks the last processed song |
| `audius_session_profile/` | Auto-generated — Chromium profile with saved cookies |

## Selector Strategy

Audius is a React SPA with CSS Modules (hashed class names). The bot uses selectors ordered by stability:

1. **`aria-label`** — Accessibility attributes are stable API contracts
2. **Text content via XPath** — UI copy changes infrequently
3. **Link `href` patterns** — Track permalinks follow `/<handle>/<slug>`
4. **Structural queries** — `[role="tab"]`, parent traversal, etc.

## Stopping the Bot

Press `Ctrl+C` in the terminal for a graceful shutdown.

## Troubleshooting

| Issue | Solution |
|---|---|
| Bot can't find the play/like/repost buttons | Audius may have updated their UI. Open DevTools and inspect the button `aria-label` values, then update selectors in `bot.mjs` |
| Session expired | Delete `audius_session_profile/` and restart — you'll be prompted to log in again |
| Chromium won't launch | Ensure no other instance is using the same profile directory |
