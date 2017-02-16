// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2017 Sandstorm Development Group, Inc. and contributors
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

const prepareViewInfoForDisplay = function (viewInfo) {
  const result = _.clone(viewInfo || {});
  if (result.permissions) indexElements(result.permissions);
  // It's essential that we index the roles *before* hiding obsolete roles,
  // or else we'll produce the incorrect roleAssignment for roles that are
  // described after obsolete roles in the pkgdef.
  if (result.roles) {
    indexElements(result.roles);
    result.roles = removeObsolete(result.roles);
  }

  return result;
};

const indexElements = function (arr) {
  // Helper function to annotate an array of objects with their indices
  for (let i = 0; i < arr.length; i++) {
    arr[i].index = i;
  }
};

const removeObsolete = function (arr) {
  // remove entries from the list that are flagged as obsolete
  return _.filter(arr, function (el) {
    return !el.obsolete;
  });
};

Template.ipNetworkPowerboxCard.helpers({
  encryption: function () {
    const encryption = this.option.frontendRef.ipNetwork.encryption || {};
    if ("tls" in encryption) {
      return "TLS";
    } else {
      return null;
    }
  },
});

Template.grainPowerboxCard.powerboxIconSrc = card => {
  return card.grainInfo.iconSrc;
};

Template.uiViewPowerboxConfiguration.onCreated(function () {
  // this.data is a card; see filteredCardData()

  this._choseHostedObject = new ReactiveVar(false);

  this._viewInfo = new ReactiveVar({});

  // Fetch the view info for the grain.
  if (this.data.grainInfo.cachedViewInfo) {
    this._viewInfo.set(prepareViewInfoForDisplay(this.data.grainInfo.cachedViewInfo));
  } else if (this.data.grainInfo.apiTokenId) {
    Meteor.call("getViewInfoForApiToken", this.data.grainInfo.apiTokenId, (err, result) => {
      if (err) {
        console.log(err);
        this.data.powerboxRequest.failRequest(err);
      } else {
        this._viewInfo.set(prepareViewInfoForDisplay(result));
      }
    });
  }
});

Template.uiViewPowerboxConfiguration.helpers({
  choseHostedObject: function () {
    return !this.option.uiView || Template.instance()._choseHostedObject.get();
  },

  viewInfo: function () {
    return Template.instance()._viewInfo.get();
  },

  setupIframe: function () {
    // HACK: A GrainView iframe has to be managed outside of the usual Blaze template flow and
    //   reactive contexts. We manually attach the iframe as a child of the "powerbox-iframe-mount"
    //   div and hope that that div doesn't get re-rendered unexpectedly.
    // TODO(cleanup): This is terrible but what else can we do?
    const tmpl = Template.instance();
    Meteor.defer(() => {
      if (!tmpl._grainView) {
        const mount = tmpl.find(".powerbox-iframe-mount");
        const powerboxRequest = {
          descriptors: this.powerboxRequest.getQuery(),
          requestingSession: this.powerboxRequest.getSessionId(),
        };
        tmpl._grainView = new this.powerboxRequest.GrainView(
            null, this.db, this.option.grainId, "", null, mount, { powerboxRequest });
        tmpl._grainView.setActive(true);
        tmpl._grainView.openSession();

        this.powerboxRequest.onFinalize(() => {
          tmpl._grainView.destroy();
        });

        tmpl.autorun(() => {
          const fulfilledInfo = tmpl._grainView.fulfilledInfo();
          if (fulfilledInfo) {
            this.powerboxRequest.completeRequest(fulfilledInfo.token, fulfilledInfo.descriptor);
          }
        });
      }
    });
  },
});

Template.uiViewPowerboxConfiguration.events({
  "click .connect-button": function (event) {
    event.preventDefault();
    const selectedInput = Template.instance().find('form input[name="role"]:checked');
    if (selectedInput) {
      let roleAssignment;
      if (selectedInput.value === "all") {
        roleAssignment = { allAccess: null };
      } else {
        const role = parseInt(selectedInput.value, 10);
        roleAssignment = { roleId: role };
      }

      this.powerboxRequest.completeUiView(this.option.grainId, roleAssignment);
    }
  },

  "click .choose-hosted-object": function (event, tmpl) {
    event.preventDefault();
    tmpl._choseHostedObject.set(true);
  },
});

const isSubsetOf = function (p1, p2) {
  for (let idx = 0; idx < p1.length; ++idx) {
    if (p1[idx] && !p2[idx]) {
      return false;
    }
  }

  return true;
};

Template.identityPowerboxConfiguration.helpers({
  sufficientRoles: function () {
    const requestedPermissions = this.option.requestedPermissions;

    const session = this.db.collections.sessions.findOne(
      { _id: this.powerboxRequest._requestInfo.sessionId, });
    const roles = prepareViewInfoForDisplay(session.viewInfo).roles;

    return roles && roles.filter(r => isSubsetOf(requestedPermissions, r.permissions));
  },
});

Template.identityPowerboxConfiguration.events({
  "click .connect-button": function (event, instance) {
    event.preventDefault();
    const selectedInput = instance.find('form input[name="role"]:checked');
    if (selectedInput) {
      let roleAssignment;
      if (selectedInput.value === "all") {
        roleAssignment = { allAccess: null };
      } else {
        const role = parseInt(selectedInput.value, 10);
        roleAssignment = { roleId: role };
      }

      this.powerboxRequest.completeNewFrontendRef({
        identity: {
          id: instance.data.option.frontendRef.identity,
          roleAssignment,
        },
      });
    }
  },
});

Template.identityPowerboxCard.powerboxIconSrc = card => {
  return card.option.profile.pictureUrl;
};

Template.emailVerifierPowerboxCard.helpers({
  serviceTitle: function () {
    const services = this.option.frontendRef.emailVerifier.services;
    const name = services[0];
    const service = Accounts.identityServices[name];
    if (service.loginTemplate.name === "oauthLoginButton") {
      return service.loginTemplate.data.displayName;
    } else if (name === "email") {
      return "passwordless e-mail login";
    } else if (name === "ldap") {
      return "LDAP";
    } else {
      return name;
    }
  },
});

Template.emailVerifierPowerboxCard.powerboxIconSrc = () => "/email-m.svg";
Template.verifiedEmailPowerboxCard.powerboxIconSrc = () => "/email-m.svg";
Template.addNewVerifiedEmailPowerboxCard.powerboxIconSrc = () => "/add-email-m.svg";

Template.httpUrlPowerboxCard.powerboxIconSrc = () => "/web-m.svg";

Template.httpArbitraryPowerboxCard.powerboxIconSrc = () => "/web-m.svg";
Template.httpArbitraryPowerboxConfiguration.events({
  "click .connect-button": function (event, instance) {
    event.preventDefault();
    const input = instance.find("form>input.url");

    this.powerboxRequest.completeNewFrontendRef({
      http: {
        url: input.value,
        auth: { none: null },
      },
    });
  },
});

Template.httpOAuthPowerboxCard.powerboxIconSrc = () => "/web-m.svg";
Template.httpOAuthPowerboxConfiguration.onCreated(function () {
  const option = this.data.option;

  const serviceMap = { google: Google, github: Github };

  const serviceHandler = serviceMap[option.oauthServiceInfo.service];

  if (!serviceHandler) {
    throw new Error("unknown service: " + option.oauthServiceInfo.service);
  }

  serviceHandler.requestCredential({
    loginStyle: "popup",
    requestPermissions: option.oauthScopes.map(scope => scope.name),

    // Google-specific options... others should ignore.
    forceApprovalPrompt: true,
    requestOfflineToken: true,
  }, credentialToken => {
    const credentialSecret = OAuth._retrieveCredentialSecret(credentialToken);
    this.data.powerboxRequest.completeNewFrontendRef({
      http: {
        url: option.httpUrl,
        auth: { oauth: { credentialToken, credentialSecret } },
      },
    });
  });
});
