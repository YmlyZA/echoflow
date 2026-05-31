import { defineConfig } from "wxt";

export default defineConfig({
  manifestVersion: 3,
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "EchoFlow",
    description: "Real-time bilingual subtitles for tab audio.",
    version: "0.0.1",
    permissions: ["activeTab", "storage", "tabCapture", "offscreen", "scripting"],
    action: {
      default_title: "EchoFlow"
    }
  }
});
