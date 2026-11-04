// The zoning sheet slot of a scheme's card (schemes-view.js): the option's ZD1-style zoning diagram,
// drawn with each plan revision, and its PDF. scheme.plan.zoning is {svg, pdf} (artifact ids), present
// on revisions drawn on the option's storey outlines.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

export function renderZoningSheet(scheme, { projectId }) {
  const sheet = scheme.plan?.zoning;
  if (!sheet?.svg) return el("span", "", "Drawn with the next floor plan");
  const box = el("div", "uw-scheme-plan");
  const artifact = (artifactId) => `/api/projects/${encodeURIComponent(projectId)}/architecture/artifacts/${encodeURIComponent(artifactId)}`;
  const open = el("a");
  open.href = artifact(sheet.svg);
  open.target = "_blank";
  open.rel = "noopener";
  const img = el("img", "uw-scheme-plan-image");
  img.src = artifact(sheet.svg);
  img.alt = `Zoning diagram and calculations for the ${scheme.label} option`;
  img.loading = "lazy";
  open.append(img);
  box.append(open);
  if (sheet.pdf) {
    const pdf = el("a", "", "Download the zoning sheet (PDF)");
    pdf.href = artifact(sheet.pdf);
    pdf.download = "";
    box.append(pdf);
  }
  return box;
}
