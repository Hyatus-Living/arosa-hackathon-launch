// "In the news": trade-press stories about a lot or its block, newest first, for the site page
// and the report. Each links out to the publisher's article.
const titleCase = (s) => String(s || "").toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

export function newsDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function newsPlace(story) {
  if (story.onLot) return "This lot";
  return story.addresses.length ? `On the block, ${story.addresses.map(titleCase).join(" and ")}` : "On the block";
}

export function newsList(stories, className = "news-list") {
  const list = document.createElement("ul");
  list.className = className;
  for (const story of stories) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = story.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = story.title;
    const meta = document.createElement("span");
    meta.className = "news-meta";
    meta.textContent = [story.publisher, newsDate(story.publishedAt), newsPlace(story)].filter(Boolean).join(" · ");
    item.append(link, meta);
    list.append(item);
  }
  return list;
}
