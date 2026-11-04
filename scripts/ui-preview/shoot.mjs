// Screenshots every page, dialog and state of the UI preview server in one theme.
// Usage: node scripts/ui-preview/shoot.mjs [port=8090] [outDir=ui-shots] [dark|light] [name,name]
// Needs Playwright with a Chromium (npx playwright install chromium); it is not a repo dependency.
import { chromium } from 'playwright';
import fs from 'node:fs';
const [port = '8090', out = 'ui-shots', theme = 'dark', only = ''] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
// A conversation opens in the chat drawer from its #thread link, at any width.
const c1 = '/#thread=c1';
const S = {
  'home': ['/'],
  'chat-empty': ['/', ['click', '.chat-panel-head .new-chat'], ['wait', 300]],
  'sites': ['/sites'],
  'site': ['/sites/p_fulton'],
  'plan': ['/sites/p_fulton/plan'],
  'menu-collapsed': ['/', ['click', '.rail-collapse']],
  'chat-answer': [c1],
  'chat-sources': [c1, ['click', '.answer-sources > summary']],
  'chat-activity': [c1, ['click', '.research-activity > summary'], ['wait', 900]],
  'chat-live': ['/#thread=c6', ['wait', 1200]],
  'chat-more': [c1, ['click', '.chat-more > summary'], ['wait', 300]],
  'dock-more': ['/', ['click', '.chat-more > summary'], ['wait', 300]],
  'share-more': [c1, ['click', '#share-button'], ['wait', 600], ['click', '.share-more > summary'], ['wait', 300]],
  'chat-card': [c1, ['wait', 1500], ['scroll', '#main', 99999], ['wait', 600]],
  'source-dialog': [c1, ['click', '.citation']],
  'context-panel': ['/sites/p_fulton', ['click', '.chat-more > summary'], ['click', '.chat-menu .context-toggle']],
  'history-view': ['/', ['click', '.chat-more > summary'], ['click', '.chat-menu .chat-history-open'], ['wait', 600]],
  'share-dialog': [c1, ['click', '#share-button'], ['wait', 600]],
  'teams-detail': ['/', ['click', '#rail-teams'], ['wait', 800], ['click', '[data-team-select]'], ['wait', 600]],
  'teams-dialog': ['/', ['click', '#rail-teams'], ['wait', 800]],
  'wallet-dialog': ['/', ['click', '#wallet-button'], ['wait', 600]],
  'admin-dialog': ['/', ['click', '#admin-button'], ['wait', 600]],
  'home-inspector': ['/', ['click', '.listing-card .listing-card-open'], ['wait', 900]],
  'home-costs': ['/', ['popover', 'Costs']],
  'home-tier': ['/', ['popover', 'Deal tier']],
  'home-drawer': ['/', ['click', '.listings-all'], ['wait', 400]],
  'home-search': ['/', ['click', '.listings-find input'], ['eval', () => { const i = document.querySelector('.listings-find input'); i.value = '267 West 23 Street'; i.dispatchEvent(new Event('input', { bubbles: true })); }]],
  'site-mid': ['/sites/p_fulton', ['scroll', '#core-page', 1400]],
  'site-low': ['/sites/p_fulton', ['scroll', '#core-page', 3000]],
  'site-bottom': ['/sites/p_fulton', ['scroll', '#core-page', 99999]],
};
const browser = await chromium.launch();
// MOBILE=1 shoots at phone width.
const ctx = await browser.newContext({ viewport: process.env.MOBILE ? { width: 390, height: 844 } : { width: 1440, height: 900 } });
await ctx.addInitScript((t) => { try { localStorage.theme = t; if (!localStorage.getItem('acres-chat-dock-open')) localStorage.setItem('acres-chat-dock-open', 'true'); } catch {} }, theme);
const errors = [];
for (const [name, [route, ...steps]] of Object.entries(S)) {
  if (only && !only.split(',').includes(name)) continue;
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(`http://localhost:${port}${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  try {
    for (const [op, a, b] of steps) {
      if (op === 'click') await page.click(a, { timeout: 4000 });
      if (op === 'wait') await page.waitForTimeout(a);
      if (op === 'eval') await page.evaluate(a);
      if (op === 'reload') { await page.reload(); await page.waitForTimeout(1500); }
      if (op === 'scroll') await page.evaluate(([sel, y]) => { const el = document.querySelector(sel); el.scrollTop = y; }, [a, b]);
      if (op === 'popover') await page.locator('.listings-pop > summary', { hasText: a }).first().click();
      await page.waitForTimeout(350);
    }
  } catch (e) { errors.push(`${name}: step failed ${e.message.split('\n')[0]}`); }
  await page.screenshot({ path: `${out}/${process.env.MOBILE ? 'phone-' : ''}${theme}-${name}.png` });
  if (name === 'menu-collapsed') await page.click('.rail-collapse').catch(() => {});
  await page.close();
}
await browser.close();
console.log(errors.join('\n') || 'no errors');
