import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  // Local development remains available at `/`; production is hosted at
  // https://seu-link.fit/makeup/.
  base: command === "build" ? "/makeup/" : "/",
}));
