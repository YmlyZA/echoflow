import { createRoot } from "react-dom/client";

function OptionsApp() {
  return (
    <main>
      <h1>EchoFlow</h1>
    </main>
  );
}

const root = document.getElementById("root");

if (root) {
  createRoot(root).render(<OptionsApp />);
}
