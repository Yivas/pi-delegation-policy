import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://yivas.github.io/pi-delegation-policy",
  base: "/pi-delegation-policy",
  integrations: [
    starlight({
      title: "pi-delegation-policy",
      description: "Configure delegation intensity and exact model roles for Pi.",
      editLink: {
        baseUrl: "https://github.com/Yivas/pi-delegation-policy/edit/main/wiki/",
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/Yivas/pi-delegation-policy",
        },
      ],
      sidebar: [
        {
          label: "Start here",
          items: ["index", "getting-started"],
        },
        {
          label: "Use the extension",
          items: ["configuration", "commands-and-status"],
        },
        {
          label: "Reference",
          items: ["limits-and-privacy"],
        },
        {
          label: "Project",
          items: [
            {
              label: "npm",
              link: "https://www.npmjs.com/package/pi-delegation-policy",
              attrs: { target: "_blank", rel: "noreferrer" },
            },
          ],
        },
      ],
      customCss: ["./src/styles/custom.css"],
    }),
  ],
});
