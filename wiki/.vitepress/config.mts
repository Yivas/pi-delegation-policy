import { defineConfig } from "vitepress";

const siteUrl = "https://yivas.github.io/pi-delegation-policy/";
const base = "/pi-delegation-policy/";

export default defineConfig({
  lang: "en-US",
  title: "pi-delegation-policy",
  description:
    "Configure delegation intensity, exact role model references, and optional thinking policies for Pi.",
  base,
  vite: {
    server: { host: "127.0.0.1" },
    preview: { host: "127.0.0.1" },
  },
  head: [["link", { rel: "icon", href: `${base}favicon.svg` }]],
  sitemap: { hostname: siteUrl },
  transformPageData(pageData) {
    const route = pageData.relativePath.replace(/index\.md$/, "").replace(/\.md$/, "");
    const canonical = new URL(route, siteUrl).href;
    pageData.frontmatter.head ??= [];
    pageData.frontmatter.head.push(["link", { rel: "canonical", href: canonical }]);
  },
  themeConfig: {
    nav: [
      { text: "Getting started", link: "/getting-started/" },
      { text: "Configuration", link: "/configuration/" },
      { text: "GitHub", link: "https://github.com/Yivas/pi-delegation-policy" },
    ],
    sidebar: [
      {
        text: "Start here",
        items: [
          { text: "Introduction", link: "/" },
          { text: "Getting started", link: "/getting-started/" },
        ],
      },
      {
        text: "Use the extension",
        items: [
          { text: "Configuration", link: "/configuration/" },
          { text: "Commands and status", link: "/commands-and-status/" },
        ],
      },
      { text: "Reference", items: [{ text: "Limits and privacy", link: "/limits-and-privacy/" }] },
      {
        text: "Project",
        items: [{ text: "npm", link: "https://www.npmjs.com/package/pi-delegation-policy" }],
      },
    ],
    search: { provider: "local" },
    outline: { level: [2, 3] },
    editLink: {
      pattern: "https://github.com/Yivas/pi-delegation-policy/edit/main/wiki/:path",
    },
  },
});
