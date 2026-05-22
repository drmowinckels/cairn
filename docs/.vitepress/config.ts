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
    ["meta", { name: "theme-color", content: "#e07a5f" }],
  ],
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Architecture", link: "/architecture/" },
      { text: "Privacy", link: "/PRIVACY" },
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
      message: "Released under the Apache 2.0 License.",
      copyright: "Copyright © Athanasia Mowinckel",
    },
    search: { provider: "local" },
    editLink: {
      pattern: "https://github.com/drmowinckels/cairn/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
  },
});
