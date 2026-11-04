// Theme: the day view by default, the saved choice wins. Mirrors witharosa.ai.
const html = document.documentElement;
const themeBtn = document.getElementById("theme");
if (themeBtn) {
  const syncTheme = () => {
    const dark = html.classList.contains("dark");
    // Attribute, not the .hidden property: WebKit does not reflect the
    // property to the attribute on SVG elements.
    themeBtn.querySelector(".sun").toggleAttribute("hidden", dark);
    themeBtn.querySelector(".moon").toggleAttribute("hidden", !dark);
    themeBtn.setAttribute("aria-pressed", String(dark));
    const action = dark ? "Switch to light mode" : "Switch to dark mode";
    themeBtn.setAttribute("aria-label", action);
    themeBtn.querySelector(".rail-label").textContent = action;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", dark ? "#161616" : "#f9f9f9");
  };
  themeBtn.addEventListener("click", () => {
    html.classList.toggle("dark");
    try { localStorage.theme = html.classList.contains("dark") ? "dark" : "light"; } catch (e) {}
    syncTheme();
  });
  syncTheme();
}
