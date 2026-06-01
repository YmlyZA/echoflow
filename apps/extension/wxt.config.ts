import { defineConfig } from "wxt";

export default defineConfig({
  manifestVersion: 3,
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "EchoFlow",
    description: "Real-time bilingual subtitles for tab audio.",
    version: "0.0.1",
    permissions: ["activeTab", "storage", "tabCapture", "offscreen", "scripting"],
    host_permissions: ["http://127.0.0.1/*", "http://localhost/*"],
    action: {
      default_title: "EchoFlow"
    }
  }
});
