var svgns = "http://www.w3.org/2000/svg";

var factor = 4;

var firstLand = 0.5;
var firstComplete = 0.97;
var breakF = 0.751;

var logoX = 100;
var logoY = 250;
var sourceX = 200;
var sourceY = 250;
var sourceVX = 50;
var sourceVY = -50;
var spreadFactor = 0.1;
var minWidth = 10;

function interpolate(start, end, f) {
  return start * (1-f) + end * f;
}

function interpolateQ(start, mid, end, f) {
  return interpolate(interpolate(start, mid, f), interpolate(mid, end, f), f);
}

function interpolateC(start, mid1, mid2, end, f) {
  return interpolate(interpolateQ(start, mid1, mid2, f), interpolateQ(mid1, mid2, end, f), f);
}

function animateEject(element, p2x, p2y, targetX, targetY, startT, endT,
                      breakT) {
  var t = endT - startT;

  var p1x = sourceX + t * sourceVX;
  var p1y = sourceY + t * sourceVY;
  var shouldFreeze = false;
  var opacity = 1;
  var opaqueAfter = (endT - startT) / 2;

  if (breakT <= startT) {
    return;
  } else if (breakT <= endT) {
    var breakF = (breakT - startT) / (endT - startT);

    targetX = interpolateC(sourceX, p1x, p2x, targetX, breakF);
    targetY = interpolateC(sourceY, p1y, p2y, targetY, breakF);

    p2x = interpolateQ(sourceX, p1x, p2x, breakF);
    p2y = interpolateQ(sourceY, p1y, p2y, breakF);

    p1x = interpolate(sourceX, p1x, breakF);
    p1y = interpolate(sourceY, p1y, breakF);

    endT = breakT;

    if (opaqueAfter > endT - startT) {
      opacity = (endT - startT) / opaqueAfter;
      opaqueAfter = endT - startT;
    }

    shouldFreeze = true;
  }

  var a = document.createElementNS(svgns, "animateMotion");

  var path = "M " + sourceX + " " + sourceY +
      " C " + p1x + " " + p1y +
      " " + p2x + " " + p2y +
      " " + targetX + " " + targetY;

  a.setAttributeNS(null, "path", path);
  a.setAttributeNS(null, "begin", startT + "s")
  a.setAttributeNS(null, "dur", endT - startT + "s");
  if (shouldFreeze) {
    a.setAttributeNS(null, "fill", "freeze");
  }
  element.appendChild(a);

  var a = document.createElementNS(svgns, "animate");
  a.setAttributeNS(null, "attributeName", "fill-opacity");
  a.setAttributeNS(null, "from", "0");
  a.setAttributeNS(null, "to", opacity);
  a.setAttributeNS(null, "begin", startT + "s")
  a.setAttributeNS(null, "dur", opaqueAfter + "s");
  if (shouldFreeze) {
    a.setAttributeNS(null, "fill", "freeze");
  }
  element.appendChild(a);
}

function animateLinear(element, startX, startY, endX, endY, startT, endT, breakT, shouldFreeze) {
  if (breakT <= startT) {
    return;
  } else if (breakT < endT) {
    var breakF = (breakT - startT) / (endT - startT);

    endX = interpolate(startX, endX, breakF);
    endY = interpolate(startY, endY, breakF);

    endT = breakT;
    shouldFreeze = true;
  }

  var a = document.createElementNS(svgns, "animateMotion");

  var path = "M " + startX + " " + startY + " L " + endX + " " + endY;

  a.setAttributeNS(null, "path", path);
  a.setAttributeNS(null, "begin", startT + "s")
  a.setAttributeNS(null, "dur", endT - startT + "s");
  if (shouldFreeze) {
    a.setAttributeNS(null, "fill", "freeze");
  } else {
    a.setAttributeNS(null, "fill", "remove");
  }
  element.appendChild(a);
}

function hideAtT(element, t, breakT) {
  if (breakT > t) {
    var a = document.createElementNS(svgns, "animateMotion");

    // Chrome doesn't honor M 0 0 unless it is followed by some movement.
    var path = "M 0 -100 L -1 0";

    a.setAttributeNS(null, "path", path);
    a.setAttributeNS(null, "begin", t + "s")
    a.setAttributeNS(null, "dur", "1s");
    a.setAttributeNS(null, "fill", "freeze");
    element.appendChild(a);
  }
}

function composeRect(parent, eventName, x, y, width, startT, endT, vel, parentSpread, breakT) {
  // Animate the formation of a rectangle with the given properties, starting at time startT and
  // ending at time endT.  The final rectangle is moving at velocity vel.

  // The lower-left corner lands at interpolate(startT, endT, firstLand), and the upper-right
  // completes and endT.

  // Each piece completes at interpolate(startT, landingTime, completeF) where completeF
  // is firstComplete for the lower-left corner and 1.0 for the upper-right.

  var midT = interpolate(startT, endT, firstLand);
  var pieceWidth = width / factor;

  var maxLayer = factor * 2 - 2;

  var hasChildren = pieceWidth > minWidth;

  for (var i = 0; i < factor; i++) {
    for (var j = 0; j < factor; j++) {
      var layer = i + factor - j - 1;
      var layerF = layer / maxLayer;

      var spread = parentSpread + (i + j - 3) * spreadFactor;

      var endAt = interpolate(midT, endT, layerF);
      var remT = endT - endAt;
      var offset = remT * vel;
      var subVel = vel + 20;

      var endX = x + pieceWidth * i;
      var endY = y + pieceWidth * j;
      var midX = endX + offset + remT * vel * parentSpread;
      var midY = endY - offset + remT * vel * parentSpread;
      var startX;
      var startY;

      var flightTime = endAt - startT;

      var completeF = interpolate(firstComplete, 1.0, layerF);
      var startAt;
      var dur;
      if (hasChildren) {
        startAt = interpolate(startT, endAt, completeF);
        dur = endAt - startAt;
        startX = midX + dur * subVel + dur * subVel * spread;
        startY = midY - dur * subVel + dur * subVel * spread;
      } else {
        startAt = interpolate(startT, endAt, Math.random() * 0.9);
        dur = endAt - startAt;
        startX = midX + dur * subVel + dur * subVel * spread;
        startY = midY - dur * subVel + dur * subVel * spread;
      }

      var r = document.createElementNS(svgns, "rect");
      r.setAttributeNS(null, "width", pieceWidth * 1.05);
      r.setAttributeNS(null, "height", pieceWidth * 1.05);
      r.setAttributeNS(null, "x", 0);
      r.setAttributeNS(null, "y", -100);
      r.setAttributeNS(null, "fill", "#524444");

      var freezeAtMid = midX == endX && midY == endY;

      if (dur > 0) {
        if (hasChildren) {
          animateLinear(r, startX, startY, midX, midY, startAt, endAt, breakT, freezeAtMid);
        } else {
          animateEject(r, startX, startY, midX, midY, startAt, endAt, breakT);
        }
      }

      if (!freezeAtMid && endAt < endT) {
        animateLinear(r, midX, midY, endX, endY, endAt, endT, breakT);
      }

      hideAtT(r, endT, breakT);

      parent.appendChild(r);

      if (hasChildren) {
        composeRect(parent, eventName, startX, startY, pieceWidth,
            startT, startAt, subVel, spread, breakT)
      }
    }
  }
}

function doLogoAnimation(dense, extraDelay) {
  var svg = document.getElementsByTagName("svg")[0];
  var g = document.getElementById("grid");
  var delay = 0;
  if (g) {
    svg.removeChild(g);
  }
  g = document.createElementNS(svgns, "g");
  g.id = "grid";
  var t = svg.getCurrentTime() + 0.25 + extraDelay;
  if (dense) {
    minWidth = 2;
    t += 2;
  } else {
    minWidth = 10;
  }

  composeRect(g, "startGrid", logoX, logoY, 100, t, t + 5, 0, 0, t + 5 * breakF);
  svg.appendChild(g);

  document.getElementById("logo").className = "dynamic-logo";
}

function initLogoAnimation() {
  // Don't use logo animation on browsers that don't support SVG.
  // IE11 claims to support SVG but does not render the logo correctly, so blacklist it.
  if (document.implementation.hasFeature("http://www.w3.org/TR/SVG11/feature#BasicStructure", "1.1") &&
      navigator.userAgent.toLowerCase().indexOf('trident') === -1) {
    if (navigator.userAgent.toLowerCase().indexOf('firefox') > -1) {
      // Firefox needs some extra time to avoid stuttering.
      doLogoAnimation(false, 1);
    } else {
      doLogoAnimation(false, 0);
    }
  } else {
    document.getElementById("logo").className = "static-logo";
  }
}
