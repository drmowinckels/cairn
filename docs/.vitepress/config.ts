import { withMermaid } from "vitepress-plugin-mermaid";

export default withMermaid({
  title: "Cairn",
  description:
    "A quiet, local-first time tracker that watches your work signals so you don't have to.",
  base: "/",
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: ["future/**", "**/README.md"],
  ignoreDeadLinks: [/^\.?\/?future\//],
  head: [
    ["link", { rel: "icon", href: "/img/logo-favicon.svg", type: "image/svg+xml" }],
    ["meta", { name: "theme-color", content: "#3d405b" }],
    ["link", { rel: "preconnect", href: "https://fonts.googleapis.com" }],
    ["link", { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" }],
    [
      "link",
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400&family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap",
      },
    ],
  ],
  themeConfig: {
    logo: {
      light: "/img/logo-mark-light.svg",
      dark: "/img/logo-mark-dark.svg",
      alt: "Cairn",
    },
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Architecture", link: "/architecture/" },
      { text: "Install", link: "/guide/install" },
      {
        text: "Releases",
        link: "https://github.com/drmowinckels/cairn/releases",
      },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Guide",
          items: [
            { text: "Getting started", link: "/guide/getting-started" },
            { text: "Install", link: "/guide/install" },
            { text: "Privacy", link: "/PRIVACY" },
          ],
        },
      ],
      "/architecture/": [
        {
          text: "Architecture",
          items: [
            { text: "Overview", link: "/architecture/" },
            { text: "Rules engine", link: "/RULES_ENGINE" },
            { text: "Design spec", link: "/DESIGN_SPEC" },
            { text: "Release & signing", link: "/architecture/release" },
          ],
        },
      ],
      "/PRIVACY": [
        {
          text: "Reference",
          items: [
            { text: "Privacy contract", link: "/PRIVACY" },
            { text: "Rules engine", link: "/RULES_ENGINE" },
            { text: "Design spec", link: "/DESIGN_SPEC" },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/drmowinckels/cairn" },
    ],
    footer: {
      message:
        'Released under the Apache 2.0 License. <a href="/PRIVACY">Privacy</a> · <a href="/legal/terms">Terms</a>.',
      copyright: "Copyright © Athanasia Mowinckel",
    },
    search: { provider: "local" },
    editLink: {
      pattern: "https://github.com/drmowinckels/cairn/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
  },
});
