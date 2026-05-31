export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(() => {
    chrome.action.setTitle({ title: "EchoFlow" });
  });
});
