const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUTPUT_PATH = path.join(__dirname, 'data', 'ads.json');
const SCREENSHOT_PATH = path.join(__dirname, 'data', 'debug.png');
const TARGET_URL =
  'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&q=pink+salt+trick&search_type=keyword_unordered';

const MIN_CREATIVE_COUNT = 100;
const SCROLL_TIMES = 10;
const SCROLL_DELAY_MS = 3000;

let collectedAds = [];

function saveProgress() {
  const filtered = collectedAds.filter((a) => a.creativeCount >= MIN_CREATIVE_COUNT);
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(filtered, null, 2), 'utf-8');
  console.log(`\n[save] ${filtered.length} ads saved to ${OUTPUT_PATH}`);
}

process.on('SIGINT', () => {
  console.log('\n[interrupted] Saving...');
  saveProgress();
  process.exit(0);
});

function parseDaysActive(startedText) {
  const match = startedText.match(/Started running on (.+)/i);
  if (!match) return { startDate: null, daysActive: null };
  const dateStr = match[1].trim();
  const parsed = new Date(dateStr);
  if (isNaN(parsed)) return { startDate: dateStr, daysActive: null };
  const days = Math.floor((Date.now() - parsed.getTime()) / (1000 * 60 * 60 * 24));
  return { startDate: dateStr, daysActive: days };
}

function parseCreativeCount(text) {
  const match = text.match(/^(\d[\d,]*)/);
  return match ? parseInt(match[1].replace(/,/g, ''), 10) : 0;
}

async function dismissCookies(page) {
  try {
    // Accept cookies if dialog appears
    const cookieBtn = page.locator('button[data-cookiebanner="accept_button"], [data-testid="cookie-policy-manage-dialog-accept-button"]').first();
    if (await cookieBtn.isVisible({ timeout: 4000 })) {
      await cookieBtn.click();
      console.log('[ads-swipe] Cookie dialog dismissed.');
      await page.waitForTimeout(1500);
    }
  } catch {}

  try {
    // "Allow all cookies" or "Accept all"
    const btns = await page.locator('button').all();
    for (const btn of btns) {
      const txt = (await btn.textContent()) || '';
      if (/allow all|accept all|aceitar|allow essential/i.test(txt)) {
        await btn.click();
        console.log('[ads-swipe] Cookie button clicked:', txt.trim());
        await page.waitForTimeout(1500);
        break;
      }
    }
  } catch {}
}

async function extractAdsFromPage(page) {
  return page.evaluate(() => {
    // Find card boundaries by isolating each Library ID occurrence
    // Each card = smallest ancestor div that contains exactly ONE Library ID
    const allDivs = Array.from(document.querySelectorAll('div'));

    const cards = new Set();
    allDivs.forEach(div => {
      const txt = div.textContent || '';
      const matches = txt.match(/Library ID[:\s]+\d{10,}/g);
      if (!matches || matches.length !== 1) return;

      // Make sure parent has more than 1 (so this div is the boundary)
      const parent = div.parentElement;
      if (!parent) return;
      const parentMatches = (parent.textContent || '').match(/Library ID[:\s]+\d{10,}/g);
      if (parentMatches && parentMatches.length === 1) return; // parent also has 1, keep going up

      cards.add(div);
    });

    const results = [];
    cards.forEach((card) => {
      try {
        const fullText = card.textContent || '';

        // Library ID
        let libraryId = null;
        const libMatch = fullText.match(/Library ID[:\s]+(\d{10,})/);
        if (libMatch) libraryId = libMatch[1];

        // Page name — look for links
        let pageName = null;
        const links = Array.from(card.querySelectorAll('a, [role="link"]'));
        for (const a of links) {
          const txt = (a.textContent || '').trim();
          if (txt.length > 1 && txt.length < 80 && !/library|facebook\.com|instagram/i.test(txt) && !/^\d+$/.test(txt)) {
            pageName = txt;
            break;
          }
        }

        // "Started running on..."
        let startedText = null;
        const startMatch = fullText.match(/(Started running on [A-Z][a-z]+ \d{1,2}, \d{4})/);
        if (startMatch) startedText = startMatch[1];

        // "X ads use this creative"
        let creativeText = null;
        const creativeMatch = fullText.match(/([\d,]+ ads use this creative[^\n.<]*)/i);
        if (creativeMatch) creativeText = creativeMatch[1].trim();

        // Images: separate profile pic (small/circle) from creative (large)
        let avatarUrl = null;
        let creativeImageUrl = null;

        const allImgs = Array.from(card.querySelectorAll('img[src]'));
        allImgs.forEach(img => {
          const src = img.src || '';
          const w = img.naturalWidth || img.width || 0;
          const h = img.naturalHeight || img.height || 0;
          const isSmall = w <= 80 || h <= 80 || src.includes('s60x60') || src.includes('s80x80') || src.includes('p40x40') || src.includes('p60x60');
          if (isSmall && !avatarUrl) {
            // Upgrade to larger avatar
            avatarUrl = src.replace(/s\d+x\d+/, 's160x160').replace(/p\d+x\d+/, 'p160x160');
          } else if (!isSmall && !creativeImageUrl) {
            creativeImageUrl = src.replace(/s\d+x\d+/, 's600x600');
          }
        });

        // Fallback: if only one image found, use as creative and derive avatar
        if (!creativeImageUrl && avatarUrl) { creativeImageUrl = avatarUrl; avatarUrl = null; }
        if (!creativeImageUrl && allImgs[0]) creativeImageUrl = allImgs[0].src;

        if (libraryId) {
          results.push({ libraryId, pageName, startedText, creativeText, avatarUrl, creativeImageUrl });
        }
      } catch (_) {}
    });

    return {
      results,
      debug: {
        totalDivs: allDivs.length,
        cardsFound: cards.size,
        hasLibraryId: document.body.textContent.includes('Library ID'),
        hasStartedRunning: document.body.textContent.includes('Started running on'),
        url: window.location.href,
      }
    };
  });
}

async function run() {
  console.log('[ads-swipe] Launching browser...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  });

  const page = await context.newPage();

  console.log('[ads-swipe] Opening Facebook Ads Library...');
  await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 60000 });

  // Dismiss cookie dialogs
  await dismissCookies(page);

  // Check for login wall
  const url = page.url();
  if (url.includes('login') || url.includes('checkpoint')) {
    console.error('[ERROR] Facebook is asking for login. Cannot proceed.');
    await browser.close();
    process.exit(1);
  }

  // Wait a bit for content to render
  console.log('[ads-swipe] Waiting for page to render...');
  await page.waitForTimeout(4000);

  // Screenshot for debugging
  await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false });
  console.log(`[ads-swipe] Screenshot saved to ${SCREENSHOT_PATH}`);

  const seen = new Set();

  async function collectCurrent() {
    const { results, debug } = await extractAdsFromPage(page);
    console.log(`  [debug] divs=${debug.totalDivs} | hasLibraryId=${debug.hasLibraryId} | hasStarted=${debug.hasStartedRunning}`);

    let newCount = 0;
    for (const ad of results) {
      const key = ad.libraryId || (ad.creativeText + ad.pageName);
      if (!key || seen.has(key)) continue;
      seen.add(key);

      const { startDate, daysActive } = parseDaysActive(ad.startedText || '');
      const creativeCount = parseCreativeCount(ad.creativeText || '0');

      collectedAds.push({
        libraryId: ad.libraryId,
        pageName: ad.pageName,
        adUrl: ad.libraryId ? `https://www.facebook.com/ads/library/?id=${ad.libraryId}` : null,
        startDate,
        daysActive,
        creativeCount,
        imageUrl: ad.imageUrl,
      });
      newCount++;
    }
    return newCount;
  }

  await collectCurrent();
  console.log(`[ads-swipe] Initial: ${collectedAds.length} ads`);

  let noNewCount = 0;
  for (let i = 1; i <= SCROLL_TIMES; i++) {
    console.log(`[ads-swipe] Scroll ${i}/${SCROLL_TIMES}...`);
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 3));
    await page.waitForTimeout(SCROLL_DELAY_MS);

    const newAds = await collectCurrent();
    console.log(`  +${newAds} new (total: ${collectedAds.length})`);

    if (newAds === 0) {
      noNewCount++;
      if (noNewCount >= 3) {
        console.log('[ads-swipe] Nada novo por 3 scrolls seguidos. Parando.');
        break;
      }
    } else {
      noNewCount = 0;
    }
  }

  await browser.close();
  saveProgress();

  const filtered = collectedAds.filter((a) => a.creativeCount >= MIN_CREATIVE_COUNT);
  console.log(`\n[done] Total: ${collectedAds.length} | Filtrados (>=${MIN_CREATIVE_COUNT}): ${filtered.length}`);
}

run().catch((err) => {
  console.error('[fatal]', err);
  saveProgress();
  process.exit(1);
});
