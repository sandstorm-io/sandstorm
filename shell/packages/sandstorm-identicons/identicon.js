/**
 * Identicon.js v1.0
 * http://github.com/stewartlord/identicon.js
 *
 * Requires PNGLib
 * http://www.xarg.org/download/pnglib.js
 *
 * Copyright 2013, Stewart Lord
 * Released under the BSD license
 * http://www.opensource.org/licenses/bsd-license.php
 */

// (Trivially modified for Meteor context by Kenton Varda.)
// jscs:disable

Identicon = function(hash, size, margin){
    this.hash   = hash;
    this.size   = size   || 64;
    this.margin = margin || .08;
}

Identicon.prototype = {
    hash:   null,
    size:   null,
    margin: null,

    render: function(){
        var hash    = this.hash,
            size    = this.size,
            cell    = Math.floor((size - (size * this.margin * 2)) / 5),
            margin  = Math.floor((size - 5 * cell) / 2);
            image   = new PNGlib(size, size, 256);

        // light-grey background
        var bg      = image.color(240, 240, 240);

        // foreground is last 7 chars as hue at 50% saturation, 70% brightness
        var rgb     = this.hsl2rgb(parseInt(hash.substr(-7), 16) / 0xfffffff, .5, .7),
            fg      = image.color(rgb[0] * 255, rgb[1] * 255, rgb[2] * 255);

        // the first 15 characters of the hash control the pixels (even/odd)
        // they are drawn down the middle first, then mirrored outwards
        var i, color;
        for (i = 0; i < 15; i++) {
            color = parseInt(hash.charAt(i), 16) % 2 ? bg : fg;
            if (i < 5) {
                this.rectangle(2 * cell + margin, i * cell + margin, cell, cell, color, image);
            } else if (i < 10) {
                this.rectangle(1 * cell + margin, (i - 5) * cell + margin, cell, cell, color, image);
                this.rectangle(3 * cell + margin, (i - 5) * cell + margin, cell, cell, color, image);
            } else if (i < 15) {
                this.rectangle(0 * cell + margin, (i - 10) * cell + margin, cell, cell, color, image);
                this.rectangle(4 * cell + margin, (i - 10) * cell + margin, cell, cell, color, image);
            }
        }

        return image;
    },

    rectangle: function(x, y, w, h, color, image) {
        var i, j;
        for (i = x; i < x + w; i++) {
            for (j = y; j < y + h; j++) {
                image.buffer[image.index(i, j)] = color;
            }
        }
    },

    // adapted from: https://gist.github.com/aemkei/1325937
    hsl2rgb: function(h, s, b){
        h *= 6;
        s = [
            b += s *= b < .5 ? b : 1 - b,
            b - h % 1 * s * 2,
            b -= s *= 2,
            b,
            b + h % 1 * s,
            b + s
        ];

        return[
            s[ ~~h    % 6 ],  // red
            s[ (h|16) % 6 ],  // green
            s[ (h|8)  % 6 ]   // blue
        ];
    },

    toString: function(){
        return this.render().getBase64();
    }
}

if (Meteor.isServer) {
  // Because identicons are so simple, we can save a lot of bandwidth by applying compression
  // before sending them from the server to the client. The PNG format has built-in support for
  // lossless compression, but indenticon.js does not take advantage of it. We could work around
  // that fact by roundtripping the PNGs through a more complete library like pngjs, or we could
  // just apply gzip on top of the suboptimal PNG. We opt for the latter approach.
  const Zlib = Npm.require("zlib");
  const gzipSync = Meteor.wrapAsync(Zlib.gzip, Zlib);

  Identicon.prototype.asAsset = function() {
    return {
      mimeType: "image/png",
      content: gzipSync(new Buffer(this.render().getDump(), "binary")),
      encoding: "gzip",
    };
  }
}
