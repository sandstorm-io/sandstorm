// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014, Kenton Varda <temporal@gmail.com>
// All rights reserved.
//
// This file is part of the Sandstorm platform implementation.
//
// Sandstorm is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// Sandstorm is distributed in the hope that it will be useful, but
// WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
// Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public
// License along with Sandstorm.  If not, see
// <http://www.gnu.org/licenses/>.

// This file implements /grain, i.e. the main view into an app.

if (Meteor.isServer) {
  Grains.allow({
    update: function (userId, grain, fieldNames) {
      // Allow owner to rename grain.
      return userId && grain.userId === userId &&
          fieldNames.length === 1 && fieldNames[0] === "title";
    }
  });

  Meteor.publish("grainTitle", function (grainId) {
    // You can get the title of an arbitrary grain by ID, but we hide the other metadata, because:
    // - Revealing the package ID would allow anyone with whom you share a grain to install the
    //   same app, preventing private apps.
    // - Revealing the owner's user ID might be undesirable for plausible deniability reasons.
    return Grains.find({_id: grainId}, {
      fields: { title: 1 }
    });
  });
}

Meteor.methods({
  deleteGrain: function (grainId) {
    if (this.userId) {
      var grain = Grains.findOne({_id: grainId, userId: this.userId});
      if (grain) {
        Grains.remove(grainId);
        if (!this.isSimulation) {
          deleteGrain(grainId);
        }
      }
    }
  }
});

if (Meteor.isClient) {
  Template.grain.preserve(["iframe"]);
  Template.grain.events({
    "click #renameGrain": function (event) {
      var title = window.prompt("Set new title:");
      if (title) {
        Grains.update(this.grainId, {$set: {title: title}});
      }
    },
    "click #deleteGrain": function (event) {
      if (window.confirm("Really delete this grain?")) {
        Meteor.call("deleteGrain", this.grainId);
      }
    }
  });

  // Send keep-alive every now and then.
  var currentSessionId;
  Meteor.setInterval(function () {
    if (currentSessionId) {
      // TODO(soon):  Investigate what happens in background tabs.  Maybe arrange to re-open the
      //   app if it dies while in the background.
      console.log("keepalive: ", new Date());
      Meteor.call("keepSessionAlive", currentSessionId, function (error, result) {
        if (!result) {
          // TODO(soon):  Make a UI for this.
          console.error("Session seems to have died.  Please reload to fix.");
        }
      });
    }
  }, 60000);
}

Router.map(function () {
  this.route("grain", {
    path: "/grain/:grainId",

    waitOn: function () {
      // TODO(perf):  Do these subscriptions get stop()ed when the user browses away?
      return Meteor.subscribe("grainTitle", this.params.grainId);
    },

    data: function () {
      currentSessionId = undefined;
      var grainId = this.params.grainId;
      var grain = Grains.findOne(grainId);
      if (!grain) {
        return { grainId: grainId, title: "Invalid Grain", error: "No such grain." };
      }

      var result = {
        grainId: grainId,
        title: grain.title,
        isOwner: grain.userId && grain.userId === Meteor.userId()
      };

      var err = Session.get("session-" + grainId + "-error");
      if (err) {
        result.error = err;
        return result;
      }

      var session = Session.get("session-" + grainId);
      if (session) {
        currentSessionId = session.sessionId;

        if (document.location.protocol === "http:") {
          // Probably localhost, or a private server behind a firewall.  Connect to port directly,
          // because user may not have custom DNS.
          result.appOrigin = "http://" + document.location.hostname + ":" + session.port;
        } else if (document.location.protocol === "https:") {
          // HTTPS.  Probably internet server.  Assume that https://$host-$port.$domain is set up
          // to proxy to http://$host.$domain:$port.
          var originParts = document.location.hostname.split(".");
          originParts[0] += "-" + session.port;
          result.appOrigin = "https://" + originParts.join(".");
        } else {
          result.error = "Not using HTTP nor HTTPS; don't know what to do.";
        }

        result.sessionId = session.sessionId;
        return result;
      } else {
        Meteor.call("openSession", grainId, function (error, session) {
          if (error) {
            Session.set("session-" + grainId + "-error", error.message);
          } else {
            Session.set("session-" + grainId, session);
            Session.set("session-" + grainId + "-error", undefined);
          }
        });
        return result;
      }
    },

    unload: function () {
      currentSessionId = undefined;
    }
  });
});
