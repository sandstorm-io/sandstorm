/**
 * Based on:
 * Identicon.js v1.0
 * http://github.com/stewartlord/identicon.js
 *
 * Copyright 2013, Stewart Lord
 * Released under the BSD license
 * http://www.opensource.org/licenses/bsd-license.php
 */

// Trivially modified for Meteor context by Kenton Varda.
// Later modified to produce an SVG rather than a PNG.

class Identicon {
  constructor(hash, size, margin) {
    this.hash   = hash;
    this.size   = size   || 64;
    this.margin = margin || .08;
  }

  render() {
    const hash    = this.hash;
    const size    = this.size;
    const margin  = size * this.margin;
    const cell    = (size - (margin * 2)) / 5;

    const rects = [];

    // foreground is last 7 chars as hue at 50% saturation, 70% brightness
    const rgb     = this.hsl2rgb(parseInt(hash.substr(-7), 16) / 0xfffffff, .5, .7);
    const fg = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;

    // the first 15 characters of the hash control the pixels (even/odd)
    // they are drawn down the middle first, then mirrored outwards
    for (let i = 0; i < 15; i++) {
      if (!(parseInt(hash.charAt(i), 16) % 2)) {
        if (i < 5) {
          this.rectangle(2 * cell + margin, i * cell + margin, cell, cell, rects);
        } else if (i < 10) {
          this.rectangle(1 * cell + margin, (i - 5) * cell + margin, cell, cell, rects);
          this.rectangle(3 * cell + margin, (i - 5) * cell + margin, cell, cell, rects);
        } else if (i < 15) {
          this.rectangle(0 * cell + margin, (i - 10) * cell + margin, cell, cell, rects);
          this.rectangle(4 * cell + margin, (i - 10) * cell + margin, cell, cell, rects);
        }
      }
    }

    // We specify a non-zero stroke width to ensure that adjacent cells connect.
    const strokeWidth = size * 0.005;
    return `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">
            <rect style="fill:rgb(240,240,240)" x="0" y="0" width="${size}" height="${size}"/>
            <g style="fill:${fg};stroke-width:${strokeWidth};stroke:${fg};">
            ${rects.join("\n")}</g> </svg>`;
  }

  rectangle(x, y, w, h, rectangles) {
    rectangles.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`);
  }

  // adapted from: https://gist.github.com/aemkei/1325937
  hsl2rgb(h, s, b) {
    h *= 6;
    s = [
      b += s *= b < .5 ? b : 1 - b,
      b - h % 1 * s * 2,
      b -= s *= 2,
      b,
      b + h % 1 * s,
      b + s,
    ];

    return [
      Math.floor(s[~~h    % 6] * 256),  // red
      Math.floor(s[(h | 16) % 6] * 256),  // green
      Math.floor(s[(h | 8)  % 6] * 256),  // blue
    ];
  }

  toString() {
    return this.render();
  }
};

export default Identicon;
