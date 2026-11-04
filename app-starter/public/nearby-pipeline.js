// What is being built around a listing or site: DOB new buildings and major alterations nearby, with
// units, floor area and, where a record says so, whether the homes are rentals or condos.

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

const int = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");
const plural = (n, one, many = `${one}s`) => `${int(n)} ${Number(n) === 1 ? one : many}`;
export const area = (sf) => (sf >= 1e6 ? `${(sf / 1e6).toFixed(1)} million SF` : `${int(sf)} SF`);
const month = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const radius = (miles) => (miles === 0.5 ? "half a mile" : miles === 1 ? "a mile" : `${miles} miles`);

export const STAGES = {
  approved: "Approved or permitted",
  in_review: "In DOB review",
  pre_filing: "Pre-filing",
  completed: "Signed off",
  disapproved: "Has objections",
  unknown: "Status not recorded",
};
export const TENURE = { rental: "Rental", condo: "Condo", mixed: "Rental and condo" };

// The query for a place's nearby pipeline, or null when it has no coordinates.
export function nearbyPipelineQuery({ latitude, longitude, zip = null, bbl = null } = {}) {
  const lat = Number(latitude), lng = Number(longitude);
  if (!latitude || !longitude || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const params = new URLSearchParams({ lat: String(lat), lng: String(lng) });
  if (zip) params.set("zip", String(zip));
  if (bbl) params.set("bbl", String(bbl));
  return params.toString();
}

// The headline: approved or permitted projects, units and floor area within the radius since the
// look-back began. Projects at other stages are named by stage, never added to it.
export function nearbySummary(read) {
  const t = read.nearby, a = t.approved;
  return t.projects
    ? `Within ${radius(read.radiusMiles)}, filed or acted on since ${month(read.since)}: ${plural(a.projects, "approved or permitted project")} with ${plural(a.units, "proposed unit")} and ${area(a.floorArea)} of floor area.`
    : `No new building or major alteration filed or acted on within ${radius(read.radiusMiles)} since ${month(read.since)}.`;
}

// The projects not yet approved or permitted (or already signed off), stage by stage.
export function stageLine(t) {
  const rest = Object.entries(t.byStage || {}).filter(([stage]) => stage !== "approved");
  return rest.length ? `Not counted above: ${rest.map(([stage, b]) => `${STAGES[stage] || stage}, ${plural(b.projects, "project")} with ${plural(b.units, "unit")}`).join("; ")}.` : null;
}

export function zipLine(read) {
  const z = read.sameZip;
  if (!z?.projects) return null;
  const other = z.units - z.approved.units;
  return `In ZIP ${read.zip}: ${plural(z.approved.projects, "approved or permitted project")} with ${plural(z.approved.units, "proposed unit")}${other > 0 ? `, and ${plural(other, "unit")} at other stages` : ""}.`;
}
export const asOf = (read) => `NYC Department of Buildings filings as of ${new Date(read.retrievedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}.`;

export function tenureLine(t) {
  const stated = t.tenure.condo.units + t.tenure.rental.units;
  if (!t.units) return null;
  if (!stated) return "No HPD or condo declaration record says yet whether these homes will be rentals or condos.";
  const parts = [t.tenure.rental.units && `${int(t.tenure.rental.units)} rental`, t.tenure.condo.units && `${int(t.tenure.condo.units)} condo`].filter(Boolean);
  const rest = t.units - stated;
  return `Where a record says how the homes are held: ${parts.join(" and ")} units, ${Math.round(t.condoShareOfStatedUnits * 100)}% condo.${rest > 0 ? ` The other ${plural(rest, "unit")} have no tenure on record yet.` : ""}`;
}

function projectItem(p) {
  const item = el("li");
  const main = el("div");
  const kind = p.newBuilding ? "New building" : "Major alteration";
  main.append(
    el("strong", "", p.address || `BBL ${p.bbl}`),
    el("small", "", [kind, STAGES[p.stage] || p.status, p.filingDate ? `filed ${month(p.filingDate)}` : "", Number.isFinite(p.distanceMiles) ? `${p.distanceMiles.toFixed(2)} mi` : ""].filter(Boolean).join(" · ")),
  );
  const value = el("div", "inspector-comp-value");
  value.append(
    el("strong", "", p.units > 0 ? plural(p.units, "unit") : "No units"),
    el("small", "", p.floorArea > 0 ? area(p.floorArea) : "Floor area not stated"),
  );
  if (TENURE[p.tenure]) value.append(el("small", "", TENURE[p.tenure]));
  const link = el("a", "nearby-pipeline-link", `DOB job ${p.jobNumber}`);
  link.href = p.link;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.setAttribute("aria-label", `DOB job ${p.jobNumber} (opens in a new tab)`);
  const foot = el("p", "inspector-comp-reasons");
  foot.append(link);
  if (p.tenureBasis?.length) foot.append(` · ${p.tenureBasis.join("; ")}`);
  item.append(main, value, foot);
  return item;
}

// The section for a listing or site page. read is the /nearby-pipeline response; null while loading.
export function renderNearbyPipeline(read, { shown = 8 } = {}) {
  const section = el("section", "inspector-section nearby-pipeline");
  section.append(el("h3", "", "Nearby development"));
  if (!read) {
    section.append(el("p", "inspector-note", "Loading DOB filings nearby…"));
    return section;
  }
  if (!read.available) {
    section.append(el("p", "inspector-note", read.reason === "no_location"
      ? "This place has no map location, so nearby DOB filings cannot be shown."
      : "Nearby DOB filings are not available yet."));
    return section;
  }
  section.append(el("p", "", nearbySummary(read)));
  for (const line of [stageLine(read.nearby), tenureLine(read.nearby), zipLine(read)]) if (line) section.append(el("p", "inspector-note", line));
  for (const p of read.onSubjectLot || []) {
    section.append(el("p", "inspector-note", `On this lot: ${p.newBuilding ? "new building" : "major alteration"} job ${p.jobNumber}, ${(STAGES[p.stage] || p.status).toLowerCase()}${p.units > 0 ? `, ${plural(p.units, "unit")}` : ""}.`));
  }
  if (read.projects.length) {
    const list = el("ul", "inspector-comps nearby-pipeline-projects");
    for (const p of read.projects.slice(0, shown)) list.append(projectItem(p));
    section.append(list);
    if (read.projectCount > shown) section.append(el("p", "inspector-note", `Showing the ${shown} largest of ${read.projectCount} projects.`));
  }
  const how = el("details", "inspector-basis");
  how.append(el("summary", "", "How these are counted"));
  const notes = el("ul");
  for (const text of [
    "New buildings and major alterations from NYC Department of Buildings filings, in DOB NOW and the older BIS system.",
    "Each lot counts once, as its latest new building job or else its latest alteration. Withdrawn jobs are left out.",
    "Units and floor area are what the filing proposes; floor area is DOB's total construction floor area. An alteration counts only the units it adds.",
    "The headline counts only jobs DOB has approved or permitted; jobs in review, in pre-filing, with objections or signed off are listed by stage.",
    "A project shows as rental or condo only when an HPD affordable housing record or a condo declaration recorded in ACRIS says so.",
    asOf(read),
  ]) notes.append(el("li", "", text));
  const source = el("a", "nearby-pipeline-link", "All DOB NOW job filings");
  source.href = read.sourceUrl;
  source.target = "_blank";
  source.rel = "noopener noreferrer";
  const sourceItem = el("li");
  sourceItem.append(source);
  notes.append(sourceItem);
  how.append(notes);
  section.append(how);
  return section;
}
