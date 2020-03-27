import Identicon from "./identicon.js";

const VALID_USAGES = ["appGrid", "grain", "notification"];
function checkUsage(usage) {
  if (VALID_USAGES.indexOf(usage) === -1) throw new Error("Invalid icon usage.");
}

function iconFromManifest(manifest, usage) {
  // TODO: select by usage location, rather than assuming appGrid
  const icons = manifest && manifest.metadata && manifest.metadata.icons ?
      manifest.metadata.icons : undefined;
  if (icons) {
    if (usage === "appGrid" || usage === "notification") {
      return icons.appGrid;
    } else if (usage === "grain") {
      return icons.grain || icons.appGrid;
    }
  }

  return undefined;
}

function hashAppIdForIdenticon(id) {
  // "Hash" an app ID to a 32-digit hex string for the purpose of
  // producing an identicon. Since app IDs are already high-
  // entropy base32 strings, we simply turn each of the first
  // 32 digits to base16 by chopping off a bit.

  if (!id) return "00000000000000000000000000000000";

  result = [];
  const digits16 = "0123456789abcdef";
  const digits32 = "0123456789acdefghjkmnpqrstuvwxyz";
  for (let i = 0; i < 32; i++) {
    result.push(digits16[digits32.indexOf(id[i]) % 16]);
  }

  return result.join("");
}

// Keep a static global cache of all app identicons produced in this way.
// If memory usage is excessive, we can revisit this decision.
const cachedIdenticons = {};
function cachedIdenticon(hashedAppId, size) {
  const cacheKey = hashedAppId + "-" + size;
  if (!cachedIdenticons[cacheKey]) {
    const data = new Identicon(hashedAppId, size).toString();
    cachedIdenticons[cacheKey] = "data:image/svg+xml," + encodeURIComponent(data);
  }

  return cachedIdenticons[cacheKey];
}

function identiconForApp(appId, usage) {
  const size = (usage === "appGrid" ? 128 : 24);
  return cachedIdenticon(hashAppIdForIdenticon(appId), size);
}

function bytesToBase64(bytes) {
  const arr = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    arr[i] = String.fromCharCode(bytes[i]);
  }
  // Note that btoa is not available in IE9.  We may want to polyfill this.
  const result = btoa(arr.join(""));
  return result;
}

function iconSrcFor(appId, iconObj, staticPrefix, usage) {
  if (iconObj === undefined || iconObj === null) {
    // Return a identicon src based on hashing appId instead.
    // (We hash the appID even though it's already a hash because it's not hex)
    return identiconForApp(appId, usage);
  }

  // TODO(someday): Actually choose the best DPI.
  const assetId = iconObj.assetId2xDpi || iconObj.assetId;
  if (assetId) {
    const src = staticPrefix + "/" + assetId;
    return src;
  }

  if (iconObj.svg) {
    // iconObj.svg is a text string, so we can base64 it directly
    // Note that btoa is not available in IE9.  We may want to polyfill this.
    return "data:image/svg+xml;base64," + btoa(iconObj.svg);
  }

  if (iconObj.png) {
    // TODO(someday): Actually choose the best DPI.
    const png = iconObj.png.dpi2x || iconObj.png.dpi1x;
    let data;
    if (png) {
      // png is a Uint8Array, so we need to convert it to text before calling btoa.
      // Yes, the irony is profound.
      data = bytesToBase64(png);
      return "data:image/png;base64," + data;
    }
  }
  // We should never reach here, but do something sensible anyway
  return identiconForApp(appId, usage);
}

function iconSrcForPackage(pkg, usage, staticPrefix) {
  // Works for regular packages and dev packages.

  checkUsage(usage);
  const iconObj = iconFromManifest(pkg.manifest, usage);
  return iconSrcFor(pkg.appId, iconObj, staticPrefix, usage);
}

function iconSrcForDenormalizedGrainMetadata(metadata, usage, staticPrefix) {
  return iconSrcFor(metadata.appId, metadata.icon, staticPrefix, usage);
}

export {
    hashAppIdForIdenticon,
    identiconForApp,
    iconSrcForPackage,
    iconSrcForDenormalizedGrainMetadata,
};
