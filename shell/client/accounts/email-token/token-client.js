// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014-2016 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {
  loginWithEmailToken,
  createAndEmailTokenForUser,
} from "/imports/client/accounts/email-token/token-login-helpers.js";

// Email token login routes.
Router.route("/_emailLogin/:_email/:_token", function () {
  this.render("Loading");
  loginWithEmailToken(this.params._email, this.params._token, (err, resumePath) => {
    if (err) {
      this.render("_emailTokenError", {
        data: function () {
          return {
            error: err,
          };
        },
      });
    } else {
      const target = resumePath || "/";
      Router.go(target);
    }
  });
}, {
  // Specify a name in an attempt to fix bug reported here:
  //   https://twitter.com/fink_/status/709715523513270272
  //
  // The user reported an exception trace where IronRouter complained that the route "i" had been
  // registered twice, tracing back to routes in this file. Where did "i" come from? The problem
  // does not seem to be reproducible.
  //
  // It looks like IronRouter may decide to name the route based on the function name:
  //   https://github.com/iron-meteor/iron-middleware-stack/blob/master/lib/handler.js#L49
  //
  // Our function has no name, but perhaps minification can mess with that? An explicit name
  // in the options will take precedence, so do that.
  name: "_emailLogin",
});

Router.route("/_emailLinkIdentity/:_email/:_token/:_accountId", function () {
  this.render("Loading");
  if (this.state.get("error")) {
    this.render("_emailLinkIdentityError", { data: { error: this.state.get("error") } });
  } else {
    if (Meteor.userId() === this.params._accountId) {
      const allowLogin = this.params.query.allowLogin === "true";
      Meteor.call("linkEmailIdentityToAccount",
                  this.params._email, this.params._token, allowLogin, (err, resumePath) => {
                    if (err) {
                      this.state.set("error", err.toString());
                    } else {
                      const target = resumePath || "/account";
                      Router.go(target);
                    }
                  });
    } else {
      this.render("_emailLinkIdentityError");
    }
  }
}, {
  // See above.
  name: "_emailLinkIdentity",
});

Template.addNewVerifiedEmailPowerboxConfiguration.onCreated(function () {
  this.state = new ReactiveVar({ enterEmail: true });
  this.email = new ReactiveVar(null);
  this.token = new ReactiveVar(null);
  this.enterTokenMessage = new ReactiveVar(null);
  this.verifiedEmails = new ReactiveVar([]);
  const _this = this;
  this.autorun(() => {
    const result = [];
    SandstormDb.getUserIdentityIds(Meteor.user()).forEach((identityId) => {
      let identity = Meteor.users.findOne({ _id: identityId });
      if (identity && identity.services.email) {
        result.push(identity.services.email.email);
      }
    });
    _this.verifiedEmails.set(result);
  });
});

Template.addNewVerifiedEmailPowerboxConfiguration.helpers({
  state() {
    return Template.instance().state.get();
  },

  email() {
    return Template.instance().email.get();
  },

  token() {
    return Template.instance().token.get();
  },

  enterTokenMessage() {
    return Template.instance().enterTokenMessage.get();
  },

  alreadyVerified() {
    const instance = Template.instance();
    return instance.verifiedEmails.get().indexOf(instance.email.get()) > -1;
  },
});

Template.addNewVerifiedEmailPowerboxConfiguration.events({
  "input form[name='enter-email'] input[name='email']": function (event, instance) {
    instance.email.set(event.currentTarget.value);
  },

  "input form[name='enter-token'] input[name='token']": function (event, instance) {
    instance.token.set(event.currentTarget.value);
  },

  "submit form[name='enter-email']": function (event, instance) {
    event.preventDefault();
    const form = event.currentTarget;
    const email = form.email.value;

    instance.email.set(email);
    instance.state.set({ sendingEmail: true });

    const complete = () => {
      this.powerboxRequest.completeNewFrontendRef({
        verifiedEmail: {
          address: email,
          verifierId: instance.data.option.frontendRef.verifiedEmail.verifierId,
        },
      });
    };

    if (instance.verifiedEmails.get().indexOf(email) > -1) {
      complete();
    } else {
      instance.completionObserver = instance.autorun(() => {
        // If the user click the link in the email rather than copy/pasting the token,
        // we still want to be able to finish our flow.
        if (instance.verifiedEmails.get().indexOf(email) > -1) {
          complete();
        }
      });

      const loc = window.location;
      const resumePath = loc.pathname + loc.search + loc.hash;
      const options = { resumePath, linking: { allowLogin: false }, };
      createAndEmailTokenForUser(email, options, function (err) {
        if (err && err.error === "alreadySentEmailToken") {
          instance.enterTokenMessage.set(err.reason);
          instance.state.set({ enterToken: true });
        } else if (err) {
          instance.state.set({ enterEmail: true, error: err.reason || "Unknown error", });
        } else {
          instance.enterTokenMessage.set(
            "We've sent a confirmation e-mail to " + email +
              ". It may take a few moments for it to show up in your inbox.");
          instance.state.set({ enterToken: true, });
        }
      });
    }
  },

  "submit form[name='enter-token']": function (event, instance) {
    event.preventDefault();
    const form = event.currentTarget;
    const token = form.token.value;
    const email = instance.email.get();
    instance.state.set({ sendingToken: true });
    Meteor.call("linkEmailIdentityToAccount", email, token, false, function (err, result) {
      if (err && err.error !== "alreadyLinked") {
        instance.state.set({ enterToken: true, error: err.reason || "Unknown error", });
      }
    });
  },

  "click button[name='reset']": function (event, instance) {
    if (instance.completionObserver) {
      instance.completionObserver.stop();
    }

    instance.token.set(null);
    instance.email.set(null);
    instance.state.set({ enterEmail: true });
  },
});
