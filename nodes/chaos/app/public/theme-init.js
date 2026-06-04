/* eslint-env browser */
/* global window, document, localStorage */
// Theme initialization script to prevent FOUC (Flash of Unstyled Content)
// Must run synchronously before React hydration to apply theme class
(() => {
  try {
    const theme = localStorage.getItem("theme") || "dark";
    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)")
      .matches
      ? "dark"
      : "light";
    const resolved = theme === "system" ? systemTheme : theme;
    if (resolved === "dark") document.documentElement.classList.add("dark");
  } catch {
    // ignore
  }
})();
