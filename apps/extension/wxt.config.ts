import { defineConfig } from "wxt";

// Release builds inject the full version (including any prerelease suffix) via
// EF_VERSION_NAME; the release workflow sets it from the git tag. WXT derives
// the Chrome-legal numeric `version` from version_name itself (stripping any
// -suffix) and only emits version_name when it differs. Dev/local builds fall
// back to a static 0.0.0.
const versionName = process.env.EF_VERSION_NAME;

export default defineConfig({
  manifestVersion: 3,
  modules: ["@wxt-dev/module-react"],
  zip: {
    // Deterministic artifact name regardless of the scoped package name:
    // echoflow-<version>-chrome.zip
    name: "echoflow"
  },
  manifest: {
    name: "EchoFlow",
    description: "Real-time bilingual subtitles for tab audio.",
    ...(versionName ? { version_name: versionName } : { version: "0.0.0" }),
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
