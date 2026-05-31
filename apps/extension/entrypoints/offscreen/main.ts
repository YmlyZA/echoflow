chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "echoflow:offscreen:ping") {
    return;
  }

  chrome.runtime.sendMessage({ type: "echoflow:offscreen:ready" });
});
