// Loading placeholders that hold a page's shape until its content arrives: each block is sized like
// the element it stands in for, so nothing jumps when the real content lands. The shimmer is one slow
// sweep (styles.css .skel) and stops under reduced motion.
function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

export function skel(className = "", style = {}) {
  const node = el("span", `skel ${className}`.trim());
  node.setAttribute("aria-hidden", "true");
  Object.assign(node.style, style);
  return node;
}

// A listing's page while it loads: pills, address, meta, the action bar, the photo, the four figures
// and the first two sections, in their final positions.
export function listingSkeleton() {
  const root = el("div", "listing-skeleton");
  root.setAttribute("aria-hidden", "true");
  const pills = el("div", "listing-skeleton-row");
  pills.append(skel("skel-pill", {width: "84px"}), skel("skel-pill", {width: "48px"}));
  const actions = el("div", "listing-skeleton-row");
  actions.append(skel("skel-button", {width: "118px"}), skel("skel-text", {width: "min(300px, 60%)"}), skel("skel-button", {width: "82px"}));
  const figures = el("div", "listing-skeleton-figures");
  for (let i = 0; i < 4; i++) figures.append(skel("skel-figure"));
  const section = () => {
    const box = el("div", "listing-skeleton-section");
    box.append(skel("skel-text", {width: "34%"}), skel("skel-block", {height: "64px"}));
    return box;
  };
  root.append(pills, skel("skel-title", {width: "min(380px, 70%)"}), skel("skel-text", {width: "min(320px, 55%)"}), actions, skel("skel-photo"), figures, section(), section());
  return root;
}

// Result cards while the list loads: the media square beside a title, a place line and two figure pairs.
export function listingCardSkeletons(count = 8) {
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    const card = el("div", "listing-card listing-card-skeleton");
    card.setAttribute("aria-hidden", "true");
    const body = el("div", "listing-card-body");
    const figures = el("div", "listing-card-figures");
    for (let j = 0; j < 4; j++) {
      const pair = el("div");
      pair.append(skel("skel-text", {width: "54%", height: "11px"}), skel("skel-text", {width: "70%", height: "14px", marginTop: "4px"}));
      figures.append(pair);
    }
    body.append(skel("skel-text", {width: `${62 + (i % 3) * 9}%`, height: "15px"}), skel("skel-text", {width: "44%", height: "12px"}), figures);
    card.append(skel("skel-media"), body);
    fragment.append(card);
  }
  return fragment;
}
