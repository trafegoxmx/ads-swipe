const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUTPUT_PATH = path.join(__dirname, 'data', 'ads.json');
const TARGET_URL =
  'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&q=pink+salt+trick&search_type=keyword_unordered';

const MIN_CREATIVE_COUNT = 100;
const SCROLL_TIMES = 10;
const SCROLL_DELAY_MS = 2500;

// Save collected ads to disk even on interruption
let collectedAds = [];

function saveProgress() {
  const filtered = collectedAds.filter((a) => a.creativeCount >= MIN_CREATIVE_COUNT);
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(filtered, null, 2), 'utf-8');
  console.log(`\n[save] ${filtered.length} ads saved to ${OUTPUT_PATH}`);
}

process.on('SIGINT', () => {
  console.log('\n[interrupted] Saving collected data before exit...');
  saveProgress();
  process.exit(0);
});

function parseDaysActive(startedText) {
  // "Started running on May 1, 2024"
  const match = startedText.match(/Started running on (.+)/i);
  if (!match) return { startDate: null, daysActive: null };
  const dateStr = match[1].trim();
  const parsed = new Date(dateStr);
  if (isNaN(parsed)) return { startDate: dateStr, daysActive: null };
  const days = Math.floor((Date.now() - parsed.getTime()) / (1000 * 60 * 60 * 24));
  return { startDate: dateStr, daysActive: days };
}

function parseCreativeCount(text) {
  // "143 ads use this creative and text"
  const match = text.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

async function extractAdsFromPage(page) {
  return page.evaluate(() => {
    const cards = document.querySelectorAll('[data-testid="collection-ad-card"]');
    const results = [];

    cards.forEach((card) => {
      try {
        // Library ID — found in the "Library ID:" label area
        let libraryId = null;
        const allSpans = Array.from(card.querySelectorAll('span'));
        const libSpan = allSpans.find((s) => s.textContent.trim().startsWith('Library ID:'));
        if (libSpan) {
          const next = libSpan.nextSibling || libSpan.parentElement?.nextElementSibling;
          if (next) libraryId = next.textContent?.trim() || null;
          // Sometimes it's inline: "Library ID: 123456"
          if (!libraryId) {
            const m = libSpan.textContent.match(/Library ID:\s*(\d+)/);
            if (m) libraryId = m[1];
          }
        }

        // Fallback: look for any text matching Library ID pattern
        if (!libraryId) {
          const fullText = card.textContent;
          const m = fullText.match(/Library ID:\s*(\d+)/);
          if (m) libraryId = m[1];
        }

        // Page name — typically an <a> or prominent heading inside the card
        let pageName = null;
        const pageLink = card.querySelector('a[href*="facebook.com"]');
        if (pageLink) pageName = pageLink.textContent?.trim() || null;

        // "Started running on..." text
        let startedText = null;
        const startedSpan = allSpans.find((s) =>
          s.textContent.trim().startsWith('Started running on')
        );
        if (startedSpan) startedText = startedSpan.textContent.trim();

        // "X ads use this creative and text"
        let creativeText = null;
        const creativeSpan = allSpans.find((s) =>
          s.textContent.trim().match(/\d+\s+ads use this creative/i)
        );
        if (creativeSpan) creativeText = creativeSpan.textContent.trim();

        // Thumbnail — first <img> inside the card
        let imageUrl = null;
        const img = card.querySelector('img[src]');
        if (img) imageUrl = img.src;

        results.push({
          libraryId,
          pageName,
          startedText,
          creativeText,
          imageUrl,
        });
      } catch (_) {}
    });

    return results;
  });
}

async function run() {
  console.log('[ads-swipe] Launching browser (headless: false)...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  });

  const page = await context.newPage();

  console.log('[ads-swipe] Navigating to Facebook Ads Library...');
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Detect login wall
  await page.waitForTimeout(3000);
  const url = page.url();
  if (url.includes('login') || url.includes('checkpoint')) {
    console.error(
      '[ERROR] Facebook is requesting login. Cannot proceed without authentication.\nPlease log in manually and re-run, or use cookies-based auth.'
    );
    await browser.close();
    process.exit(1);
  }

  // Wait for first ad cards to appear
  console.log('[ads-swipe] Waiting for ad cards to load...');
  try {
    await page.waitForSelector('[data-testid="collection-ad-card"]', { timeout: 20000 });
  } catch {
    // Cards may use different selectors — continue anyway
    console.warn('[warn] Default card selector not found, continuing with scroll...');
  }

  const seen = new Set();

  async function collectCurrent() {
    const raw = await extractAdsFromPage(page);
    let newCount = 0;
    for (const ad of raw) {
      const key = ad.libraryId || ad.creativeText + ad.pageName;
      if (!key || seen.has(key)) continue;
      seen.add(key);

      const { startDate, daysActive } = parseDaysActive(ad.startedText || '');
      const creativeCount = parseCreativeCount(ad.creativeText || '0');

      collectedAds.push({
        libraryId: ad.libraryId,
        pageName: ad.pageName,
        adUrl: ad.libraryId
          ? `https://www.facebook.com/ads/library/?id=${ad.libraryId}`
          : null,
        startDate,
        daysActive,
        creativeCount,
        imageUrl: ad.imageUrl,
      });
      newCount++;
    }
    return newCount;
  }

  // Initial collection
  await collectCurrent();
  console.log(`[ads-swipe] Initial load: ${collectedAds.length} unique ads found`);

  // Scroll loop
  let noNewCount = 0;
  for (let i = 1; i <= SCROLL_TIMES; i++) {
    console.log(`[ads-swipe] Scroll ${i}/${SCROLL_TIMES}...`);
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 3));
    await page.waitForTimeout(SCROLL_DELAY_MS);

    const newAds = await collectCurrent();
    console.log(`  +${newAds} new ads (total: ${collectedAds.length})`);

    if (newAds === 0) {
      noNewCount++;
      if (noNewCount >= 3) {
        console.log('[ads-swipe] No new ads after 3 consecutive scrolls. Stopping early.');
        break;
      }
    } else {
      noNewCount = 0;
    }
  }

  await browser.close();

  saveProgress();

  const filtered = collectedAds.filter((a) => a.creativeCount >= MIN_CREATIVE_COUNT);
  console.log(
    `\n[done] Total scraped: ${collectedAds.length} | Filtered (>=${MIN_CREATIVE_COUNT} creatives): ${filtered.length}`
  );
}

run().catch((err) => {
  console.error('[fatal]', err);
  saveProgress();
  process.exit(1);
});
