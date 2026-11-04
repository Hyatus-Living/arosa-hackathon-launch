import { icon, initials } from "./conversation-view.js";

const $ = (selector) => document.querySelector(selector);

function element(tag, className, textContent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent !== undefined) node.textContent = textContent;
  return node;
}

export function resolveFocusedTeamId(teams = [], preferredId = null) {
  if (preferredId && teams.some((team) => team.id === preferredId)) return preferredId;
  return teams[0]?.id || null;
}

export function teamPeopleLabel(team) {
  const count = Number.isFinite(team?.memberCount) && team.memberCount > 0 ? team.memberCount : 1;
  return `${count} ${count === 1 ? "person" : "people"}`;
}

// One reading of a team for every place it appears (sidebar, team list, detail header, tabs), so the
// role and head count can never disagree. The member list wins when it is loaded; a team always has
// at least its owner, so an empty list means the members have not arrived yet.
export function teamFacts(team, account = null) {
  const members = Array.isArray(team?.members) ? team.members : [];
  const count = members.length || (Number.isFinite(team?.memberCount) && team.memberCount > 0 ? team.memberCount : 1);
  const owned = team?.role ? team.role === "owner" : Boolean(account && team?.owner?.account === account);
  const ownerMember = members.find((member) => member.role === "owner");
  const ownerName = owned ? "You" : personDisplay(ownerMember || team?.owner || {}).primary;
  const people = `${count} ${count === 1 ? "person" : "people"}`;
  return { owned, count, people, role: owned ? "Owner" : "Member", ownerName, meta: `${owned ? "Owner" : "Member"} · ${people}` };
}

export function teamRoleLabel(team) {
  return teamFacts(team).role;
}

// A team's detail response keeps whatever the summary already knew (role, head count) when it
// leaves a field out, so the detail view never contradicts the list beside it.
export function mergeTeamDetail(summary, detail) {
  const team = detail?.team || detail || {};
  const members = team.members?.length ? team.members : detail?.members?.length ? detail.members : team.members || detail?.members || [];
  return { ...(summary || {}), ...team, role: team.role || summary?.role, memberCount: members.length || team.memberCount || summary?.memberCount, members };
}

// A person's name when the data has one, otherwise their email. Names the server derived from the
// email's local part ("michael" for michael@...) count as no name.
export function personDisplay(person = {}) {
  const email = typeof person.email === "string" ? person.email.trim() : "";
  const raw = typeof person.name === "string" ? person.name.trim() : "";
  const local = email.includes("@") ? email.slice(0, email.indexOf("@")) : "";
  const name = raw && raw.toLowerCase() !== local.toLowerCase() && raw !== "A teammate" ? raw : "";
  return { primary: name || email || raw || "A teammate", secondary: name && email ? email : "" };
}

export function teamAvatar(name, className = "team-avatar") {
  const avatar = element("span", className, initials(name || "Team"));
  avatar.setAttribute("aria-hidden", "true");
  return avatar;
}

function teamMeta(team) {
  return teamFacts(team).meta;
}

export function renderTeamManagerList({
  teams = [],
  selectedTeamId = null,
  focusedTeamId = null,
  loading = false,
  error = null,
  query = "",
} = {}) {
  const list = $("#team-list");
  if (!list) return;
  const railCount = $("#team-rail-count");
  if (railCount) railCount.textContent = loading && !teams.length ? "" : `${teams.length} ${teams.length === 1 ? "team" : "teams"}`;
  const searchWrap = $("#team-search-wrap");
  if (searchWrap) searchWrap.hidden = teams.length < 6 && !query;
  list.replaceChildren();
  list.setAttribute("aria-busy", String(Boolean(loading)));

  if (loading && !teams.length) {
    const status = element("div", "team-manager-loading");
    status.setAttribute("role", "status");
    status.append(element("span", "sr-only", "Loading your teams"));
    for (let i = 0; i < 3; i++) {
      const row = element("span", "team-skeleton-row manager");
      row.setAttribute("aria-hidden", "true");
      status.append(row);
    }
    list.append(status);
    return;
  }
  if (error && !teams.length) {
    const wrap = element("div", "team-manager-message is-error");
    wrap.append(element("strong", null, "Teams couldn’t load."));
    const retry = element("button", "team-button", "Retry");
    retry.type = "button";
    retry.dataset.teamRetry = "";
    wrap.append(retry);
    list.append(wrap);
    return;
  }
  if (!teams.length) {
    const wrap = element("div", "team-manager-message");
    wrap.append(element("strong", null, "No teams yet"));
    list.append(wrap);
    return;
  }

  const normalizedQuery = query.trim().toLowerCase();
  const visible = normalizedQuery ? teams.filter((team) => team.name.toLowerCase().includes(normalizedQuery)) : teams;
  if (!visible.length) {
    const wrap = element("div", "team-manager-message");
    wrap.append(element("strong", null, `No teams match “${query.trim()}”`));
    list.append(wrap);
    return;
  }

  let selectedRow = null;
  for (const team of visible) {
    const selected = team.id === selectedTeamId;
    const focused = team.id === focusedTeamId;
    const row = element("button", "team-manager-row");
    row.type = "button";
    row.dataset.teamSelect = team.id;
    if (selected) row.setAttribute("aria-current", "true");
    row.setAttribute("aria-label", `${team.name}, ${teamMeta(team)}${focused ? ", sharing default" : ""}`);
    const copy = element("span", "team-nav-copy");
    copy.append(element("strong", null, team.name), element("small", null, teamMeta(team)));
    row.append(teamAvatar(team.name), copy);
    if (focused) row.append(element("span", "team-default-badge", "Default"));
    const chevron = element("span", "team-row-chevron");
    chevron.innerHTML = icon("chevron");
    chevron.setAttribute("aria-hidden", "true");
    row.append(chevron);
    list.append(row);
    if (selected) selectedRow = row;
  }
  if (selectedRow && typeof selectedRow.scrollIntoView === "function") {
    const scrollSelected = () => selectedRow.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (typeof globalThis.requestAnimationFrame === "function") globalThis.requestAnimationFrame(scrollSelected);
    else scrollSelected();
  }
}
