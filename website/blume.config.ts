import { defineConfig } from "blume";

export default defineConfig({
  title: "agentsmith",
  description: "Assemble agent instructions and skills for every machine and repository.",
  content: { root: "docs" },
  theme: { accent: "emerald", radius: "md", mode: "system" },
  search: { provider: "orama" },
  markdown: {
    imageZoom: true,
    code: { icons: true, wrap: false },
    codeBlocks: { theme: { light: "github-light", dark: "github-dark" } },
  },
  ai: { llmsTxt: true },
  seo: { structuredData: true },
  navigation: {
    sidebar: [
      "/",
      { label: "Get started", items: ["/getting-started/install", "/getting-started/first-project", "/getting-started/global-setup"] },
      { label: "Use cases", items: ["/use-cases/choose-your-path", "/use-cases/personal-user", "/use-cases/skill-author", "/use-cases/project-maintainer", "/use-cases/feature-cookbook"] },
      { label: "Guides", items: ["/guides/projects-and-scopes", "/guides/packs-and-templates", "/guides/skills", "/guides/safe-workflows"] },
      { label: "Reference", items: ["/reference/configuration", "/reference/commands", "/reference/directives", "/reference/source-layout", "/reference/troubleshooting"] },
    ],
  },
});
