function downloadFile(url, suggestedFilename) {
  // Firefox for some reason decides to kill all websockets when we try to download the file
  // by navigating there. So we're left doing a dirty hack to get around the popup blocker.
  const isFirefox = typeof InstallTrigger !== "undefined";
  if (isFirefox) {
    const save = document.createElement("a");
    save.href = url;

    save.download = suggestedFilename;
    const evt = document.createEvent("MouseEvents");
    evt.initMouseEvent(
            "click", true, false, window, 0, 0, 0, 0, 0,
            false, false, false, false, 0, null
    );
    save.dispatchEvent(evt);
  } else {
    window.location = url;
  }
};

export default downloadFile;
