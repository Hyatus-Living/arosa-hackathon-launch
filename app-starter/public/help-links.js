// "How is this calculated?" links from a figure to the methodology article behind it. The base is the
// one place the help center's address lives; every link opens the article in a new tab.
export const HELP_BASE = "https://witharosa.ai/help";

// slug -> what the article explains, for the link's accessible name.
export const HELP_TOPICS = {
  "buildable-area": { subject: "buildable floor area" },
  "three-options": { subject: "the three ways to build it" },
  "budget": { subject: "the development budget" },
  "land-value": { subject: "land value" },
  "deal-tiers": { subject: "the deal tier" },
  "sources-and-freshness": { subject: "sources and retrieval dates", text: "How sources and freshness work" },
};

const SVG = "http://www.w3.org/2000/svg";
function questionMark() {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const [tag, attrs] of [["circle", { cx: 12, cy: 12, r: 9 }], ["path", { d: "M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.6-2.4 2.1-2.4 3.6" }], ["path", { d: "M12 17h.01" }]]) {
    const node = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    svg.append(node);
  }
  return svg;
}

// A quiet link to /help/<slug>. Text by default; { icon: true } draws a small question mark with the
// same accessible name, for figures with no room for a line of text.
export function helpLink(slug, { icon = false } = {}) {
  const topic = HELP_TOPICS[slug];
  if (!topic) throw new Error(`Unknown help article: ${slug}`);
  const a = document.createElement("a");
  a.className = icon ? "help-link help-link-icon" : "help-link";
  a.href = `${HELP_BASE}/${slug}`;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.dataset.help = slug;
  const text = topic.text || "How is this calculated?";
  if (icon) {
    a.setAttribute("aria-label", `How is ${topic.subject} calculated? Opens in a new tab`);
    a.title = `How is ${topic.subject} calculated?`;
    a.append(questionMark());
  } else {
    a.textContent = text;
    a.setAttribute("aria-label", `${text} (${topic.subject}), opens in a new tab`);
  }
  return a;
}
