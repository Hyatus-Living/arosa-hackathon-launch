// Home's NYC listings: filters over the deal store, a map of the matches beside a ranked page of
// cards, each pin numbered like its card, saved searches, and the listing inspector. The chat sees the
// filters and the open listing, and a deal store search the chat runs becomes the page's filters.
import { apiRequest, verdictThresholds } from "./deals.js";
import { budgetBreakdownSection } from "./budget-splits-form.js";
import { pinRows } from "./listings-map.js";
import { listingCard, showCardSite, TIER_LABELS } from "./listing-card.js";
import { renderInspector } from "./listing-inspector.js";
import { bindFilterPopover } from "./filter-popover.js";
import { skel, listingSkeleton, listingCardSkeletons } from "./skeleton.js";
import { createListingSearchLink, readListingSearchLink, listingSearchState } from "./listing-search-link.js";
import { displayAddress } from "./core-model.js";
import { fetchAddressSuggestions } from "./nyc-address.mjs";
import { linkOrigin } from "./core-route.js";
import { captureListingPage } from "./listing-page-context.js";
import { FILTER_SCHEMA_ID, FILTER_SCHEMA, COST_KEYS, SEARCH_FILTER_KEYS, defaultFilterValues, normalizeCostValue, validateFilterValues, validateFilterSnapshot, acceptsFilterUpdate, listingSnapshotAfterUpdate, listingAreaZips, listingSearchValues, validateSearchState } from "./listing-filter-schema.js";
import {
  BOROUGHS, HEADROOM_STEPS, MIH_AREAS, PAGE_SIZE, PROPERTY_TYPES, SORTS, TIERS,
  defaultFilters, describeFilters, filtersFromSearch, listingsContext, money, queryParams, rangeText,
} from "./listings-model.js";

// What Arosa answers and who it serves, above home's place search. The welcome in index.html carries
// the same line for accounts without listings.

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

// A failure's words, announced as they appear; the Try again button beside them is not part of it.
function alertText(message) {
  const text = el("span", "", message);
  text.setAttribute("role", "alert");
  return text;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function icon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#${name}`);
  svg.append(use);
  return svg;
}
// Three sliders, the filter mark; the shared sprite has no such symbol.
function slidersIcon() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  for (const d of ["M2 4h7M13 4h1M2 8h2M8 8h6M2 12h8M14 12h0", "M11 2.5v3M6 6.5v3M12 10.5v3"]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

const BOROUGH_NAMES = { manhattan: "MN", "new york": "MN", brooklyn: "BK", queens: "QN", bronx: "BX", "the bronx": "BX", "staten island": "SI" };
const ZIP_LIST = /^\d{5}(?:-\d{4})?(?:(?:\s*[,;]\s*|\s+(?:and\s+|or\s+)?)\d{5}(?:-\d{4})?)*$/i;

// What the place search would do with typed text, best reading first: a borough, ZIPs, a zoning
// prefix or a neighborhood narrow the listings; a street address or BBL is underwritten.
export function searchChoices(raw, { underwrite = true } = {}) {
  const text = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!text) return [];
  const code = BOROUGH_NAMES[text.toLowerCase()];
  if (code) return [{ kind: "borough", value: code, kindLabel: "Borough", label: BOROUGHS.find(([id]) => id === code)[1] }];
  if (ZIP_LIST.test(text)) return [{ kind: "area", value: text, kindLabel: "ZIP", label: text }];
  if (/^[RCM]\d[A-Z0-9/-]*$/i.test(text) && text.length <= 30) return [{ kind: "zoning", value: text.toUpperCase(), kindLabel: "Zoning", label: text.toUpperCase() }];
  // Free text reads two ways; one row offers the likelier reading and the other as a quiet choice.
  const addressLike = /^\d{10}$/.test(text) || /^[1-5]\s*[-/]\s*\d{1,5}\s*[-/]\s*\d{1,4}$/.test(text) || /^\d+[A-Z]?(?:-\d+)?\s+[A-Z]/i.test(text);
  // With verified GeoSearch rows on offer, the raw typed text is no longer underwritten as-is.
  if (addressLike && !underwrite) return [{ kind: "area", value: text, label: "Search the area", secondary: true }];
  return addressLike
    ? [{ kind: "underwrite", value: text, label: `Underwrite ${text}` }, { kind: "area", value: text, label: "Search the area", secondary: true }]
    : [{ kind: "area", value: text, label: `Search ${text}` }, { kind: "underwrite", value: text, label: "Underwrite as an address", secondary: true }];
}

// A ZIP added to a ZIP search widens it; any other area replaces the current one.
export function mergeArea(current, next) {
  if (!current || !ZIP_LIST.test(current) || !ZIP_LIST.test(next)) return next;
  return [...new Set([...listingAreaZips(current), ...listingAreaZips(next)])].join(", ");
}

// A deal-store listing as a search suggestion: its address, then where and what it asks.
export function listingMatch(deal) {
  const price = Number(deal.listPrice ?? deal.list_price);
  const ask = price > 0 ? (price >= 1e6 ? `$${(price / 1e6).toFixed(price >= 1e7 ? 1 : 2).replace(/\.?0+$/, "")}M` : `$${Math.round(price / 1e3)}K`) : null;
  return { kind: "listing", value: deal.id, label: deal.address, meta: [deal.neighborhood, deal.zipCode ?? deal.zip_code, ask].filter(Boolean).join(" · ") };
}

// Blank means no limit; callers distinguish invalid text from an empty field.
export function parseAmount(value) {
  const m = /^\$?\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)\s*([km])?$/i.exec(String(value ?? "").trim());
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, "")) * (m[2] ? (m[2].toLowerCase() === "k" ? 1e3 : 1e6) : 1);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// The first hard cost is the rental figure and keeps the legacy key (snapshots and saved links
// carry it); the condo figure rides alongside it to the store query and the saved profile.
const CONDO_HARD_KEY = "condoHardCostPerGrossSqft";
const APPLIED_COST_KEYS = [...new Set([...COST_KEYS, CONDO_HARD_KEY])];
const COSTS = [
  ["hardCostPerGrossSqft", "Rental hard cost, $ per gross SF", 1],
  ["softCostPctOfHard", "Soft cost, % of hard", 100],
  ["carryAndFinancingPct", "Carry and financing, %", 100],
  ["zfaToGrossFactor", "Gross to zoning floor area", 1],
  [CONDO_HARD_KEY, "Condo hard cost, $ per gross SF", 1],
];
const costField = key => FILTER_SCHEMA.properties[key] || FILTER_SCHEMA.properties.hardCostPerGrossSqft;
const normCost = (key, value) => (FILTER_SCHEMA.properties[key] ? normalizeCostValue(key, value) : Math.round(value));

// What the viewer is buying for on a listing page (build new or keep the building), remembered in this
// browser only; private windows and blocked storage fall back to building new.
const GOAL_KEY = "arosa.listing-goal";
let pageGoal = "build";
export function listingGoal() {
  try {
    const saved = localStorage.getItem(GOAL_KEY);
    return saved === "keep" || saved === "build" ? saved : pageGoal;
  } catch { return pageGoal; }
}
export function saveListingGoal(goal) {
  pageGoal = goal === "keep" ? "keep" : "build";
  try { localStorage.setItem(GOAL_KEY, pageGoal); } catch { /* the choice lasts while the page is open */ }
}

// onInspect hears every listing the viewer opens or closes (null), so the page address can follow.
// sites links listings to their saved sites by BBL: get(bbl) answers from the sites list for the cards,
// find(bbl) asks the server for the listing page, and open(site) and regenerate(site) act on one.
const NO_SITES = { get: () => null, find: async () => null, open() {}, regenerate() {} };
export function createListings({ root, canStart, onUnderwrite, onAsk, onInvestigate, onPlan = null, loadMap, settings: bootSettings = null, onInspect = () => {}, sites = NO_SITES, searchUrl = window.location?.href, copyText = text => navigator.clipboard.writeText(text) }) {
  let sharedSearch = null, invalidSearchLink = false;
  if (searchUrl) {
    try { sharedSearch = readListingSearchLink(searchUrl); }
    catch { invalidSearchLink = true; }
  }
  let section = null;
  let filters = sharedSearch ? Object.fromEntries(SEARCH_FILTER_KEYS.map(key => [key, sharedSearch.values[key]])) : defaultFilters();
  let previous = null;
  let priorFilterState = null;
  let filterRevision = 0;
  // A shared search carries its condo hard cost beside the legacy (rental) figure; a link from before
  // that carries the rental figure only, which priced both exits when shared.
  let costs = sharedSearch ? {...Object.fromEntries(COST_KEYS.map(key => [key, sharedSearch.values[key]])), rentalHardCostPerGrossSqft: sharedSearch.values.hardCostPerGrossSqft, [CONDO_HARD_KEY]: sharedSearch.condoHardCostPerGrossSqft ?? sharedSearch.values.hardCostPerGrossSqft} : null;
  let costDraft = null;
  let costDraftVersion = 0;
  let resultSettings = null;
  let profilePending = false;
  let profileDraftVersion = 0;
  let pageStatus = "loading";
  let pageRows = [];
  let costNotice = "";
  let costError = "";
  let costFormError = null;
  let settings = { dealSettings: {}, isCustom: false };
  let deals = [];
  let total = 0;
  let offset = 0;
  let bounds = sharedSearch?.bounds ?? null;
  let follow = sharedSearch?.values.followMap ?? true;
  let selected = null;
  let inspectedId = null;
  let selectedSettings = null;
  // The house costs and the reader's saved costs behind the open listing, so its page can say which each cost is.
  let selectedCostBasis = null;
  let map = null;
  let mapLoading = null;
  let mapMoves = 0;
  // Each mapped listing's card number, and the listing opened last, whose card stays marked.
  let pinRanks = new Map();
  let picked = null;
  let pageLoad = 0;
  let pinLoad = 0;
  let detailLoad = 0;
  const parts = {};
  const filterDrafts = [];
  const costsReady = () => APPLIED_COST_KEYS.every(key => Number.isFinite(costs?.[key]));
  // Deal settings may carry the split keys, only the legacy one, or both: the rental figure is the
  // legacy/rental value and the condo figure falls back to it, as pre-split accounts priced both.
  const pickCosts = values => {
    const picked = Object.fromEntries(COST_KEYS.filter(key => Number.isFinite(values[key])).map(key => [key, normalizeCostValue(key, values[key])]));
    const rental = values.hardCostPerGrossSqft ?? values.rentalHardCostPerGrossSqft;
    if (Number.isFinite(rental)) picked.hardCostPerGrossSqft = normCost("hardCostPerGrossSqft", rental);
    const condo = values[CONDO_HARD_KEY] ?? picked.hardCostPerGrossSqft;
    if (Number.isFinite(condo)) picked[CONDO_HARD_KEY] = normCost(CONDO_HARD_KEY, condo);
    if (Number.isFinite(picked.hardCostPerGrossSqft)) picked.rentalHardCostPerGrossSqft = picked.hardCostPerGrossSqft;
    return picked;
  };
  // The account's settings from boot price the first pins, so they load beside the first page.
  if (bootSettings && !costs) { settings = bootSettings; costs = pickCosts(bootSettings.dealSettings); }
  function clearChatUndo() {
    previous = null; priorFilterState = null;
    parts.receipt.querySelector('[data-filter-action="undo"]')?.remove();
    if (!parts.receipt.querySelector('[data-filter-action="apply"]')) parts.receipt.hidden = true;
  }
  function showChatFilterFeedback(message) {
    const undo = !parts.receipt.hidden && (previous || priorFilterState) ? parts.receipt.querySelector('[data-filter-action="undo"]') : null;
    parts.receipt.replaceChildren(el("span", "", message), ...(undo ? [undo] : []));
    parts.receipt.hidden = false;
  }

  // Filter controls
  function select(label, options, value, onChange) {
    const wrap = el("label", "listings-control");
    wrap.append(el("span", "sr-only", label));
    const node = el("select");
    for (const [v, text] of options) {
      const o = el("option", "", text);
      o.value = v;
      node.append(o);
    }
    const set = (v) => {
      if (label === "FAR headroom" && v && ![...node.querySelectorAll("option")].some(o => o.value === v)) {
        const option = el("option", "", `+${v} FAR or more`); option.value = v; node.append(option);
      }
      for (const o of node.querySelectorAll("option")) o.selected = o.value === v;
    };
    set(value);
    node.addEventListener("change", () => onChange(node.value));
    wrap.append(node);
    return { wrap, set };
  }

  function popover(name) {
    const pop = el("details", "listings-pop");
    const summary = el("summary", "", name);
    const body = el("div", "listings-pop-body");
    pop.append(summary, body);
    bindFilterPopover(pop, body);
    pop.addEventListener("toggle", () => {
      if (!pop.open) return;
      for (const other of section.querySelectorAll(".listings-pop[open]")) if (other !== pop) other.open = false;
    });
    return { pop, summary, body };
  }

  function rangeInputs(body, labels, read, write) {
    const inputs = labels.map((text) => {
      const wrap = el("label", "listings-field");
      const input = el("input");
      input.type = "text";
      input.inputMode = "decimal";
      input.autocomplete = "off";
      wrap.append(el("span", "", text), input);
      body.append(wrap);
      return input;
    });
    let dirty = false, applied = JSON.stringify(read());
    filterDrafts.push(() => dirty);
    const feedback = filterFeedback(body, inputs, labels[0].toLowerCase().replace(/[^a-z0-9]+/g, "-"));
    const sync = (resetDraft = false) => {
      const values = read(), current = JSON.stringify(values);
      if (resetDraft || current !== applied) {dirty = false;feedback("");}
      if (!dirty) values.forEach((value, index) => {inputs[index].value = String(value ?? "");});
      applied = current;
    };
    for (const input of inputs) {
      input.addEventListener("input", () => {dirty = true;parts.syncClear();});
      input.addEventListener("change", () => {
        dirty = true;
        const values = inputs.map(node => parseAmount(node.value));
        const invalid = inputs.findIndex((node, index) => node.value.trim() && values[index] === null);
        const problem = invalid >= 0 ? `${labels[invalid]}: enter a number such as 2500 or 2.5k.` : write(values);
        if (problem) feedback(problem);
        else sync(true);
        parts.syncClear();
      });
    }
    return sync;
  }

  // A filter can show in both a quick panel and the drawer, so each notice gets its own id.
  let feedbackCount = 0;
  function filterFeedback(parent, inputs, key) {
    const note = el("p", "listings-filter-error");note.id = `listing-filter-error-${key}-${++feedbackCount}`;note.setAttribute("role", "alert");note.hidden = true;
    parent.append(note);
    for (const input of inputs) input.setAttribute("aria-describedby", note.id);
    return message => {
      note.textContent = message ? `${message} Your previous filters still apply.` : "";note.hidden = !message;
      for (const input of inputs) {
        if (message) input.setAttribute("aria-invalid", "true");
        else input.removeAttribute("aria-invalid");
      }
    };
  }

  function textFilter(wrap, input, key, normalize) {
    let dirty = false, applied = filters[key], timer;
    filterDrafts.push(() => dirty);
    input.setAttribute("aria-label", wrap.querySelector(".sr-only").textContent);
    const feedback = filterFeedback(wrap, [input], key);
    const sync = (resetDraft = false) => {
      if (resetDraft || filters[key] !== applied) {dirty = false;clearTimeout(timer);feedback("");}
      if (!dirty) input.value = filters[key];
      applied = filters[key];
    };
    input.addEventListener("input", () => {
      dirty = true;clearTimeout(timer);parts.syncClear();
      timer = setTimeout(() => {
        const problem = change({[key]: normalize(input.value)});
        if (problem) feedback(problem);
        else sync(true);
        parts.syncClear();
      }, 350);
    });
    return sync;
  }

  function checks(body, options, read, write) {
    const boxes = options.map(([value, text]) => {
      const wrap = el("label", "listings-check");
      const box = el("input");
      box.type = "checkbox";
      box.value = value;
      wrap.append(box, el("span", "", text));
      body.append(wrap);
      return box;
    });
    const sync = () => boxes.forEach((b) => (b.checked = read().includes(b.value)));
    for (const box of boxes) box.addEventListener("change", () => write(boxes.filter((b) => b.checked).map((b) => b.value)));
    return sync;
  }

  function radioGroup(body, name, options, read, write) {
    const radios = options.map(([value, text]) => {
      const wrap = el("label", "listings-check");
      const radio = el("input");
      radio.type = "radio";
      radio.name = name;
      radio.value = value;
      wrap.append(radio, el("span", "", text));
      body.append(wrap);
      return radio;
    });
    const sync = () => radios.forEach((r) => (r.checked = r.value === read()));
    for (const radio of radios) radio.addEventListener("change", () => { if (radio.checked) write(radio.value); });
    return sync;
  }

  // One field for place: a borough, ZIPs or a neighborhood and a zoning prefix become removable
  // tokens, and an address or BBL starts underwriting through home's address entry.
  function renderFind(syncs) {
    const wrap = el("div", "listings-find");
    const field = el("div", "listings-find-field");
    const tokens = el("div", "listings-find-tokens");
    const input = el("input");
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", "Search an area, ZIP, zoning district, address or BBL");
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    const list = el("ul", "listings-find-options");
    list.id = "listings-find-options";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Search suggestions");
    list.hidden = true;
    input.setAttribute("aria-controls", list.id);
    const note = el("p", "listings-filter-error");
    note.id = "listings-find-note";
    note.setAttribute("role", "alert");
    note.hidden = true;
    input.setAttribute("aria-describedby", note.id);
    field.append(icon("search"), tokens, input);
    field.addEventListener("click", (e) => { if (e.target === field || e.target === tokens) input.focus(); });
    wrap.append(field, list, note);

    let choices = [], active = 0, matches = [], addressPicks = [], lookupTimer = null, lookupSeq = 0, addressTimer = null, addressSeq = 0, addressController = null;
    // Listings whose address starts with the typed text come first, so a known listing opens directly.
    const lookupListings = (text) => {
      clearTimeout(lookupTimer);
      const seq = ++lookupSeq;
      if (text.length < 3 || !["underwrite", "area"].includes(searchChoices(text)[0]?.kind)) return;
      lookupTimer = setTimeout(async () => {
        const query = new URLSearchParams({ area: text, minUnusedZfa: "0", limit: "5", includeSimilarComps: "false" });
        const data = await apiRequest(`/market-store/deals?${query}`).catch(() => null);
        if (seq !== lookupSeq || input.value.trim().replace(/\s+/g, " ") !== text || !data?.deals?.length) return;
        matches = data.deals.map(listingMatch);
        if (!list.hidden) open();
      }, 200);
    };
    // Any New York City address can be underwritten, not only one with a listing for sale:
    // the city address directory resolves the typed text to a real parcel first.
    const lookupAddresses = (text) => {
      clearTimeout(addressTimer);
      addressController?.abort();
      const seq = ++addressSeq;
      if (text.length < 3) { addressPicks = []; return; }
      addressTimer = setTimeout(async () => {
        addressController = new AbortController();
        const found = await fetchAddressSuggestions(text, { signal: addressController.signal }).catch(() => null);
        if (seq !== addressSeq || input.value.trim().replace(/\s+/g, " ") !== text || !found) return;
        addressPicks = found.map(s => ({ kind: "address", value: s.label, kindLabel: "Underwrite", label: s.label }));
        if (!list.hidden) open();
      }, 200);
    };
    const say = (message) => { note.textContent = message; note.hidden = !message; };
    const mark = () => {
      list.querySelectorAll('[role="option"]').forEach((item, index) => item.setAttribute("aria-selected", String(index === active)));
      if (choices.length && !list.hidden) input.setAttribute("aria-activedescendant", `listings-find-option-${active}`);
      else input.removeAttribute("aria-activedescendant");
    };
    const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); mark(); };
    const open = () => {
      choices = [...matches, ...addressPicks, ...searchChoices(input.value, { underwrite: !addressPicks.length })];
      active = 0;
      const listingRows = matches.map((choice, index) => {
        const item = el("li", "listings-find-row");
        item.setAttribute("role", "presentation");
        const option = el("div", "listings-find-option is-listing");
        option.id = `listings-find-option-${index}`;
        option.setAttribute("role", "option");
        option.append(el("span", "listings-find-kind", "Listing"), el("span", "listings-find-label", choice.label));
        if (choice.meta) option.append(el("span", "listings-find-meta", choice.meta));
        option.addEventListener("pointerdown", (e) => e.preventDefault());
        option.addEventListener("click", () => pick(choice));
        item.append(option);
        return item;
      });
      // One row per typed place: its main choice, and any second reading beside it.
      const row = el("li", "listings-find-row");
      row.setAttribute("role", "presentation");
      choices.slice(matches.length).forEach((choice, at) => {
        const index = matches.length + at;
        const option = el("div", `listings-find-option is-${choice.kind}${choice.secondary ? " is-secondary" : ""}`);
        option.id = `listings-find-option-${index}`;
        option.setAttribute("role", "option");
        if (choice.kindLabel) option.append(el("span", "listings-find-kind", choice.kindLabel));
        option.append(el("span", "listings-find-label", choice.label));
        option.addEventListener("pointerdown", (e) => e.preventDefault());
        option.addEventListener("click", () => pick(choice));
        row.append(option);
      });
      list.replaceChildren(...listingRows, ...(choices.length > matches.length ? [row] : []));
      list.hidden = !choices.length;
      input.setAttribute("aria-expanded", String(!list.hidden));
      mark();
    };
    function pick(choice) {
      let problem = null;
      if (choice.kind === "listing") {
        input.value = "";
        matches = [];
        addressPicks = [];
        close();
        void openListing(choice.value);
        return;
      }
      if (choice.kind === "underwrite" || choice.kind === "address") {
        const form = parts.address.querySelector("form.home-address");
        if (!form || form.querySelector('[type="submit"]').disabled) problem = "You can't start a new site right now.";
        else {
          form.querySelector('input[name="address"]').value = choice.value;
          form.requestSubmit();
        }
      } else {
        problem = change({ [choice.kind]: choice.kind === "area" ? mergeArea(filters.area, choice.value) : choice.value });
      }
      say(problem || "");
      if (!problem) { input.value = ""; matches = []; addressPicks = []; close(); }
    }
    input.addEventListener("input", () => { say(""); matches = []; addressPicks = []; open(); const typed = input.value.trim().replace(/\s+/g, " "); lookupListings(typed); lookupAddresses(typed); });
    input.addEventListener("blur", close);
    input.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && choices.length) {
        e.preventDefault();
        if (list.hidden) open();
        else active = (active + (e.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length;
        mark();
      } else if (e.key === "Enter" && choices.length && !list.hidden) {
        e.preventDefault();
        pick(choices[active]);
      } else if (e.key === "Escape" && !list.hidden) {
        e.preventDefault();
        close();
      } else if (e.key === "Backspace" && !input.value) {
        tokens.lastElementChild?.click();
      }
    });
    syncs.push(() => {
      const set = [
        filters.borough && ["borough", BOROUGHS.find(([id]) => id === filters.borough)[1]],
        filters.area && ["area", ZIP_LIST.test(filters.area) ? `ZIP ${filters.area}` : filters.area],
        filters.zoning && ["zoning", `Zoning ${filters.zoning}`],
      ].filter(Boolean);
      tokens.replaceChildren(...set.map(([key, text]) => {
        const token = el("button", "listings-token");
        token.type = "button";
        token.setAttribute("aria-label", `Remove ${text}`);
        token.append(el("span", "", text), icon("close"));
        token.addEventListener("click", () => { change({ [key]: "" }); input.focus(); });
        return token;
      }));
      input.placeholder = set.length ? "Add an area, zoning or address" : "Area, ZIP, zoning, address or BBL";
    });
    return wrap;
  }

  // The four screens people run most sit in the row; every filter, location included, is in the
  // drawer. Both write the same filter state and apply at once, so the map and count follow live.
  function renderFilters() {
    const bar = el("div", "listings-filters");
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Filters");
    const syncs = [];
    parts.find = renderFind(syncs);

    const priceText = () => [rangeText(filters.minPrice, filters.maxPrice, money), filters.maxPpb !== null ? `up to $${filters.maxPpb}/BSF` : ""].filter(Boolean).join(", ");
    const tierText = () => filters.tiers.map((t) => TIERS.find(([v]) => v === t)[1]).join(", ");
    const typeText = () => filters.types.length === 1 ? PROPERTY_TYPES.find(([v]) => v === filters.types[0])[1] : filters.types.length ? `${filters.types.length} types` : "";
    const priceFields = ["Minimum ask", "Maximum ask", "Maximum $ per buildable SF"];
    const readPrice = () => [filters.minPrice, filters.maxPrice, filters.maxPpb];
    const writePrice = ([minPrice, maxPrice, maxPpb]) => change({ minPrice, maxPrice, maxPpb });

    const price = popover("Price");
    syncs.push(rangeInputs(price.body, priceFields, readPrice, writePrice));
    syncs.push(() => setSummary(price, "Price", priceText()));

    const tier = popover("Deal tier");
    syncs.push(checks(tier.body, TIERS, () => filters.tiers, (tiers) => change({ tiers })));
    syncs.push(() => setSummary(tier, "Deal tier", tierText()));

    const headroom = popover("Headroom");
    const readFar = () => filters.minFar !== null ? String(filters.minFar) : "";
    const writeFar = (v) => change({ minFar: v ? Number(v) : null });
    syncs.push(radioGroup(headroom.body, "listing-headroom", [["", "Any headroom"], ...HEADROOM_STEPS.map((n) => [String(n), `+${n} FAR or more`])], readFar, writeFar));
    syncs.push(() => setSummary(headroom, "Headroom", filters.minFar !== null ? `+${filters.minFar} FAR` : ""));

    const type = popover("Property type");
    syncs.push(checks(type.body, PROPERTY_TYPES, () => filters.types, (types) => change({ types })));
    syncs.push(() => setSummary(type, "Property type", typeText()));

    const all = el("button", "listings-all");
    all.type = "button";
    all.setAttribute("aria-haspopup", "dialog");
    const count = el("span", "listings-all-count");
    all.append(slidersIcon(), el("span", "", "All filters"), count);
    syncs.push(() => {
      const defaults = defaultFilters(), set = SEARCH_FILTER_KEYS.filter((key) => key !== "sortBy" && JSON.stringify(filters[key]) !== JSON.stringify(defaults[key])).length;
      count.textContent = set ? String(set) : "";
      count.hidden = !set;
      all.setAttribute("aria-label", set ? `All filters, ${set} set` : "All filters");
    });

    const clear = el("button", "listings-clear", "Clear filters");
    clear.type = "button";
    clear.addEventListener("click", () => change(defaultFilters(), { replace: true }));
    parts.syncClear = () => {clear.hidden = JSON.stringify(filters) === JSON.stringify(defaultFilters()) && !filterDrafts.some(read => read());};
    syncs.push(parts.syncClear);

    const cost = popover("Costs");
    cost.pop.classList.add("listings-cost-pop");
    cost.pop.addEventListener("toggle", () => section.classList.toggle("is-costs-open", cost.pop.open));
    parts.costPop = cost;
    renderCosts(cost.body);

    const drawer = renderDrawer(syncs, { priceFields, readPrice, writePrice, readFar, writeFar });
    all.addEventListener("click", () => {
      for (const pop of section.querySelectorAll(".listings-pop[open]")) pop.open = false;
      drawer.showModal();
      void parts.loadSaved();
    });

    const sort = select("Sort", SORTS, filters.sortBy, (v) => change({ sortBy: v }));
    sort.wrap.className = "listings-sort";
    // The word "Sort" shows beside the order on wide screens; the hidden label names it everywhere.
    const sortWord = el("span", "listings-sort-label", "Sort");
    sortWord.setAttribute("aria-hidden", "true");
    sort.wrap.querySelector(".sr-only").after(sortWord);
    syncs.push(() => sort.set(filters.sortBy));
    parts.sort = sort.wrap;

    bar.append(price.pop, tier.pop, headroom.pop, type.pop, el("span", "listings-filters-rule"), all, clear, cost.pop, drawer);
    parts.syncFilters = (resetDrafts = false) => syncs.forEach((sync) => sync(resetDrafts));
    return bar;
  }

  function renderDrawer(syncs, { priceFields, readPrice, writePrice, readFar, writeFar }) {
    const drawer = el("dialog", "listings-drawer");
    drawer.setAttribute("aria-labelledby", "listings-drawer-title");
    const panel = el("div", "listings-drawer-panel");
    const head = el("header", "listings-drawer-head");
    const title = el("h2", "", "All filters");
    title.id = "listings-drawer-title";
    const close = el("button", "icon-button listings-drawer-close");
    close.type = "button";
    close.setAttribute("aria-label", "Close filters");
    close.append(icon("close"));
    close.addEventListener("click", () => drawer.close());
    head.append(title, close);
    const body = el("div", "listings-drawer-body");
    const group = (name) => {
      const node = el("section", "listings-drawer-group");
      node.append(el("h3", "", name));
      body.append(node);
      return node;
    };

    body.append(renderSaved(drawer));
    const place = group("Location");
    const borough = select("Borough", [["", "All boroughs"], ...BOROUGHS], filters.borough, (v) => change({ borough: v }));
    syncs.push(() => borough.set(filters.borough));
    const text = (label, key, placeholder, normalize) => {
      const wrap = el("label", "listings-control listings-drawer-text");
      wrap.append(el("span", "sr-only", label));
      const input = el("input");
      input.type = "search";
      input.placeholder = placeholder;
      input.autocomplete = "off";
      wrap.append(input);
      syncs.push(textFilter(wrap, input, key, normalize));
      return wrap;
    };
    place.append(borough.wrap, text("ZIP or neighborhood", "area", "ZIP or neighborhood", (v) => v.trim()), text("Zoning district", "zoning", "Zoning district, such as R6", (v) => v.trim().toUpperCase()));

    const value = group("Price and value");
    const priceGrid = el("div", "listings-drawer-grid");
    value.append(priceGrid);
    syncs.push(rangeInputs(priceGrid, priceFields, readPrice, writePrice));
    // Project cost: the ask plus the estimated construction cost at your costs; a listing with no ask
    // is figured at its good-deal land threshold.
    const costGrid = el("div", "listings-drawer-grid");
    value.append(costGrid);
    syncs.push(rangeInputs(costGrid, ["Minimum project cost", "Maximum project cost"], () => [filters.minProjectCost, filters.maxProjectCost], ([minProjectCost, maxProjectCost]) => change({ minProjectCost, maxProjectCost })));

    const tiers = el("div", "listings-chips");
    group("Deal tier").append(tiers);
    syncs.push(checks(tiers, TIERS, () => filters.tiers, (next) => change({ tiers: next })));

    const site = group("Site");
    const lotGrid = el("div", "listings-drawer-grid");
    site.append(lotGrid);
    syncs.push(rangeInputs(lotGrid, ["Minimum lot, SF", "Maximum lot, SF"], () => [filters.minLot, filters.maxLot], ([minLot, maxLot]) => change({ minLot, maxLot })));
    const dimensionGrid = el("div", "listings-drawer-grid");
    site.append(dimensionGrid);
    syncs.push(rangeInputs(dimensionGrid, ["Minimum width, ft", "Maximum width, ft"], () => [filters.minWidth, filters.maxWidth], ([minWidth, maxWidth]) => change({ minWidth, maxWidth })));
    const depthGrid = el("div", "listings-drawer-grid");
    site.append(depthGrid);
    syncs.push(rangeInputs(depthGrid, ["Minimum depth, ft", "Maximum depth, ft"], () => [filters.minDepth, filters.maxDepth], ([minDepth, maxDepth]) => change({ minDepth, maxDepth })));
    const buildableGrid = el("div", "listings-drawer-grid");
    site.append(buildableGrid);
    syncs.push(rangeInputs(buildableGrid, ["Minimum buildable, SF"], () => [filters.minBuildable], ([minBuildable]) => change({ minBuildable })));
    const far = select("FAR headroom", [["", "Any FAR headroom"], ...HEADROOM_STEPS.map((n) => [String(n), `+${n} FAR or more`])], readFar(), writeFar);
    syncs.push(() => far.set(readFar()));
    const mih = select("Mandatory Inclusionary Housing areas", MIH_AREAS, filters.mih, (v) => change({ mih: v }));
    syncs.push(() => mih.set(filters.mih));
    site.append(far.wrap, mih.wrap);

    const types = el("div", "listings-chips");
    group("Property type").append(types);
    syncs.push(checks(types, PROPERTY_TYPES, () => filters.types, (next) => change({ types: next })));

    syncs.push(checks(group("Exclude"), [["excludeRisk", "Rent-stabilization risk (6 or more units built before 1974)"], ["excludeLandmarks", "Landmarks and historic districts"]],
      () => ["excludeRisk", "excludeLandmarks"].filter((k) => filters[k]),
      (on) => change({ excludeRisk: on.includes("excludeRisk"), excludeLandmarks: on.includes("excludeLandmarks") })));

    // Filters apply as they change, so the footer reports the live count and only closes the drawer.
    const foot = el("footer", "listings-drawer-foot");
    const reset = el("button", "listings-drawer-reset", "Clear all");
    reset.type = "button";
    reset.addEventListener("click", () => change(defaultFilters(), { replace: true }));
    const count = el("p", "listings-drawer-count");
    count.setAttribute("aria-live", "polite");
    const done = el("button", "home-follow primary listings-drawer-done", "Done");
    done.type = "button";
    done.addEventListener("click", () => drawer.close());
    parts.drawerCount = count;
    foot.append(reset, count, done);

    panel.append(head, body, foot);
    drawer.append(panel);
    // A click on the backdrop lands on the dialog itself, outside the panel.
    drawer.addEventListener("click", (e) => { if (e.target === drawer) drawer.close(); });
    return drawer;
  }

  // Searches the reader keeps by name: Save search keeps the applied filters, map area and costs, a
  // saved name applies all of them again, and each can be renamed or deleted.
  function renderSaved(drawer) {
    const node = el("section", "listings-drawer-group listings-saved");
    node.append(el("h3", "", "Saved searches"));
    // Naming a search is not a filter edit, so it leaves the page's filter state alone.
    node.addEventListener("input", (e) => e.stopPropagation());
    const form = el("form", "listings-save");
    const label = el("label", "listings-control listings-drawer-text");
    const input = el("input");
    input.type = "text"; input.maxLength = 80; input.autocomplete = "off"; input.placeholder = "Name this search";
    label.append(el("span", "sr-only", "Name this search"), input);
    const save = el("button", "home-follow", "Save search"); save.type = "submit";
    form.append(label, save);
    const note = el("p", "listings-saved-note"); note.setAttribute("role", "status");
    const empty = el("p", "listings-saved-empty", "No saved searches yet.");
    const list = el("ul", "listings-saved-list");
    node.append(form, note, empty, list);
    let searches = [];
    const say = (message) => { note.textContent = message; };
    const send = (path, method, payload) => apiRequest(`/market-store/saved-searches${path}`, { method, ...(payload ? { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) } : {}) });
    const draw = () => {
      empty.hidden = searches.length > 0;
      list.replaceChildren(...searches.map((item) => {
        const row = el("li", "listings-saved-item");
        const apply = el("button", "listings-saved-apply", item.name); apply.type = "button";
        apply.addEventListener("click", () => { drawer.close(); applySavedSearch(item); });
        const shown = [...describeFilters(item.search.values), ...(item.search.bounds ? ["selected map area"] : [])];
        const rename = el("button", "listings-saved-action", "Rename"); rename.type = "button";
        rename.setAttribute("aria-label", `Rename ${item.name}`);
        rename.addEventListener("click", () => renameRow(row, item));
        const remove = el("button", "listings-saved-action", "Delete"); remove.type = "button";
        remove.setAttribute("aria-label", `Delete ${item.name}`);
        remove.addEventListener("click", async () => {
          try { await send(`/${encodeURIComponent(item.id)}`, "DELETE"); }
          catch (error) { say(error.message); return; }
          searches = searches.filter((other) => other.id !== item.id); draw(); say(`Deleted ${item.name}.`);
        });
        row.append(apply, el("span", "listings-saved-detail", shown.join(", ") || "All NYC listings"), rename, remove);
        return row;
      }));
    };
    function renameRow(row, item) {
      const edit = el("form", "listings-saved-rename");
      const field = el("input"); field.type = "text"; field.maxLength = 80; field.value = item.name;
      field.setAttribute("aria-label", `New name for ${item.name}`);
      const ok = el("button", "listings-saved-action", "Save"); ok.type = "submit";
      const cancel = el("button", "listings-saved-action", "Cancel"); cancel.type = "button";
      cancel.addEventListener("click", draw);
      edit.addEventListener("submit", async (e) => {
        e.preventDefault();
        let renamed;
        try { renamed = await send(`/${encodeURIComponent(item.id)}`, "PATCH", { name: field.value }); }
        catch (error) { say(error.message); return; }
        searches = searches.map((other) => other.id === item.id ? renamed : other); draw(); say(`Renamed ${renamed.name}.`);
      });
      edit.append(field, ok, cancel);
      row.replaceChildren(edit);
      field.focus();
    }
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      let saved;
      try {
        const search = { ...listingSearchState(filterSnapshot()), condoHardCostPerGrossSqft: costs[CONDO_HARD_KEY] };
        saved = await send("", "POST", { name: input.value, search });
      } catch (error) { say(error.message); return; }
      searches = [...searches, saved]; input.value = ""; draw(); say(`Saved ${saved.name}.`);
    });
    parts.loadSaved = async () => {
      try { searches = (await send("", "GET")).searches; }
      catch (error) { say(error.message); return; }
      draw();
    };
    draw();
    return node;
  }

  function syncDrawerCount() {
    if (!parts.drawerCount) return;
    parts.drawerCount.textContent = pageStatus === "loading" ? "Updating…" : pageStatus === "error" ? "" : total ? `${total.toLocaleString("en-US")} ${total === 1 ? "listing" : "listings"}` : "No matches";
  }

  function setSummary({ summary, pop }, name, value) {
    summary.textContent = value ? `${name}: ${value}` : name;
    pop.classList.toggle("is-set", Boolean(value));
  }

  // Cost assumptions apply as each field changes, like the filters; saving makes them the reader's own.
  function renderCosts(body) {
    body.classList.add("listings-costs");
    const form = el("form");
    form.noValidate = true;
    const inputs = {};
    // The draft version a change asked to apply while a save was running, if any.
    let applyAfterSave = null;
    for (const [key, label, scale] of COSTS) {
      const wrap = el("label", "listings-field");
      const input = el("input");
      input.type = "number";
      input.id = `listing-cost-${key}`;
      input.required = true;
      input.setAttribute("aria-describedby", "listing-cost-note");
      input.step = "any";
      input.min = String(costField(key).minimum * scale);
      input.max = String(costField(key).maximum * scale);
      input.addEventListener("input", () => {
        costDraft = {...costDraft, [key]: input.value};
        costDraftVersion++;
        costError = ""; costNotice = "";
        input.removeAttribute("aria-invalid");
        if (costFormError?.key === key) costFormError = null;
        parts.syncCosts();
      });
      input.addEventListener("change", () => apply({focus: false}));
      inputs[key] = input;
      // The field's shape holds its place until the first results bring the values.
      wrap.append(el("span", "", label), input, skel("skel-field"));
      form.append(wrap);
    }
    const note = el("p", "listings-costs-note");
    note.id = "listing-cost-note";
    note.setAttribute("role", "status");
    const row = el("div", "listings-costs-actions");
    const save = el("button", "home-follow primary", "Save as my costs");
    save.type = "button";
    const reset = el("button", "listings-costs-reset", "Reset to house costs");
    reset.type = "button";
    row.append(save, reset);
    form.append(note, row);
    body.append(form, budgetBreakdownSection({ request: apiRequest, idPrefix: "listing-budget" }));
    const read = ({focus = true} = {}) => {
      const values = {};
      for (const [key, label, scale] of COSTS) {
        const input = inputs[key], value = Number(input.value) / scale, field = costField(key);
        if (!input.value.trim() || !Number.isFinite(value) || value < field.minimum || value > field.maximum) {
          input.setAttribute("aria-invalid", "true");
          costFormError = {key, message: `${label}: enter a number from ${field.minimum * scale} to ${field.maximum * scale}.`};
          parts.syncCosts(); if (focus) input.focus(); return null;
        }
        values[key] = normCost(key, value);
        input.removeAttribute("aria-invalid");
      }
      values.rentalHardCostPerGrossSqft = values.hardCostPerGrossSqft;
      costFormError = null;
      return values;
    };
    // Applies the typed values to the results; a change made while saving applies once the save ends.
    function apply({focus = true} = {}) {
      if (profilePending) { applyAfterSave = costDraft ? costDraftVersion : null; return; }
      if (!costsReady() || !costDraft) return;
      const next = read({focus}); if (!next) return;
      if (APPLIED_COST_KEYS.every(key => next[key] === costs[key])) { costDraft = null; costDraftVersion++; parts.syncCosts(); return; }
      clearChatUndo();
      costs = next;
      costDraft = null; costDraftVersion++;
      costError = ""; costNotice = "";
      filterRevision++;
      parts.syncCosts();
      refresh();
    }
    const describe = ({draftChanged, unsaved}) => {
      if (profilePending) return `Saving…${costDraftVersion !== profileDraftVersion ? " Newer edits are kept." : ""}`;
      if (costFormError) return costFormError.message;
      if (costError) return costError;
      if (costNotice && pageStatus === "loading") return `${costNotice} Updating results…`;
      if (costNotice) return costNotice;
      if (draftChanged) return "Not applied yet.";
      if (unsaved) return "Not saved. These costs apply to this search only.";
      return settings.isCustom ? "Your saved costs." : "House costs.";
    };
    let chipValue = null;
    parts.syncCosts = ({restoreDraft = false} = {}) => {
      parts.share.disabled = !costsReady();
      const shown = { ...settings.dealSettings, ...(costs || {}) };
      for (const [key, , scale] of COSTS) {
        const drafted = costDraft && Object.hasOwn(costDraft, key);
        if (drafted && !restoreDraft) continue;
        const value = drafted ? costDraft[key] : Number.isFinite(shown[key]) ? String(Number((shown[key] * scale).toFixed(3))) : "";
        if (inputs[key].value !== value) inputs[key].value = value;
        if (!drafted) inputs[key].removeAttribute("aria-invalid");
      }
      // Before the first results there are no values: their shape shows while the page loads, and
      // only the reason shows when it failed.
      const waiting = !costsReady() && !costDraft, loading = waiting && pageStatus !== "error";
      form.classList.toggle("is-loading", waiting);
      form.classList.toggle("is-unavailable", waiting && !loading);
      form.setAttribute("aria-busy", String(loading));
      const draftChanged = COSTS.some(([key, , scale]) => costDraft && Object.hasOwn(costDraft, key) && (!costDraft[key].trim() || Number(costDraft[key]) / scale !== costs?.[key]));
      const savedCosts = pickCosts(settings.dealSettings);
      const unsaved = costsReady() && APPLIED_COST_KEYS.some(key => costs[key] !== savedCosts[key]);
      // The chip always reads "Costs" and the hard cost the results on screen use; a placeholder holds
      // the value's place until the first results arrive.
      const displayed = selectedSettings || resultSettings;
      const rentalShown = displayed?.rentalHardCostPerGrossSqft ?? displayed?.hardCostPerGrossSqft;
      const condoShown = displayed?.[CONDO_HARD_KEY] ?? rentalShown;
      const value = Number.isFinite(rentalShown) ? (Number.isFinite(condoShown) && condoShown !== rentalShown ? `$${Math.round(rentalShown)} R · $${Math.round(condoShown)} C /GSF` : `$${Math.round(rentalShown)}/GSF`) : "";
      const chip = value || (loading ? "loading" : "");
      if (chip !== chipValue) {
        chipValue = chip;
        setSummary(parts.costPop, "Costs", value);
        if (chip === "loading") parts.costPop.summary.append(skel("skel-chip"));
      }
      parts.costPop.pop.classList.toggle("is-set", Boolean(draftChanged || unsaved || settings.isCustom));
      const message = loading ? "" : describe({draftChanged, unsaved});
      if (note.textContent !== message) note.textContent = message;
      note.classList.toggle("is-error", Boolean(costFormError || costError));
      save.disabled = profilePending || !costsReady() || !(draftChanged || unsaved);
      reset.hidden = !(settings.isCustom || unsaved || draftChanged);
      reset.disabled = profilePending || !costsReady();
      for (const button of parts.receipt?.querySelectorAll(".listings-undo") || []) button.disabled = profilePending;
      renderLegend();
    };
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      apply();
    });
    const store = async (payload, done) => {
      if (profilePending || !costsReady()) return;
      const draftVersion = costDraftVersion;
      profileDraftVersion = draftVersion;
      profilePending = true; costError = ""; costNotice = "";
      filterRevision++; parts.syncCosts();
      try {
        settings = await apiRequest("/market-store/user-settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
        costs = pickCosts(settings.dealSettings);
        if (draftVersion === costDraftVersion) {costDraft = null; costFormError = null; costDraftVersion++;}
        filterRevision++;
        costNotice = done;
        refresh();
      } catch (err) {
        costError = err.message;
      } finally {
        profilePending = false; parts.syncCosts();
        if (parts.receipt.querySelector('[data-filter-action="apply"]')) {
          parts.receipt.querySelector("span").textContent = "Your current values are kept. Apply the chat filters to use this reply.";
        }
      }
      const deferred = applyAfterSave;
      applyAfterSave = null;
      if (deferred === costDraftVersion) apply({focus: false});
    };
    save.addEventListener("click", () => {if (profilePending || !costsReady()) return; const next = read(); if (next) void store({ dealSettings: next }, "Saved as your costs.");});
    reset.addEventListener("click", () => void store({ reset: true }, "Back to the house costs."));
  }

  // The tier notes are a hover note on each item, not a title: a native tooltip stays on screen
  // when its item is rebuilt under the pointer, so the legend is also rebuilt only when they change.
  let legendKey = null;
  function renderLegend() {
    if (!parts.legend) return;
    const t = verdictThresholds(resultSettings || {});
    const items = [
      ["great_deal", t.great], ["good_deal", t.good], ["fair_deal", t.fair], ["full_price", t.full], ["unpriced_opportunity", "residual only"],
    ];
    const key = items.map(([, note]) => note).join("|");
    if (key === legendKey) return;
    legendKey = key;
    parts.legend.replaceChildren(...items.map(([tier, note]) => {
      const item = el("li", `verdict-${tier.split("_")[0]}`);
      item.append(el("span", "listings-legend-dot"), el("span", "", TIER_LABELS[tier]));
      if (note) {
        item.dataset.note = note;
        item.append(el("span", "sr-only", ` ${note}`));
      }
      return item;
    }));
  }

  function render() {
    section = el("section", "listings");
    section.addEventListener("input", () => { filterRevision++; clearChatUndo(); });
    section.setAttribute("aria-labelledby", "listings-title");
    section.dataset.view = "list";

    const filterBar = renderFilters();
    const head = el("header", "listings-head");
    // The sidebar and the phone top bar already name the page; the title stays for screen readers.
    const title = el("h1", "sr-only", "Explore NYC");
    title.id = "listings-title";
    // Home's address entry mounts here for its pending-site status; the place search submits it.
    parts.address = el("div", "listings-address");
    head.append(title, parts.find, filterBar, parts.address);
    const share = el("button", "listings-share");
    share.append(icon("share"), el("span", "", "Share search"));
    share.type = "button"; share.disabled = !costsReady();
    share.setAttribute("aria-haspopup", "dialog");
    share.addEventListener("click", showSearchLink);
    parts.share = share;

    const receipt = el("p", "listings-receipt");
    receipt.setAttribute("role", "status");
    receipt.hidden = true;
    parts.receipt = receipt;

    const bar = el("div", "listings-bar");
    const status = el("p", "listings-status");
    status.setAttribute("aria-live", "polite");
    parts.status = status;
    // A switch over the map's top edge: a checkbox in its role as an on/off control.
    const followWrap = el("label", "listings-follow");
    const followBox = el("input", "listings-switch");
    followBox.type = "checkbox";
    followBox.setAttribute("role", "switch");
    followBox.checked = follow;
    followBox.addEventListener("change", () => {
      clearChatUndo();
      follow = followBox.checked;
      filterRevision++;
      bounds = follow && map ? map.bounds() : null;
      void fetchPage(0); void fetchPins();
    });
    followWrap.append(followBox, el("span", "", "Search as I move the map"));
    parts.followBox = followBox;
    const views = el("div", "listings-views");
    views.setAttribute("role", "group");
    views.setAttribute("aria-label", "Show");
    for (const [view, text] of [["list", "List"], ["map", "Map"]]) {
      const b = el("button", "", text);
      b.type = "button";
      b.dataset.view = view;
      b.setAttribute("aria-pressed", String(view === "list"));
      b.addEventListener("click", () => setView(view));
      views.append(b);
    }
    bar.append(status, parts.sort, share, views);

    const split = el("div", "listings-split");
    const listPane = el("div", "listings-results");
    const list = el("div", "listings-list");
    list.setAttribute("aria-busy", "true");
    const pager = el("nav", "listings-pager");
    pager.setAttribute("aria-label", "Result pages");
    pager.hidden = true;
    const prev = el("button", "home-follow", "Previous");
    const next = el("button", "home-follow", "Next");
    prev.type = next.type = "button";
    prev.disabled = next.disabled = true;
    const range = el("span", "listings-range");
    pager.append(prev, range, next);
    prev.addEventListener("click", () => void fetchPage(Math.max(0, offset - PAGE_SIZE), { focus: true }));
    next.addEventListener("click", () => void fetchPage(offset + PAGE_SIZE, { focus: true }));
    const inspector = el("div", "listings-inspector");
    inspector.hidden = true;
    listPane.append(list, pager, inspector);
    Object.assign(parts, { list, prev, next, range, inspector, listPane });

    const mapPane = el("div", "listings-map-pane");
    const mapNode = el("div", "listings-map");
    mapNode.setAttribute("role", "region");
    mapNode.setAttribute("aria-label", "Map of the listings");
    const legend = el("ul", "listings-legend");
    legend.setAttribute("aria-label", "Deal tiers");
    parts.legend = legend;
    mapPane.append(mapNode, followWrap, legend);
    parts.mapNode = mapNode;
    split.append(listPane, mapPane);

    parts.sites = el("div", "listings-sites");
    const body = el("div", "listings-body");
    body.append(bar, split);
    section.append(head, receipt, body, parts.sites);
    root.replaceChildren(section);
    parts.syncFilters();
    renderLegend();
    if (invalidSearchLink) showChatFilterFeedback("This search link is invalid. Showing the default search.");
    else if (sharedSearch) showChatFilterFeedback("Shared search loaded.");
  }

  // A whole search kept or recorded: filters, map area and costs, applied as one change Undo reverses.
  function applySearchState({values, bounds: area, condoHardCostPerGrossSqft}, message, notes = []) {
    return applyFilterUpdate({base: filterSnapshot(), values}, {replay: true, mapArea: area, condo: condoHardCostPerGrossSqft, message, notes});
  }

  function applySavedSearch(item) {
    let state;
    try { state = validateSearchState(item.search); }
    catch (error) { showChatFilterFeedback(`${error.message} No filters changed.`); return false; }
    return applySearchState(state, `Saved search ${item.name} applied`);
  }

  function showSearchLink() {
    let link;
    try { link = createListingSearchLink(searchUrl, filterSnapshot()); }
    catch (error) { showChatFilterFeedback(error.message); return; }
    parts.searchDialog?.remove();
    const dialog = el("dialog", "listing-search-share");
    dialog.setAttribute("aria-labelledby", "listing-search-share-title");
    const header = el("div", "dialog-header"), title = el("h2", "", "Share search");
    title.id = "listing-search-share-title";
    const close = el("button", "home-follow", "Close search link"); close.type = "button";
    close.addEventListener("click", () => dialog.close()); header.append(title, close);
    const description = el("p", "", "Share these filters, cost assumptions and selected map area.");
    const input = el("input"); input.type = "url"; input.readOnly = true; input.value = link;
    input.setAttribute("aria-label", "Search link");
    const copy = el("button", "home-follow primary", "Copy link"); copy.type = "button";
    const status = el("p", "listing-search-share-status"); status.setAttribute("role", "status");
    copy.addEventListener("click", async () => {
      try { await copyText(link); status.textContent = "Link copied."; }
      catch { status.textContent = "Could not copy. Select the link above to copy it."; }
    });
    dialog.append(header, description, input, copy, status);
    section.append(dialog); parts.searchDialog = dialog; dialog.showModal();
  }

  function setView(view) {
    section.dataset.view = view;
    for (const b of section.querySelectorAll(".listings-views button")) b.setAttribute("aria-pressed", String(b.dataset.view === view));
    if (view === "map") map?.resize();
  }

  // Refine an active map area in place; an explicit location change starts a new search.
  function change(next, { replace = false, fromChat = false } = {}) {
    let values;
    try {values = validateFilterValues({...filterSnapshot().values, ...(replace ? defaultFilters() : {}), ...next});}
    catch (error) {
      const invalid = /^Invalid filter: (\w+)\.$/.exec(error.message), key = invalid?.[1], field = FILTER_SCHEMA.properties[key];
      if (field?.maxLength && next[key]?.length > field.maxLength) return `${field.title}: use ${field.maxLength} characters or fewer.`;
      if (key === "zoning") return "Use a zoning prefix such as R6 or C4-4D.";
      if (field?.minimum !== undefined) return `${field.title}: enter a number from ${field.minimum.toLocaleString("en-US")} to ${field.maximum.toLocaleString("en-US")}.`;
      return error.message.replace(/\b(minPrice|maxPrice|minLot|maxLot|minWidth|maxWidth|minDepth|maxDepth|minProjectCost|maxProjectCost)\b/g, name => FILTER_SCHEMA.properties[name].title);
    }
    filterRevision++;
    if (!fromChat) clearChatUndo();
    const fit = replace || ["borough", "area"].some(key => filters[key] !== values[key]) || !bounds;
    filters = Object.fromEntries(SEARCH_FILTER_KEYS.map(key => [key, values[key]]));
    if (fit) bounds = null;
    parts.syncFilters(replace);
    closeInspector();
    refresh({ fit });
    return null;
  }

  function filterSnapshot() {
    // The applied condo figure travels beside the snapshot values; only an explicit condo value enters them.
    const snapshotCosts = costs ? Object.fromEntries(COST_KEYS.filter(key => key !== CONDO_HARD_KEY && costs[key] !== undefined).map(key => [key, costs[key]])) : {};
    return validateFilterSnapshot({schema: FILTER_SCHEMA_ID, revision: filterRevision, values: {...defaultFilterValues(), ...filters, ...snapshotCosts, followMap: follow}, baselineCosts: Object.fromEntries(COST_KEYS.filter(key => Number.isFinite(settings.dealSettings[key])).map(key => [key, settings.dealSettings[key]])), map: {revision: mapMoves, bounds: follow ? bounds : null, viewport: map ? map.bounds() : null}, ...(Number.isFinite(costs?.[CONDO_HARD_KEY]) ? {condoHardCostPerGrossSqft: costs[CONDO_HARD_KEY]} : {})});
  }

  // showArea moves the map to mapArea even while it already follows the map: a saved search shows its area.
  function restoreFilterState(values, {draft, resetDrafts = false, mapArea, showArea = false} = {}) {
    const searchChanged = SEARCH_FILTER_KEYS.some(key => JSON.stringify(filters[key]) !== JSON.stringify(values[key]));
    const locationChanged = ["borough", "area"].some(key => filters[key] !== values[key]), wasFollowing = follow;
    filters = Object.fromEntries(SEARCH_FILTER_KEYS.map(key => [key, values[key]]));
    const overrides = pickCosts({...Object.fromEntries(COST_KEYS.map(key => [key, values[key] ?? settings.dealSettings[key]])), [CONDO_HARD_KEY]: values[CONDO_HARD_KEY] ?? costs?.[CONDO_HARD_KEY] ?? settings.dealSettings[CONDO_HARD_KEY]});
    if (draft !== undefined) costDraft = structuredClone(draft);
    else if (resetDrafts) costDraft = null;
    else if (costDraft) costDraft = Object.fromEntries(Object.entries(costDraft).filter(([key]) => values[key] !== null && overrides[key] === costs?.[key]));
    if (costFormError && !Object.hasOwn(costDraft || {}, costFormError.key)) costFormError = null;
    costDraftVersion++;
    costs = Object.keys(overrides).length ? overrides : null;
    follow = values.followMap;
    filterRevision++;
    if (mapArea !== undefined) bounds = follow ? mapArea : null;
    else if (!follow || locationChanged) bounds = null;
    else if (!wasFollowing && map) bounds = map.bounds();
    if (follow && mapArea && (!wasFollowing || showArea)) map?.setBounds(mapArea);
    parts.followBox.checked = follow;
    parts.syncFilters(resetDrafts); parts.syncCosts({restoreDraft: draft !== undefined || resetDrafts}); if (searchChanged) closeInspector();
    refresh({ fit: searchChanged && !bounds });
  }

  // mapArea and condo come with a whole saved search: its map area, shown again, and its condo hard
  // cost. message and notes word the receipt.
  function applyFilterUpdate(update, options = {}) {
    const {replay = false, mapArea, condo, message = "Filters updated", notes = []} = options;
    if (!section) render();
    let values;
    try { values = validateFilterValues(update.values); }
    catch (error) { showChatFilterFeedback(error.message + " No filters changed."); return false; }
    if (profilePending || !acceptsFilterUpdate(filterSnapshot(), update)) {
      showChatFilterFeedback(profilePending ? "Your baseline is still saving. Apply chat filters after it finishes." : "Your filters changed while chat was working. Your current values are kept.");
      const apply = el("button", "listings-undo", "Apply chat filters"); apply.type = "button";
      apply.dataset.filterAction = "apply";
      apply.disabled = profilePending;
      apply.addEventListener("click", () => applyFilterUpdate({...update, base: filterSnapshot()}, options));
      parts.receipt.append(apply); parts.receipt.hidden = false;
      return false;
    }
    if (replay) clearChatUndo();
    if (parts.receipt.hidden || !priorFilterState) priorFilterState = {values: {...filterSnapshot().values, [CONDO_HARD_KEY]: costs?.[CONDO_HARD_KEY]}, draft: structuredClone(costDraft), bounds};
    restoreFilterState(condo === undefined ? values : {...values, [CONDO_HARD_KEY]: condo}, {resetDrafts: replay, mapArea: mapArea === undefined ? listingSnapshotAfterUpdate(update.base, values).map?.bounds : mapArea, showArea: mapArea !== undefined});
    const appliedDraftVersion = costDraftVersion;
    const shown = describeFilters(filters);
    parts.receipt.replaceChildren(el("span", "", `${message}${shown.length ? `: ${shown.join(", ")}` : ""}.${notes.length ? ` Not on this page: ${notes.join("; ")}.` : ""}`));
    const undo = el("button", "listings-undo", "Undo"); undo.type = "button";
    undo.dataset.filterAction = "undo";
    undo.title = "Restore your filters from before these chat changes. Saved cost baselines are kept.";
    undo.addEventListener("click", () => {
      if (profilePending) return;
      const area = priorFilterState.bounds, restoreView = area && ["south", "west", "north", "east"].some(key => area[key].toFixed(5) !== bounds?.[key]?.toFixed(5));
      restoreFilterState(priorFilterState.values, {draft: costDraftVersion === appliedDraftVersion ? priorFilterState.draft : costDraft, mapArea: area});
      if (restoreView) map?.setBounds(area);
      clearChatUndo(); parts.receipt.hidden = true;
    });
    parts.receipt.append(undo); parts.receipt.hidden = false;
    return true;
  }

  function refresh({ fit = false } = {}) {
    void fetchPage(0);
    if (costsReady()) void fetchPins({ fit });
    if (inspectedId) void openListing(inspectedId, { notify: false });
  }

  async function fetchPage(at, { focus = false } = {}) {
    const token = ++pageLoad;
    const requestCosts = costs ? {...costs} : null;
    const needsPins = !costsReady();
    // The pins wait for the costs this first page reports; the map itself loads alongside it.
    if (needsPins) void ensureMap();
    pageStatus = "loading"; costError = ""; parts.syncCosts(); syncDrawerCount();
    parts.list.setAttribute("aria-busy", "true");
    if (!parts.list.querySelector(".listing-card:not(.listing-card-skeleton)")) {pageRows = []; const status = el("p", "sr-only", "Loading listings…"); status.setAttribute("role", "status"); parts.list.replaceChildren(status, listingCardSkeletons());}
    // The count holds its place until the first results report it.
    if (!parts.status.textContent) parts.status.replaceChildren(skel("skel-text skel-count"));
    let data;
    try {
      data = await apiRequest(`/market-store/deals?${queryParams(filters, { offset: at, bounds: follow ? bounds : null, costs: requestCosts })}`);
    } catch (err) {
      if (token !== pageLoad) return;
      pageStatus = "error"; pageRows = [];
      costError = `${costNotice ? costNotice + " " : ""}Could not update listings.`;
      parts.syncCosts();
      parts.list.setAttribute("aria-busy", "false");
      const failed = el("div", "retry-line listings-error");
      const retry = el("button", "retry-line-action", "Try again");
      retry.type = "button";
      retry.addEventListener("click", () => void fetchPage(at, { focus: true }));
      failed.append(alertText(err.message), retry);
      parts.list.replaceChildren(failed);
      parts.status.textContent = "";
      syncDrawerCount();
      if (focus) retry.focus();
      return;
    }
    if (token !== pageLoad) return;
    pageStatus = "ready"; costError = ""; costNotice = "";
    deals = Array.isArray(data.deals) ? data.deals : [];
    pageRows = deals;
    total = Number.isFinite(data.total) ? data.total : deals.length;
    offset = Number.isFinite(data.offset) ? data.offset : at;
    if (data.userSettings) {
      settings = data.userSettings;
      resultSettings = {...settings.dealSettings, ...(requestCosts || {})};
      if (needsPins) costs = pickCosts(resultSettings);
      parts.syncCosts();
    }
    parts.list.setAttribute("aria-busy", "false");
    parts.list.replaceChildren(...(deals.length ? deals.map((d, i) => card(d, offset + i + 1)) : [emptyState()]));
    markPicked();
    syncPager();
    parts.prev.disabled = offset <= 0;
    parts.next.disabled = offset + deals.length >= total;
    parts.range.textContent = deals.length ? `${offset + 1} to ${offset + deals.length} of ${total.toLocaleString("en-US")}` : "";
    // The map area qualifier is its own element, so a phone can set it on a line under the count.
    parts.status.replaceChildren(`${total.toLocaleString("en-US")} ${total === 1 ? "listing" : "listings"}`, ...(follow && bounds ? [el("span", "listings-status-where", " in the map area")] : []));
    syncDrawerCount();
    parts.listPane.scrollTop = 0;
    if (focus) parts.list.firstElementChild?.focus();
    if (needsPins && costsReady()) void fetchPins({fit: true});
  }

  function emptyState() {
    const box = el("div", "listings-empty");
    box.append(el("p", "", follow && bounds ? "No listings match in this part of the map." : "No listings match these filters."));
    const clear = el("button", "home-follow", follow && bounds ? "Search the whole city" : "Clear filters");
    clear.type = "button";
    clear.addEventListener("click", () => {
      if (!follow || !bounds) return change(defaultFilters(), { replace: true });
      filterRevision++; bounds = null;
      if (priorFilterState) priorFilterState.bounds = null;
      void fetchPage(0); void fetchPins({ fit: true });
    });
    box.append(clear);
    return box;
  }

  const cardFor = (id) => [...parts.list.children].find((c) => c.dataset.listing === id);

  function card(d, rank) {
    const node = listingCard(d, { onOpen: (id) => void openListing(id), site: d.bbl ? sites.get(String(d.bbl)) : null, rank });
    node.addEventListener("pointerenter", () => map?.setActive(d.id));
    node.addEventListener("pointerleave", () => map?.setActive(null));
    node.addEventListener("focusin", () => map?.setActive(d.id));
    node.addEventListener("focusout", () => map?.setActive(null));
    return node;
  }

  function markPicked() {
    for (const c of parts.list.querySelectorAll(".listing-card.is-selected")) c.classList.remove("is-selected");
    if (picked) cardFor(picked)?.classList.add("is-selected");
  }

  // A pin's card: the list turns to the page that holds it, so Back to results lands on it.
  function showPinCard(id) {
    const rank = pinRanks.get(id);
    if (rank && !cardFor(id)) void fetchPage(Math.floor((rank - 1) / PAGE_SIZE) * PAGE_SIZE);
  }

  async function fetchPins({ fit = false } = {}) {
    const token = ++pinLoad, moveRevision = mapMoves;
    const query = queryParams(filters, {costs, pins: true, bounds: follow ? bounds : null});
    // The pins download while the map loads; the map is needed only to draw them.
    const [m, data] = await Promise.all([ensureMap(), apiRequest(`/market-store/deals/pins?${query}`, { cache: "no-cache" }).catch(() => null)]);
    if (!data || token !== pinLoad || !m) return;
    const rows = pinRows(data.pins);
    pinRanks = new Map(rows.map((pin) => [pin.id, pin.rank]));
    m.setPins(rows, { fit: fit && moveRevision === mapMoves });
  }

  function ensureMap() {
    if (map) return Promise.resolve(map);
    mapLoading ||= loadMap(parts.mapNode, {
      onPick: (id) => { showPinCard(id); void openListing(id, { fromMap: true }); },
      onHover: (id) => {
        for (const c of parts.list.querySelectorAll(".listing-card.is-active")) c.classList.remove("is-active");
        if (id) cardFor(id)?.classList.add("is-active");
      },
      onMove: (box) => {
        mapMoves++;
        if (!follow) return;
        filterRevision++;
        bounds = box;
        if (priorFilterState) priorFilterState.bounds = box;
        void fetchPage(0); void fetchPins();
      },
      describe: (p) => [`${p.rank}. ${p.address || "Listing"}`, Number.isFinite(p.price) ? money(p.price) : "Unpriced", TIER_LABELS[p.verdict] || ""].filter(Boolean).join(" · "),
    })
      .then((m) => {map = m; if (bounds) map.setBounds(bounds); return map;})
      .catch(() => {
        const failed = el("div", "retry-line listings-map-error");
        const retry = el("button", "retry-line-action", "Try again");
        retry.type = "button";
        retry.addEventListener("click", () => { mapLoading = null; parts.mapNode.replaceChildren(); void fetchPins({ fit: true }); });
        failed.append(alertText("The map could not load."), retry);
        parts.mapNode.replaceChildren(failed);
        return null;
      });
    return mapLoading;
  }

  function showInspectorStatus(id, {fromMap, error = null, focus = false}) {
    const state = el("div", "listing-inspector inspector-state");
    const back = el("button", "inspector-back", "Back to results"); back.type = "button";
    back.addEventListener("click", () => closeInspector({focus: id}));
    // While loading, the page holds its shape; the words are for assistive technology only.
    let focusTarget = back;
    if (error) {
      const failed = el("div", "retry-line");
      const retry = el("button", "retry-line-action", "Try again"); retry.type = "button";
      retry.addEventListener("click", () => void openListing(id, {fromMap}));
      failed.append(alertText(error.message), retry);
      state.append(back, failed); focusTarget = retry;
    } else {
      const message = el("p", "sr-only", "Loading the listing…");
      message.setAttribute("role", "status");
      state.append(back, message, listingSkeleton());
    }
    parts.inspector.setAttribute("aria-busy", String(!error));
    parts.inspector.replaceChildren(state);
    if (focus) focusTarget.focus();
  }

  let resultsScrollTop = 0;
  async function openListing(id, { fromMap = false, notify = true } = {}) {
    if (!inspectedId) resultsScrollTop = parts.listPane.scrollTop;
    const token = ++detailLoad;
    if (notify) onInspect(id);
    const requestCosts = costs ? {...costs} : null;
    const focus = fromMap || parts.list.contains(document.activeElement) || parts.inspector.contains(document.activeElement);
    selectedSettings = null;
    selectedCostBasis = null;
    selected = null;
    inspectedId = id;
    picked = id; markPicked();
    map?.setSelected(id, { reveal: !fromMap });
    if (section.dataset.view === "map" && fromMap) setView("list");
    // The listing takes the page; the map returns with Back to results.
    section.classList.add("is-inspecting");
    parts.inspector.hidden = false;
    parts.list.hidden = true;
    syncPager();
    parts.syncCosts();
    showInspectorStatus(id, {fromMap, focus});
    parts.listPane.scrollTop = 0;
    let data, site;
    try {
      data = await apiRequest(`/market-store/deals/${encodeURIComponent(id)}${requestCosts ? `?${new URLSearchParams(requestCosts)}` : ""}`);
      site = data.deal.bbl ? await sites.find(String(data.deal.bbl)) : null;
    } catch (err) {
      if (token !== detailLoad) return;
      showInspectorStatus(id, {fromMap, error: err, focus: parts.inspector.contains(document.activeElement)});
      return;
    }
    if (token !== detailLoad) return;
    const focusTitle = parts.inspector.contains(document.activeElement);
    selected = data.deal;
    if (!root.hidden) document.title=displayAddress(selected.address || selected.plutoAddress || "Listing")+" · Arosa";
    selectedSettings = { ...data.userSettings.dealSettings, ...(requestCosts || {}) };
    selectedCostBasis = { house: data.userSettings.baselineSettings, saved: data.userSettings.isCustom ? data.userSettings.dealSettings : null };
    parts.syncCosts();
    parts.inspector.setAttribute("aria-busy", "false");
    drawInspector(id, site);
    if (focusTitle) parts.inspector.querySelector("#inspector-title")?.focus({ preventScroll: true });
  }

  function drawInspector(id, site) {
    parts.inspector.replaceChildren(renderInspector(selected, {
      goal: listingGoal(),
      onGoal: (goal) => { saveListingGoal(goal); drawInspector(id, site); parts.inspector.querySelector(`[data-goal="${goal}"]`)?.focus({ preventScroll: true }); },
      dealSettings: selectedSettings,
      costBasis: selectedCostBasis,
      onSetCosts: openCosts,
      site,
      canStart,
      onUnderwrite,
      onOpenSite: sites.open,
      onRegenerate: sites.regenerate,
      onInvestigate,
      onAsk: (deal) => onAsk(deal),
      onPlan: onPlan?.() ?? null,
      onCopyLink: async (deal) => {
        try {
          await copyText(new URL(`/listings/${encodeURIComponent(deal.listing_id)}`, linkOrigin(new URL(searchUrl || window.location.href).origin)).href);
          showChatFilterFeedback("Link copied.");
        } catch { showChatFilterFeedback("Could not copy the link."); }
      },
      onClose: () => closeInspector({ focus: id }),
    }));
  }

  // Set your costs on the listing page: the Costs control opens above the listing.
  function openCosts() {
    section.classList.add("is-costs-open");
    parts.costPop.pop.open = true;
    parts.costPop.summary.focus({ preventScroll: true });
  }

  // A run on the open listing's site started or ended: its line and actions follow, in place.
  async function refreshSelectedSite() {
    if (!selected?.bbl) return;
    const id = inspectedId, token = detailLoad;
    const site = await sites.find(String(selected.bbl));
    if (token !== detailLoad || id !== inspectedId) return;
    const focused = parts.inspector.contains(document.activeElement);
    drawInspector(id, site);
    if (focused) parts.inspector.querySelector("#inspector-title")?.focus({ preventScroll: true });
  }

  function closeInspector({ focus = null, notify = true } = {}) {
    if (!parts.inspector || parts.inspector.hidden) return;
    if (notify) onInspect(null);
    detailLoad++;
    const returnId = focus || inspectedId;
    inspectedId = null;
    selected = null;
    selectedSettings = null;
    selectedCostBasis = null;
    map?.setSelected(null);
    parts.inspector.hidden = true;
    parts.inspector.removeAttribute("aria-busy");
    parts.inspector.replaceChildren();
    parts.list.hidden = false;
    section.classList.remove("is-inspecting");
    map?.resize();
    parts.syncCosts();
    syncPager();
    parts.listPane.scrollTop = resultsScrollTop;
    if (!root.hidden) document.title="Explore NYC · Arosa";
    if (returnId) (cardFor(returnId)?.querySelector(".listing-card-open") || section.querySelector('.listings-views [data-view="map"]'))?.focus({preventScroll:true});
  }

  // The pager shows under a page of cards, never under the inspector or an empty list.
  function syncPager() {
    section.querySelector(".listings-pager").hidden = !deals.length || !parts.inspector.hidden;
  }

  return {
    // Mount points for home's address entry and recent sites.
    get addressMount() {
      if (!section) render();
      return parts.address;
    },
    get sitesMount() {
      if (!section) render();
      return parts.sites;
    },
    // Draws the page and loads the first results the first time home shows it.
    // Every render of the app calls this; only the first draws and loads. The map follows its own
    // container's size, and the page resizes it when the chat or the list and map switch changes.
    show() {
      if (!section) render();
      if (!pageLoad) refresh({ fit: !bounds });
    },
    resize: () => map?.resize(),
    // The page address names a listing (back, forward or a pasted link): show it, or the results.
    // Coming back to the listing already shown brings its saved site up to date.
    inspect(id) {
      if (!section) render();
      if (id && id !== inspectedId) void openListing(id, { notify: false });
      else if (id) void refreshSelectedSite().catch(() => {});
      else closeInspector({ notify: false });
    },
    syncAccess() {
      for (const b of parts.inspector?.querySelectorAll(".deal-card-underwrite") || []) b.disabled = !canStart();
    },
    // The sites list arrived or changed: each card shows its listing's saved site.
    syncSites() {
      for (const c of parts.list?.children || []) if (c.dataset.bbl) showCardSite(c, sites.get(c.dataset.bbl));
    },
    refreshSelectedSite,
    context: () => listingsContext({ filters, total, deals, selected }),
    filterSnapshot,
    pageSnapshot: () => captureListingPage({status:pageStatus,offset,total,deals:pageRows,selected}),
    applyFilterUpdate,
    applySavedFilterUpdate(update) {
      if (!section) render();
      let values;
      try {
        const saved = validateFilterSnapshot(update.base);
        values = validateFilterValues(update.values);
        for (const key of COST_KEYS) if (values[key] === null && saved.baselineCosts[key] !== undefined) values[key] = saved.baselineCosts[key];
      } catch (error) {
        showChatFilterFeedback(error.message + " No filters changed.");
        return false;
      }
      const current = filterSnapshot();
      if (FILTER_SCHEMA.required.every(key => JSON.stringify(values[key]) === JSON.stringify(current.values[key])) && !filterDrafts.some(read => read()) && !costDraft) {
        showChatFilterFeedback("These filters are already in use.");
        return true;
      }
      return applyFilterUpdate({base: current, values}, {replay: true});
    },
    // A listing search recorded with an answer becomes the page's search again: the same query, map
    // area and costs. What the page cannot set is named in the receipt.
    applyListingSearch(search) {
      if (!section) render();
      let state;
      try { state = listingSearchValues(search.filters); }
      catch (error) { showChatFilterFeedback(`${error.message} No filters changed.`); return false; }
      return applySearchState(state, "Filters from the listing search applied", state.differences);
    },
    // A deal store search from the chat replaces the filters; Undo restores the reader's own.
    applySearch(search) {
      if (!section) render();
      // Undo returns to the reader's own filters, even after several searches from the chat.
      const before = filters, problem = change(filtersFromSearch(search), { replace: true, fromChat: true });
      if (problem) {showChatFilterFeedback(`${problem} No filters changed.`);return false;}
      if (parts.receipt.hidden || !previous) previous = before;
      const shown = describeFilters(filters);
      const sold = search.listingType && search.listingType !== "for_sale" ? " This page shows listings for sale." : "";
      parts.receipt.replaceChildren(el("span", "", `Filters updated from the chat${shown.length ? `: ${shown.join(", ")}` : ""}.${sold}`));
      const undo = el("button", "listings-undo", "Undo");
      undo.type = "button";
      undo.dataset.filterAction = "undo";
      undo.title = "Restore your filters from before these chat changes. Saved cost baselines are kept.";
      undo.addEventListener("click", () => {
        const back = previous;
        previous = null;
        change(back, { replace: true });
        parts.receipt.hidden = true;
      });
      parts.receipt.append(undo);
      parts.receipt.hidden = false;
      return true;
    },
  };
}
