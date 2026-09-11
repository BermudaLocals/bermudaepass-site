/**
 * Bermuda ePass — Live Events Scraper
 * Runs twice daily: 7am + 2pm
 * Scrapes: whatson.bm, bermudatourism.com, royalgazette.com
 * Saves: /var/www/bermuda-epass/live-events.json
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const OUTPUT_FILE = path.join(__dirname, 'live-events.json');

// Simple HTML tag stripper
function stripTags(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

// Fetch a URL and return body text
function fetchUrl(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
        'Accept': 'text/html,application/xhtml+xml'
      },
      timeout
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, timeout).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Parse events from whatson.bm style HTML
function parseWhatson(html) {
  const events = [];
  // Look for event titles and dates in common patterns
  const datePattern = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:\s*[-–]\s*\d{1,2})?,?\s*202[5-9]/gi;
  const titlePattern = /<(?:h[1-4]|strong|b)[^>]*>([^<]{10,80})<\/(?:h[1-4]|strong|b)>/gi;
  
  let titleMatch;
  const titles = [];
  while ((titleMatch = titlePattern.exec(html)) !== null) {
    const t = stripTags(titleMatch[1]).trim();
    if (t.length > 5 && !t.includes('{') && !t.toLowerCase().includes('cookie')) {
      titles.push(t);
    }
  }
  
  titles.slice(0, 8).forEach((title, i) => {
    events.push({
      id: 'ws_' + i,
      title: title,
      venue: 'Bermuda',
      date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      source: 'whatson.bm',
      free: title.toLowerCase().includes('free') || title.toLowerCase().includes('open')
    });
  });
  return events;
}

// Parse from Bermuda Tourism
function parseBermudaTourism(html) {
  const events = [];
  const articlePattern = /<article[^>]*>([\s\S]*?)<\/article>/gi;
  let match;
  let count = 0;
  
  while ((match = articlePattern.exec(html)) !== null && count < 6) {
    const content = match[1];
    const titleM = content.match(/<h[23][^>]*>([^<]{5,80})</);
    if (titleM) {
      const title = stripTags(titleM[1]).trim();
      if (title && !title.includes('{')) {
        events.push({
          id: 'bt_' + count,
          title: title,
          venue: 'Bermuda',
          date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          source: 'bermudatourism.com',
          free: false
        });
        count++;
      }
    }
  }
  return events;
}

// Parse Royal Gazette headlines
function parseRoyalGazette(html) {
  const events = [];
  const headlinePattern = /<h[23][^>]*class="[^"]*(?:headline|title|story)[^"]*"[^>]*>\s*<a[^>]*>([^<]{10,100})<\/a>/gi;
  let match;
  let count = 0;
  
  while ((match = headlinePattern.exec(html)) !== null && count < 5) {
    const title = stripTags(match[1]).trim();
    if (title && !title.includes('{')) {
      events.push({
        id: 'rg_' + count,
        title: title,
        venue: 'Bermuda News',
        date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        source: 'royalgazette.com',
        free: true
      });
      count++;
    }
  }
  return events;
}

// Static fallback events (always shown if scraping fails)
const FALLBACK_EVENTS = [
  { id: 'f1', title: 'Horseshoe Bay Beach — Open Daily', venue: 'South Shore, Bermuda', date: 'Daily', source: 'static', free: true },
  { id: 'f2', title: 'Crystal Caves Tours', venue: 'Hamilton Parish', date: 'Daily 9am-5pm', source: 'static', free: false },
  { id: 'f3', title: 'Snorkel Park Beach Club', venue: 'Royal Naval Dockyard', date: 'Daily', source: 'static', free: false },
  { id: 'f4', title: 'St. George\'s Town Walking Tours', venue: 'St. George\'s', date: 'Mon-Sat', source: 'static', free: true },
  { id: 'f5', title: 'Bermuda Aquarium & Zoo', venue: 'Flatts Village', date: 'Daily 9am-5pm', source: 'static', free: false },
  { id: 'f6', title: 'Royal Naval Dockyard', venue: 'Sandys Parish', date: 'Daily', source: 'static', free: true },
];

async function scrapeAll() {
  console.log('[Scraper] Starting Bermuda events scrape at', new Date().toISOString());
  
  let allEvents = [];
  
  // Pull live articles from BermudaObserver (our own news site on port 3025)
  try {
    console.log('[Scraper] Fetching BermudaObserver API');
    const obsData = await fetchUrl('http://localhost:3025/api/articles');
    const obs = JSON.parse(obsData);
    if (obs.articles && obs.articles.length) {
      const obsEvents = obs.articles.map((a, i) => ({
        id: 'obs_' + i,
        title: a.title,
        venue: a.venue || 'Bermuda',
        date: a.date || new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        source: 'BermudaObserver',
        summary: a.summary || '',
        free: true
      }));
      console.log('[Scraper] BermudaObserver →', obsEvents.length, 'articles');
      allEvents = allEvents.concat(obsEvents);
    }
  } catch (e) {
    console.log('[Scraper] BermudaObserver failed:', e.message);
  }

  // Try external sources
  const sources = [
    { url: 'https://www.bermudatourism.com/events/', parser: parseBermudaTourism, name: 'bermudatourism.com' },
    { url: 'https://www.royalgazette.com/', parser: parseRoyalGazette, name: 'royalgazette.com' },
  ];
  
  for (const src of sources) {
    try {
      console.log('[Scraper] Fetching', src.name);
      const html = await fetchUrl(src.url);
      const events = src.parser(html);
      console.log('[Scraper]', src.name, '→', events.length, 'events');
      allEvents = allEvents.concat(events);
    } catch (e) {
      console.log('[Scraper] Failed', src.name, e.message);
    }
  }
  
  // Always include fallback events
  allEvents = allEvents.concat(FALLBACK_EVENTS);
  
  // Deduplicate by title
  const seen = new Set();
  const unique = allEvents.filter(e => {
    if (seen.has(e.title)) return false;
    seen.add(e.title);
    return true;
  });
  
  const output = {
    updated: new Date().toISOString(),
    updated_friendly: new Date().toLocaleString('en-US', { timeZone: 'Atlantic/Bermuda' }) + ' BDA',
    count: unique.length,
    events: unique
  };
  
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log('[Scraper] Saved', unique.length, 'events to', OUTPUT_FILE);
  return output;
}

// Run scraper
if (require.main === module) {
  scrapeAll().then(r => {
    console.log('[Scraper] Done:', r.count, 'events');
    process.exit(0);
  }).catch(e => {
    console.error('[Scraper] Error:', e);
    process.exit(1);
  });
}

module.exports = { scrapeAll };
