import { Meteor } from "meteor/meteor";
import Zlib from "zlib";
import Identicon from "./identicon";

const gzipSync = Meteor.wrapAsync(Zlib.gzip, Zlib);

// Because identicons are so simple, we can save a lot of bandwidth by applying compression
// before sending them from the server to the client. The PNG format has built-in support for
// lossless compression, but indenticon.js does not take advantage of it. We could work around
// that fact by roundtripping the PNGs through a more complete library like pngjs, or we could
// just apply gzip on top of the suboptimal PNG. We opt for the latter approach.
class ServerIdenticon extends Identicon {
  asAsset() {
    return {
      mimeType: "image/svg+xml",
      content: gzipSync(new Buffer(this.render())),
      encoding: "gzip",
    };
  }
}

export default ServerIdenticon;
