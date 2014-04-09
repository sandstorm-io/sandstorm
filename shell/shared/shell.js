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

// This file implements the common shell components such as the top bar.
// It also covers the root page.

browseHome = function() {
  Router.go("root");
}

if (Meteor.isServer) {
  Meteor.publish("grainsMenu", function () {
    if (this.userId) {
      return [
        UserActions.find({userId: this.userId}),
        Grains.find({userId: this.userId})
      ];
    } else {
      return [];
    }
  });

  Meteor.publish("hasUsers", function () {
    // Publish pseudo-collection which tells the client if there are any users at all.
    //
    // TODO(cleanup):  This seems overcomplicated.  Does Meteor have a better way?
    var cursor = Meteor.users.find();
    var self = this;
    if (cursor.count() > 0) {
      self.added("hasUsers", "hasUsers", {hasUsers: true});
    } else {
      var handle = cursor.observeChanges({
        added: function (id) {
          self.added("hasUsers", "hasUsers", {hasUsers: true});
          handle.stop();
          handle = null;
        }
      });
      self.onStop(function () {
        if (handle) handle.stop();
      });
    }
    self.ready();
  });
}

if (Meteor.isClient) {
  HasUsers = new Meteor.Collection("hasUsers");  // dummy collection defined above

  Template.root.events({
    "click #logo": function (event) {
      doLogoAnimation(event.shiftKey, 0);
    }
  });

  Deps.autorun(function () {
    Meteor.subscribe("grainsMenu");
    Meteor.subscribe("credentials");
  });

  Template.grainList.events({
    "click #apps-ico": function (event) {
      Session.set("grainMenuOpen", true);
    },

    "click #close-apps": function (event) {
      Session.set("grainMenuOpen", false);
    },

    "click .newGrain": function (event) {
      var id = event.currentTarget.id.split("-")[1];
      var action = UserActions.findOne(id);
      if (!action) {
        console.error("no such action: ", id);
        return;
      }

      Session.set("grainMenuOpen", false);
      var title = window.prompt("Title?");
      if (!title) return;

      // We need to ask the server to start a new grain, then browse to it.
      Meteor.call("newGrain", action.packageId, action.command, title, function (error, grainId) {
        if (error) {
          console.error(error);
        } else {
          Router.go("grain", {grainId: grainId});
        }
      });
    },

    "click .openGrain": function (event) {
      var grainId = event.currentTarget.id.split("-")[1];
      Session.set("grainMenuOpen", false);
      Router.go("grain", {grainId: grainId});
    },

    "click #installAppsLink": function (event) {
      document.location = "http://sandstorm.io/apps/?host=" + document.location.origin;
    },

    "click #emailInvitesLink": function (event) {
      Session.set("grainMenuOpen", false);
      Router.go("invite", {});
    },

    "click #urlInvitesLink": function (event) {
      Session.set("grainMenuOpen", false);
      Router.go("signupMint", {});
    }
  });

  Template.grainList.helpers({
    grains: function () {
      var userId = Meteor.userId();
      if (userId) {
        return Grains.find({userId: userId}).fetch();
      } else {
        return [];
      }
    },
    actions: function () {
      var userId = Meteor.userId();
      if (userId) {
        return UserActions.find({userId: userId}).fetch();
      } else {
        return [];
      }
    },
    menuOpen: function () {
      return Session.get("grainMenuOpen");
    },
    isAdmin: isAdmin
  });
}

Router.configure({
  notFoundTemplate: "notFound",
  loadingTemplate: "loading"
});

if (Meteor.isClient) {
  Router.onBeforeAction("loading");
}

Router.map(function () {
  this.route("root", {
    path: "/",
    waitOn: function () {
      return [ Meteor.subscribe("credentials"), Meteor.subscribe("hasUsers") ];
    },
    onAfterAction: function () { setTimeout(initLogoAnimation, 0); },
    data: function () {
      return {
        host: document.location.host,
        origin: document.location.origin,
        isSignedUp: isSignedUp(),
        isAdmin: isAdmin(),
        isFirstRun: !HasUsers.findOne("hasUsers")
      };
    }
  });

  this.route("linkHandler", {
    path: "/link-handler/:url",

    data: function () {
      var url = this.params.url;
      if (url.lastIndexOf("web+sandstorm:", 0) === 0) {
        url = url.slice("web+sandstorm:".length);
      }
      // TODO(cleanup):  Didn't use Router.go() because the url may contain a query term.
      document.location = "/install/" + url;
      return {};
    }
  });
});
