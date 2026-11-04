// The deal card: address and district, then ask, headroom and price per buildable SF, the great to
// full price scale with the ask marked, and the projections the store underwrote.
import { normalizeDealRow, buildDealUnderwritePrompt, unitEstimate, listingLink, fmtCurrency, fmtInt, fmtPct, verdictMeta, verdictPricePerBsf, valueDriverLabel } from "./deals.js";
import { finite, headroomFar, headroomSqft, tierHolds } from "./core-model.js";

// A number, or a numeric string the store sent; an empty string is not a price.
export { finite };

// The four price ratings in order, best first. The store also weighs headroom, so a verdict can sit
// below the range the price alone falls in.
const RATINGS = ["great_deal", "good_deal", "fair_deal", "full_price"];
const RANGE_NAMES = ["Great", "Good", "Fair", "Full price"];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

// Why a tier sits below the one its price earns: the tier the price earned, the tier shown and the
// conditions that hold it down, so price appeal and project risk read apart.
export function tierHold(deal) {
  const fv = deal.flashcardValuation || {};
  const holds = tierHolds(fv);
  if (!holds.length) return null;
  const priced = RANGE_NAMES[RATINGS.indexOf(fv.priceVerdict)];
  const held = RANGE_NAMES[RATINGS.indexOf(fv.dealVerdict)];
  if (!held) return null;
  return `${priced ? `Priced ${priced}, held at ${held}` : `Held at ${held}`}: ${holds.join(", ")}`;
}

function figure(label, value, note) {
  const wrap = el("div", "deal-figure");
  const dd = el("dd");
  dd.append(el("strong", "", value));
  if (note) dd.append(el("small", "", note));
  wrap.append(el("dt", "", label), dd);
  return wrap;
}

// Price per buildable SF on the basis the store's scale uses.
export const pricePerBuildable = verdictPricePerBsf;

// The great to full price scale. Where nearby development-site sales set the tier it runs in dollars, at
// the store's shares of what they sold for; otherwise in $/BSF at the reader's costs. The ask sits on a
// track that runs a quarter of the great to full price span past each end, so an ask beyond either
// threshold still shows.
export function dealScale(deal) {
  const fv = deal.flashcardValuation || {};
  const t = fv.dealTierBasis;
  if (t?.basis === "nearby" && t.thresholds && finite(fv.nearbyLand?.value)) return nearbyScale(deal, Number(fv.nearbyLand.value), t.thresholds);
  const { greatDealMaxPricePerBsf, goodDealMaxPricePerBsf, badDealMinPricePerBsf } = deal.slidingScale || {};
  // A tier whose land value is not positive has no threshold: without Great the scale starts at Good.
  const great = finite(greatDealMaxPricePerBsf) ? Number(greatDealMaxPricePerBsf) : null;
  const good = finite(goodDealMaxPricePerBsf) ? Number(goodDealMaxPricePerBsf) : great;
  const full = Number(badDealMinPricePerBsf);
  if (good === null || !finite(badDealMinPricePerBsf) || full <= (great ?? good)) return null;
  const span = full - (great ?? good);
  const lo = (great ?? good) - span / 4;
  const hi = full + span / 4;
  const at = (x) => Math.min(100, Math.max(0, ((x - lo) / (hi - lo)) * 100));
  const scale = el("div", "deal-scale");
  scale.setAttribute("role", "img");
  const track = el("div", "deal-scale-track");
  const zones = [...(great === null ? [] : [["great", lo, great]]), ["good", great ?? lo, good], ["fair", good, full], ["full", full, hi]];
  for (const [name, from, to] of zones) {
    const zone = el("span", `deal-scale-zone zone-${name}`);
    zone.style.left = `${at(from)}%`;
    zone.style.width = `${at(to) - at(from)}%`;
    track.append(zone);
  }
  const ask = pricePerBuildable(deal);
  const [lowName, low] = great === null ? ["good", good] : ["great", great];
  const ends = `${lowName} at $${fmtInt(low)} or less and full price at $${fmtInt(full)} or more per buildable SF`;
  const labels = el("div", "deal-scale-labels");
  labels.setAttribute("aria-hidden", "true");
  labels.append(el("span", "", `${great === null ? "Good" : "Great"} ≤ $${fmtInt(low)}/BSF`), el("span", "", `Full price ≥ $${fmtInt(full)}/BSF`));
  scale.append(track, labels);
  if (finite(ask) && deal.list_price) {
    const price = Number(ask);
    const marker = el("span", "deal-scale-ask");
    marker.style.left = `${at(price).toFixed(1)}%`;
    track.append(marker);
    const verdict = verdictMeta(deal.deal_verdict);
    const rated = verdict.unrated ? "" : `, rated ${verdict.label}`;
    const range = great !== null && price <= great ? 0 : price <= good ? 1 : price <= full ? 2 : 3;
    const rank = RATINGS.indexOf(deal.deal_verdict);
    // Headroom explains the gap only when the price rating is the final one; when a check held the rating
    // down, the hold line names the cause instead.
    const priceVerdict = deal.flashcardValuation?.priceVerdict;
    const held = Boolean(priceVerdict) && priceVerdict !== deal.deal_verdict;
    const why = rank > range && !held && headroomSqft(deal) !== null
      ? `The price is in the ${RANGE_NAMES[range]} range; rated ${verdict.label} because only ${fmtInt(headroomSqft(deal))} SF of buildable area is unused.`
      : "";
    const hold = held ? tierHold(deal) : null;
    scale.setAttribute("aria-label", `Ask $${fmtInt(price)} per buildable SF${rated}, on a scale with ${ends}.${why ? ` ${why}` : ""}${hold ? ` ${hold}.` : ""}`);
    if (why) {
      const note = el("p", "deal-scale-note", why);
      note.setAttribute("aria-hidden", "true");
      scale.append(note);
    }
  } else if (deal.list_price) {
    scale.setAttribute("aria-label", `Ask not placed: the listing is not matched to a parcel. The scale has ${ends}.`);
  } else {
    scale.setAttribute("aria-label", `Unpriced, on a scale with ${ends}.`);
  }
  return scale;
}

// The scale on the nearby basis: Great, Good and Fair at their shares of what nearby development sites
// sold for this lot's floor area, Full price above it, with the ask marked.
function nearbyScale(deal, nearby, thresholds) {
  const great = nearby * thresholds.great_deal, good = nearby * thresholds.good_deal, full = nearby * thresholds.fair_deal;
  const span = full - great, lo = great - span / 4, hi = full + span / 4;
  const at = (x) => Math.min(100, Math.max(0, ((x - lo) / (hi - lo)) * 100));
  const scale = el("div", "deal-scale");
  scale.setAttribute("role", "img");
  const track = el("div", "deal-scale-track");
  for (const [name, from, to] of [["great", lo, great], ["good", great, good], ["fair", good, full], ["full", full, hi]]) {
    const zone = el("span", `deal-scale-zone zone-${name}`);
    zone.style.left = `${at(from)}%`;
    zone.style.width = `${at(to) - at(from)}%`;
    track.append(zone);
  }
  const ends = `great at ${fmtCurrency(great)} or less and full price above ${fmtCurrency(full)}, the land value from nearby sales adjusted to this lot`;
  const labels = el("div", "deal-scale-labels");
  labels.setAttribute("aria-hidden", "true");
  labels.append(el("span", "", `Great ≤ ${fmtCurrency(great)}`), el("span", "", `Full price > ${fmtCurrency(full)}`));
  scale.append(track, labels);
  const ask = Number(deal.list_price);
  if (ask > 0) {
    const marker = el("span", "deal-scale-ask");
    marker.style.left = `${at(ask).toFixed(1)}%`;
    track.append(marker);
    const verdict = verdictMeta(deal.deal_verdict);
    const hold = tierHold(deal);
    scale.setAttribute("aria-label", `Ask ${fmtCurrency(ask)}${verdict.unrated ? "" : `, rated ${verdict.label}`}, on a scale with ${ends}.${hold ? ` ${hold}.` : ""}`);
  } else scale.setAttribute("aria-label", `Unpriced, on a scale with ${ends}.`);
  return scale;
}

// Returns the card element for one store row; its Underwrite button carries the class deal-card-underwrite.
export function dealCard(rawDeal, { dealSettings = {}, onUnderwrite, canStart = () => true } = {}) {
  const deal = normalizeDealRow(rawDeal);
  const verdict = verdictMeta(deal.deal_verdict);
  const card = el("article", `deal-card ${verdict.cls}`);
  card.dataset.dealCard = deal.listing_id;
  // Focusable from script only, so paging can move the reader to the first card of a new page.
  card.setAttribute("tabindex", "-1");

  const head = el("header", "deal-card-head");
  const title = el("div", "deal-card-title");
  const heading = el("h3", "", deal.address || `BBL ${deal.bbl}`);
  heading.id = `deal-card-${deal.listing_id}`;
  card.setAttribute("aria-labelledby", heading.id);
  title.append(heading);
  const place = [deal.neighborhood || deal.borough, deal.zip_code].filter(Boolean).join(" ");
  title.append(el("p", "deal-card-district", [place, deal.zoning_district_1].filter(Boolean).join(" · ")));
  const go = el("button", "home-follow deal-card-underwrite", "Underwrite");
  go.type = "button";
  go.disabled = !canStart();
  go.addEventListener("click", () => onUnderwrite(deal, buildDealUnderwritePrompt(deal, dealSettings)));
  head.append(title, go);

  const figures = el("dl", "deal-figures");
  const ppb = pricePerBuildable(deal);
  const far = headroomFar(deal);
  const unused = headroomSqft(deal);
  const residual = deal.slidingScale?.goodDealMaxLandValue;
  figures.append(
    deal.list_price
      ? figure("Ask", fmtCurrency(deal.list_price), verdict.label)
      : figure("Ask", "Unpriced", finite(residual) ? `Good deal up to ${fmtCurrency(residual)}` : null),
    figure("Headroom", far !== null ? `+${far.toFixed(2)} FAR` : unused !== null ? `+${fmtInt(unused)} SF` : "Unknown", far !== null ? `${fmtInt(unused)} SF unused` : null),
    deal.list_price && finite(ppb)
      ? figure("Price per buildable SF", `$${fmtInt(ppb)}`, unitEstimate(deal).label)
      : deal.list_price
        ? figure("Price per buildable SF", "Unknown", "Not matched to a parcel")
        : figure("Price per buildable SF", "Unpriced", finite(deal.slidingScale?.goodDealMaxPricePerBsf) ? `Good deal up to $${fmtInt(deal.slidingScale.goodDealMaxPricePerBsf)}` : null),
  );
  card.append(head, figures);

  const scale = dealScale(deal);
  if (scale) card.append(scale);

  const projections = el("dl", "deal-projections");
  for (const [label, value] of [["Yield on cost", deal.implied_cap_rate], ["Condo margin", deal.implied_condo_margin]]) {
    if (!finite(value)) continue;
    const item = el("div");
    item.append(el("dt", "", label), el("dd", "", fmtPct(value)));
    projections.append(item);
  }
  const driver = valueDriverLabel(deal.flashcardValuation?.valueDriver);
  if (driver) {
    const item = el("div");
    item.append(el("dt", "", "Value set by"), el("dd", "", driver));
    projections.append(item);
  }
  if (projections.children.length) card.append(projections);
  const hold = tierHold(deal);
  if (hold) card.append(el("p", "deal-card-hold", hold));
  const sourceLink = listingLink(deal);
  if (sourceLink) card.append(sourceLink);
  return card;
}
