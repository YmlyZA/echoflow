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
    icons: {
      16: "/icon/16.png",
      32: "/icon/32.png",
      48: "/icon/48.png",
      128: "/icon/128.png"
    },
    action: {
      default_title: "EchoFlow",
      default_popup: "popup.html",
      default_icon: {
        16: "/icon/16.png",
        32: "/icon/32.png",
        48: "/icon/48.png",
        128: "/icon/128.png"
      }
    }
  }
});
