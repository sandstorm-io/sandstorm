var VALID_USAGES = ["appGrid", "grain"];
var checkUsage = function(usage) {
  if (VALID_USAGES.indexOf(usage) === -1) throw new Error("Invalid icon usage.");
};

var iconFromManifest = function(manifest, usage) {
  // TODO: select by usage location, rather than assuming appGrid
  var icons = manifest && manifest.metadata && manifest.metadata.icons ?
      manifest.metadata.icons : undefined;
  if (icons) {
    if (usage === "appGrid") {
      return icons.appGrid;
    } else if (usage === "grain") {
      return icons.grain || icons.appGrid;
    }
  }
  return undefined;
};

var identiconForApp = function (appId, usage) {
  var size = (usage === "appGrid" ? 128 : 24);
  var data = new Identicon(CryptoJS.SHA256(appId).toString(), size).toString();
  return "data:image/png;base64," + data;
};

var bytesToBase64 = function(bytes) {
  var arr = new Array(bytes.length);
  for (var i = 0; i < bytes.length ; i++) {
    arr[i] = String.fromCharCode(bytes[i]);
  }
  // Note that btoa is not available in IE9.  We may want to polyfill this.
  var result = btoa(arr.join(""));
  return result;
};

var iconSrcFor = function (appId, iconObj, staticHost, usage) {
  if (iconObj === undefined) {
    // Return a identicon src based on hashing appId instead.
    // (We hash the appID even though it's already a hash because it's not hex)
    return identiconForApp(appId, usage);
  }
  if (iconObj.assetId) {
    var src = window.location.protocol + "//" + staticHost + "/" + iconObj.assetId;
    return src;
  }
  if (iconObj.svg) {
    // iconObj.svg is a text string, so we can base64 it directly
    // Note that btoa is not available in IE9.  We may want to polyfill this.
    return "data:image/svg+xml;base64," + btoa(iconObj.svg);
  }
  if (iconObj.png) {
    var png = iconObj.png.dpi2x || iconObj.png.dpi1x;
    var data;
    if (png) {
      // png is a Uint8Array, so we need to convert it to text before calling btoa.
      // Yes, the irony is profound.
      data = bytesToBase64(png);
      return "data:image/png;base64," + data;
    }
  }
  // We should never reach here, but do something sensible anyway
  return identiconForApp(appId);
};

iconSrcForPackage = function (pkg, usage, staticHost) {
  checkUsage(usage);
  // N.B. only works for installed packages, for dev packages use iconSrcForDevPackage
  var iconObj = iconFromManifest(pkg.manifest, usage);
  return iconSrcFor(pkg.appId, iconObj, staticHost, usage);
};

iconSrcForDevPackage = function (devpkg, usage, staticHost) {
  checkUsage(usage);
  var iconObj = iconFromManifest(devpkg.manifest, usage);
  return iconSrcFor(devpkg._id, iconObj, staticHost, usage);
};
