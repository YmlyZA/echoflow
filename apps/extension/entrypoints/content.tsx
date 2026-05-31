import { createRoot } from "react-dom/client";

function EchoFlowMount() {
  return null;
}

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  main() {
    const host = document.createElement("div");
    host.id = "echoflow-root";
    host.hidden = true;
    document.documentElement.append(host);

    createRoot(host).render(<EchoFlowMount />);
  }
});
