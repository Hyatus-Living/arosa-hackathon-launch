const labels = {
  borough: "Borough", address: "Address", bbl: "BBL", block: "Block", lot: "Lot",
  zonedist1: "Zoning district", zonedist2: "Zoning district 2",
  zonedist3: "Zoning district 3", zonedist4: "Zoning district 4",
  overlay1: "Commercial overlay", overlay2: "Commercial overlay 2",
  spdist1: "Special district", spdist2: "Special district 2", spdist3: "Special district 3",
  lotarea: "Lot area (sq ft)", bldgarea: "Building area (sq ft)", numfloors: "Floors",
  unitsres: "Residential units", unitstotal: "Total units", yearbuilt: "Year built",
  builtfar: "Built FAR", residfar: "Residential FAR", commfar: "Commercial FAR",
  facilfar: "Community facility FAR", affresfar: "Affordable residential FAR",
  landmark: "Landmark", histdist: "Historic district", splitzone: "Split zoning lot",
  zonemap: "Zoning map", version: "PLUTO release", latitude: "Latitude", longitude: "Longitude",
};

export function sourceInfo(source) {
  const rawUrl = typeof source.url === "string" ? source.url.trim() : "";
  let url;
  try { url = new URL(rawUrl); } catch { /* The excerpt remains readable without a link. */ }
  const href = url && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  let title = typeof source.title === "string" ? source.title.trim() : "";
  let titleUrl;
  try { titleUrl = new URL(title); } catch { /* Human-readable titles need no URL. */ }
  if ((titleUrl && (titleUrl.username || titleUrl.password)) || (!href && title === rawUrl)) title = "";
  if (!title && href) {
    title = url.hostname + (url.pathname === "/" ? "" : url.pathname);
    try { title = decodeURI(title); } catch { /* Retain a readable encoded path. */ }
  }
  let retrievedAt = null;
  for (const value of [source.retrievedAt, source.fetchedAt]) {
    if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) continue;
    const timestamp = new Date(value).getTime();
    if (Number.isFinite(timestamp)) { retrievedAt = timestamp; break; }
  }
  return {title: title || "Source link unavailable", href, hostname: href ? url.hostname : "", retrievedAt};
}

export function sourceExcerpt(source) {
  const excerpt = document.createElement("div");
  excerpt.className = "source-excerpt";
  if (source.kind !== "property") {
    excerpt.textContent = source.text;
    return excerpt;
  }
  let records;
  try {
    records = JSON.parse(source.text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    excerpt.textContent = "Open the original source to view the complete parcel records.";
    return excerpt;
  }
  if (!Array.isArray(records) || !records.every((record) => record && typeof record === "object" && !Array.isArray(record))) {
    excerpt.textContent = "Open the original source to view the parcel records.";
    return excerpt;
  }
  if (!records.length) excerpt.textContent = "This source returned no matching parcel records.";
  for (const record of records) {
    const section = document.createElement("section");
    section.className = "source-parcel";
    const title = document.createElement("h3");
    title.textContent = record.address || "Parcel record";
    const list = document.createElement("dl");
    for (const [key, value] of Object.entries(record)) {
      if (value === null || value === "" || typeof value === "object") continue;
      const row = document.createElement("div");
      const label = document.createElement("dt");
      label.textContent = labels[key] || key.replaceAll("_", " ");
      const data = document.createElement("dd");
      data.textContent = String(value).replace(/\.0+$/, "");
      row.append(label, data);
      list.append(row);
    }
    section.append(title, list);
    excerpt.append(section);
  }
  return excerpt;
}

// The source dialog shows what a citation supports: who published it, when it was read, the cited
// excerpt when there is one, and a way to the original. Without an excerpt it stays a single row.
export function sourcePublisher(source, info = sourceInfo(source)) {
  const named = typeof source.publisher === "string" ? source.publisher.trim() : "";
  return named || info.hostname.replace(/^www\./, "");
}

export function fillSourceDialog(source) {
  const info = sourceInfo(source);
  document.querySelector("#source-title").textContent = info.title;
  const body = document.querySelector("#source-body");
  body.replaceChildren();
  const meta = document.createElement("p");
  meta.className = "source-meta";
  const publisher = sourcePublisher(source, info);
  const retrieved = info.retrievedAt !== null
    ? `Retrieved ${new Date(info.retrievedAt).toLocaleDateString("en-US", {month: "short", day: "numeric", year: "numeric"})}`
    : "";
  for (const text of [publisher, retrieved].filter(Boolean)) {
    const part = document.createElement("span");
    part.textContent = text;
    meta.append(part);
  }
  if (meta.childNodes.length) body.append(meta);
  const hasText = typeof source.text === "string" ? source.text.trim() : source.text;
  if (hasText) body.append(sourceExcerpt(source));
  const actions = document.createElement("div");
  actions.className = "source-actions";
  if (info.href) {
    const a = document.createElement("a");
    a.className = "source-open";
    a.href = info.href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "Open source ↗";
    actions.append(a);
  } else {
    const unavailable = document.createElement("span");
    unavailable.className = "source-unavailable";
    unavailable.textContent = "Original link unavailable";
    actions.append(unavailable);
  }
  body.append(actions);
  body.classList.toggle("is-compact", !hasText);
  const status = document.querySelector(".source-status");
  if (status) status.textContent = "";
}
