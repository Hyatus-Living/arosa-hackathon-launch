// A listing's card in the results list: photo, tier, address and place, then ask, price per buildable
// SF, headroom and projected returns. The address is the button that opens the listing; it covers the card.
import { normalizeDealRow, fmtCurrency, fmtInt, fmtPct, verdictMeta, mihBadge, taxBadge } from "./deals.js";
import { finite, pricePerBuildable, tierHold } from "./deal-card.js";
import { headroomFar, headroomSqft } from "./core-model.js";
import { BOROUGHS, PROPERTY_TYPES } from "./listings-model.js";
import { fmtDate } from "./core-view.js";

export const TIER_LABELS = {
  great_deal: "Great deal",
  good_deal: "Good deal",
  fair_deal: "Fair deal",
  full_price: "Full price",
  unpriced_opportunity: "Unpriced",
};

export const boroughName = (code) => BOROUGHS.find(([c]) => c === code)?.[1] || code || "";

// Listing photos come as small thumbnails; the photo host serves the same image at a larger size.
export const photoAt = (url, width, height) => (/^https:\/\/ap\.rdcpix\.com\/[^?#]+s\.jpg$/.test(url || "") ? url.replace(/s\.jpg$/, `rd-w${width}_h${height}.jpg`) : url);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

const CALLS = { supports_price: "Works at the price", below_price: "Worth less than the price", no_land_value: "No land value" };

// A listing's saved site in one line: that a run is underwriting it now, or when it was underwritten
// (or how far it got), then its call and profit once known. site is a row of the sites list, with its progress.
export function siteSummary(site) {
  const p = site.progress;
  const step = site.step || p.next;
  if (site.running) return step ? `Underwriting now, step ${step} of 4` : "Underwriting now";
  const when = fmtDate(p.underwritten || site.updated);
  const head = p.done === 4 ? `Underwritten ${when}` : p.done ? `Underwriting ${p.done} of 4 steps, ${when}` : `Underwriting started ${when}`;
  const profit = finite(p.profit) ? (p.profit < 0 ? `${fmtCurrency(-p.profit)} loss` : `${fmtCurrency(p.profit)} profit`) : "";
  return [head, p.stale ? "Needs a refresh" : "", CALLS[p.call], profit].filter(Boolean).join(" · ");
}

// Marks a card with its listing's saved site, or clears the mark.
export function showCardSite(card, site) {
  card.querySelector(".listing-card-site")?.remove();
  if (site) card.querySelector(".listing-card-body").append(el("p", "listing-card-site", siteSummary(site)));
}

// rank is the card's number in the results, the number on its map pin.
export function listingCard(raw, { onOpen, site = null, rank = null }) {
  const deal = normalizeDealRow(raw);
  const verdict = verdictMeta(deal.deal_verdict);
  const card = el("article", `listing-card ${verdict.cls}`);
  card.dataset.listing = deal.listing_id;
  if (deal.bbl) card.dataset.bbl = String(deal.bbl);
  card.tabIndex = -1;

  const media = el("div", "listing-card-media");
  // Without a photo the square is a zoning tile; a photo, once it loads, covers it.
  const zoning = el("span", "listing-card-zone");
  zoning.append(el("small", "", "Zoning"), el("strong", "", deal.zoning_district_1 || "Unknown"));
  media.append(zoning);
  if (deal.photoUrl) {
    const img = el("img");
    img.src = photoAt(deal.photoUrl, 480, 360);
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", () => img.remove());
    media.append(img);
  }
  media.append(el("span", `verdict-pill ${verdict.cls}`, TIER_LABELS[deal.deal_verdict] || verdict.label));
  // The programs the value rests on: the MIH option and the 485-x election, in one tag.
  const tags = [mihBadge(deal), taxBadge(deal)].filter(Boolean);
  if (tags.length) {
    const badge = el("span", "listing-card-mih", tags.map((t) => t.text).join(" · "));
    badge.title = tags.map((t) => t.title).join(" ");
    media.append(badge);
  }

  const body = el("div", "listing-card-body");
  const title = el("h3", "listing-card-title");
  const open = el("button", "listing-card-open", deal.address || `BBL ${deal.bbl}`);
  open.type = "button";
  if (rank) {
    const number = el("span", "listing-card-rank", String(rank));
    number.setAttribute("aria-hidden", "true");
    title.append(number);
  }
  title.append(open);
  const type = PROPERTY_TYPES.find(([v]) => v === deal.style)?.[1];
  const place = [deal.neighborhood || boroughName(deal.borough), deal.zip_code].filter(Boolean).join(" ");
  body.append(title, el("p", "listing-card-place", [place, deal.zoning_district_1, type].filter(Boolean).join(" · ")));

  const figures = el("dl", "listing-card-figures");
  const figure = (label, value) => {
    const wrap = el("div");
    wrap.append(el("dt", "", label), el("dd", "", value));
    figures.append(wrap);
  };
  const ppb = pricePerBuildable(deal);
  const far = headroomFar(deal);
  figure("Ask", deal.list_price ? fmtCurrency(deal.list_price) : "Unpriced");
  figure("$/BSF", deal.list_price && finite(ppb) ? `$${fmtInt(ppb)}` : "Unknown");
  figure("Headroom", far !== null ? `+${far.toFixed(2)} FAR` : `+${fmtInt(headroomSqft(deal))} SF`);
  const returns = [finite(deal.implied_cap_rate) ? `${fmtPct(deal.implied_cap_rate)} yield` : "", finite(deal.implied_condo_margin) ? `${fmtPct(deal.implied_condo_margin, 0)} margin` : ""].filter(Boolean);
  figure("Returns", returns.length ? returns.join(", ") : "Not projected");
  body.append(figures);
  const hold = tierHold(deal);
  if (hold) body.append(el("p", "listing-card-hold", hold));

  card.append(media, body);
  showCardSite(card, site);
  open.addEventListener("click", () => onOpen(deal.listing_id));
  // The address button stretches over the card (listings.css), so a click anywhere on it is the button's;
  // this covers the MIH tag, which sits above the button to keep its explanation on hover.
  card.addEventListener("click", (e) => {
    if (e.target !== open && !e.target.closest("a, button")) onOpen(deal.listing_id);
  });
  return card;
}
