# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a 24/7 Spotify for Artists real-time listener tracker that:
- Scrapes live listener counts from Spotify for Artists dashboard using Puppeteer
- Stores historical data in JSON format
- Exposes REST API endpoints for data access
- Provides a beautiful, modern web dashboard with real-time charts and analytics

## Development Commands

```bash
# Install dependencies
npm install

# First-time setup: Create .env file from template
cp .env.example .env
# Edit .env to configure your artist URL and settings

# Migrate existing JSON data to SQLite (if upgrading from old version)
npm run migrate

# Run the application (starts both scraper and web server)
npm start
# or
npm run dev
# or
node index.js

# Acquire Spotify cookies (run on local machine with GUI)
node login.js

# Background deployment (Linux/production)
nohup node index.js > output.log 2>&1 &

# Using PM2 (recommended for production)
pm2 start index.js --name spotify-tracker
pm2 logs spotify-tracker
pm2 status
```

## Architecture

### Core Components

**index.js** - Main application file containing:
- Puppeteer browser automation for scraping Spotify for Artists
- Express web server for API and dashboard
- SQLite data persistence layer (sql.js - pure JavaScript)
- Browser crash auto-recovery mechanism
- Scraping scheduler (configurable interval, default 5 seconds)

**login.js** - Cookie acquisition utility:
- Opens Puppeteer in non-headless mode
- Allows manual Spotify login
- Saves cookies to `cookies.json` for headless scraping

**migrate.js** - Data migration script:
- Migrates old JSON data to SQLite database
- Safe to run multiple times (skips duplicates)
- Auto-backs up old JSON file

### Data Flow

1. **Scraping Loop** (`scrapeWithRecovery()`):
   - Checks browser health before each scrape (`ensureBrowser()`)
   - Navigates to Spotify for Artists dashboard
   - Uses cookies for authentication
   - Extracts listener count via DOM traversal
   - Stores data points with timestamp in SQLite
   - Detects login expiration and sets error state
   - Auto-recovers from browser crashes

2. **Data Storage** (SQLite):
   - Database: `listeners.db` (configurable via .env)
   - Table: `listeners` with columns: id, timestamp, listener_count, created_at
   - Indexed on timestamp for fast queries
   - Direct inserts via `saveData(timestamp, count)` - no memory overhead
   - Query functions: `getStats()`, `getData(limit)`, `getAllData()`

3. **API Layer**:
   - `/` - Full-featured dashboard with Chart.js visualizations
   - `/api/stats` - Aggregated statistics (min, max, avg, latest) via SQL queries
   - `/api/data?limit=N` - Raw data points (default 1000)
   - `/api/status` - Scraper health check
   - `/api/cookies` (POST) - Upload cookies remotely
   - `/api/download/csv` - Export all data as CSV

### Configuration

Configuration via `.env` file (see `.env.example`):
```bash
ARTIST_URL=https://artists.spotify.com/c/artist/{ARTIST_ID}/home
PORT=3000
SCRAPE_INTERVAL=5000  # milliseconds
COOKIES_FILE=cookies.json
DATABASE_FILE=listeners.db
```

Loaded via `dotenv` with fallback defaults in `CONFIG` object.

### Authentication Pattern

**Cookie-based authentication** is critical:
- Spotify for Artists requires login
- `cookies.json` stores session cookies
- Two methods to acquire cookies:
  1. **Local**: Run `login.js` on machine with GUI
  2. **Remote**: Export cookies from browser and POST to `/api/cookies`
- Cookies auto-saved after successful scrapes
- Login detection: Redirects to `accounts.spotify.com` trigger error state

### Error Handling & Recovery

**Scrape Status Tracking** (`scrapeStatus` object):
- `lastSuccess` - ISO timestamp of last successful scrape
- `lastError` - ISO timestamp of last error
- `errorMessage` - Human-readable error description
- `needsLogin` - Boolean flag for cookie expiration
- `consecutiveErrors` - Counter for monitoring health

**Failure Scenarios**:
- Login expired: Sets `needsLogin=true`, prompts cookie refresh
- Page load timeout: Retries on next interval
- Element not found: Logs warning, continues operation
- **Browser crash: AUTO-RECOVERS** via `ensureBrowser()` - checks connection and restarts if needed
- All scrapes wrapped in `scrapeWithRecovery()` try-catch block

### Frontend Dashboard

**Technology**: Vanilla JavaScript with Chart.js
**Features**:
- Real-time line chart with customizable time ranges (1h, 6h, 12h, 24h, all)
- Statistics cards (current, max, min, total records, average)
- Prediction analytics (estimated daily streams based on current trend)
- Growth metrics and volatility analysis
- Live error banners with login recovery options
- Modal dialogs for cookie upload
- Auto-refresh every 10 seconds

**Styling**: Modern dark theme with Spotify-inspired green accents, glassmorphism effects

## Common Patterns

### Adding a New API Endpoint

Add route in `startServer()` function:
```javascript
app.get('/api/newEndpoint', (req, res) => {
  // Query database using prepared statements
  const data = db.prepare('SELECT * FROM listeners WHERE ...').all();
  res.json(data);
});
```

### Modifying Scrape Interval

Change `CONFIG.scrapeInterval` (value in milliseconds). Note: Spotify rate limits may apply for very frequent requests.

### Changing Target Artist

Update `CONFIG.artistUrl` with new artist dashboard URL. Format:
`https://artists.spotify.com/c/artist/{ARTIST_ID}/home`

### Extending Data Schema

1. Add new column to database:
   ```javascript
   db.exec('ALTER TABLE listeners ADD COLUMN new_field TEXT');
   ```
2. Modify `saveData()` to accept new parameter
3. Update `scrapeListeners()` to extract new data
4. Add corresponding API endpoint logic
5. Update frontend to display new fields

## Deployment Notes

**Headless Environments** (Linux servers):
- Install Chromium dependencies (see README.md section 4)
- Acquire cookies via local machine, then upload
- Use `--no-sandbox` and `--disable-setuid-sandbox` Puppeteer args (already configured)
- Monitor with PM2 for auto-restart

**Windows Servers**:
- Can run `login.js` directly on server
- Firewall: Open port 3000

**Resource Usage**:
- Chromium process runs continuously
- Memory: ~200-300MB (Puppeteer + Node.js, SQLite uses minimal memory)
- Disk: Database grows ~100KB per day (at 5s intervals)
- SQLite handles millions of records efficiently without loading into memory

## Dependencies

- **puppeteer** (^21.0.0) - Headless Chrome automation
- **express** (^4.18.2) - Web server framework
- **sql.js** (^1.10.3) - Pure JavaScript SQLite implementation (no compilation needed)
- **dotenv** (^16.3.1) - Environment variable management

Note: `sql.js` is pure JavaScript - works on all platforms without compilation.

## Data Retention

**Current Implementation**: No automatic cleanup - data stored indefinitely in SQLite.

**Why This Works**:
- SQLite efficiently handles millions of records
- Database file: ~100KB per day, ~36MB per year
- No memory overhead (unlike old JSON approach)
- Queries remain fast due to timestamp index

**Optional Cleanup** (if needed years later):
```javascript
// Delete records older than 1 year
db.prepare(`
  DELETE FROM listeners
  WHERE timestamp < datetime('now', '-1 year')
`).run();

// Or archive to separate table
db.exec(`
  CREATE TABLE listeners_archive AS
  SELECT * FROM listeners WHERE timestamp < datetime('now', '-1 year');

  DELETE FROM listeners WHERE timestamp < datetime('now', '-1 year');
`);
```

## Security Considerations

- `cookies.json` contains sensitive session data - **added to .gitignore**
- `.env` contains configuration - **added to .gitignore**
- `listeners.db` may contain business-sensitive data - **added to .gitignore**
- No authentication on API endpoints - use reverse proxy with auth if exposing publicly
- SSRF risk from `artistUrl` config - sanitize if accepting user input
- Sensitive information removed from README.md (use placeholders)

## Migration from Old Version

If upgrading from the JSON-based version:

1. Install new dependencies: `npm install`
2. Create `.env` file: `cp .env.example .env`
3. Run migration: `npm run migrate`
4. Start application: `npm start`

The migration script:
- Reads `listeners_data.json`
- Imports all records to SQLite
- Creates backup of JSON file
- Safe to run multiple times (skips duplicates)
