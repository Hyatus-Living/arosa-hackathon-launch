// Find a deal: the app's own Explore view on example listings. Underwrite, Ask Arosa and the floor
// plan action hand the listing to the landing page's other embeds.
import { serveApi, tell, ready } from "/demo/shell.js";
import { DEALS, SETTINGS, searchDeals } from "/demo/listings-data.js";
import { createListings } from "/app/listings.js";
import { createNycMap } from "/demo/nyc-map.js";

serveApi((path, params) => {
  if (path === "/market-store/user-settings") return SETTINGS;
  if (path === "/market-store/deals/pins") {
    const rows = searchDeals(params);
    return { total: rows.length, pins: rows.map(({ id, address, latitude, longitude, listPrice, flashcardValuation }, i) => ({ id, rank: i + 1, address, latitude, longitude, listPrice, dealVerdict: flashcardValuation.dealVerdict })) };
  }
  const one = path.match(/^\/market-store\/deals\/([^/?]+)$/);
  if (one) return { deal: DEALS.find((d) => d.id === decodeURIComponent(one[1])), userSettings: SETTINGS };
  if (path === "/market-store/deals") {
    const rows = searchDeals(params), offset = Number(params.get("offset") || 0), limit = Number(params.get("limit") || 20);
    return { deals: rows.slice(offset, offset + limit), total: rows.length, offset, limit, userSettings: SETTINGS };
  }
  return {};
});

const listings = createListings({
  root: document.getElementById("home-listings"),
  canStart: () => true,
  onUnderwrite: (deal) => tell("underwrite", { id: deal.listing_id, address: deal.address }),
  onAsk: (deal) => tell("ask", { id: deal.listing_id, address: deal.address }),
  onInvestigate: null,
  onPlan: () => (deal) => tell("building", { id: deal.listing_id, address: deal.address }),
  loadMap: createNycMap,
  searchUrl: null,
  copyText: async () => {},
});
await ready;
listings.show();
tell("ready");
addEventListener("resize", () => listings.resize());
