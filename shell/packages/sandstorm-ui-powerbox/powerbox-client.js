// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2016 Sandstorm Development Group, Inc. and contributors
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

const PowerboxOptions = new Mongo.Collection("powerboxOptions");

SandstormPowerboxRequest = class SandstormPowerboxRequest {
  constructor(db, requestInfo) {
    check(requestInfo, Match.ObjectIncluding({
      source: Match.Any,
      origin: Match.Any,
      rpcId: Match.Any,
      // For reasons I don't understand, Match.Optional does not work here.
      query: Match.OneOf(undefined, [String]),
      saveLabel: Match.Optional(Match.Any),
      sessionId: String,
      grainId: String,
      identityId: String,
      onCompleted: Function,
    }));

    this._db = db;
    this._requestInfo = requestInfo;
    this._completed = false;
    this._error = new ReactiveVar(undefined);

    // State to track UI status.
    this._filter = new ReactiveVar("");
    this._selectedProvider = new ReactiveVar(undefined);

    this._requestId = Random.id();
  }

  subscribe(tmpl) {
    if (this._requestInfo.query) {
      tmpl.subscribe("powerboxOptions", this._requestId, this._requestInfo.query);
    }
  }

  finalize() {
    if (!this._completed) {
      // postMessage back to the origin frame that the request was cancelled.
      this._requestInfo.source.postMessage({
        rpcId: this._requestInfo.rpcId,
        canceled: true,
      }, this._requestInfo.origin);
    }
  }

  completeUiView(roleAssignment) {
    const fulfillingProvider = this._selectedProvider.get();
    if (fulfillingProvider.type === "frontendref-uiview") {
      const fulfillingGrainTitle = fulfillingProvider.title;
      Meteor.call(
        "fulfillUiViewRequest",
        this._requestInfo.identityId,
        fulfillingProvider.grainId,
        fulfillingGrainTitle, // petname: for UiViews, just use the grain title.
        roleAssignment,
        this._requestInfo.grainId,
        (err, result) => {
          if (err) {
            console.log("error:", err);
            this._error.set(err.toString());
          } else {
            const apiToken = result.sturdyRef;
            this._completed = true;
            this._requestInfo.source.postMessage({
              rpcId: this._requestInfo.rpcId,
              token: apiToken,
              descriptor: result.descriptor,
            }, this._requestInfo.origin);
            // Completion event closes popup.
            this._requestInfo.onCompleted();
          }
        }
      );
    } else {
      console.log("Unsupported provider", fulfillingProvider);
    }
  }

  selectGrain(grainCard, viewInfo) {
    if (viewInfo.permissions) indexElements(viewInfo.permissions);
    // It's essential that we index the roles *before* hiding obsolete roles,
    // or else we'll produce the incorrect roleAssignment for roles that are
    // described after obsolete roles in the pkgdef.
    if (viewInfo.roles) indexElements(viewInfo.roles);
    viewInfo.roles = removeObsolete(viewInfo.roles);

    this._selectedProvider.set({
      type: "frontendref-uiview",
      grainId: grainCard.grainId,
      title: grainCard.title,
      templateName: "powerboxProviderUiView",
      templateData: () => {
        return {
          _id: grainCard._id,
          title: grainCard.title,
          appTitle: grainCard.appTitle,
          iconSrc: grainCard.iconSrc,
          lastUsed: grainCard.lastUsed,
          viewInfo: viewInfo,
          onComplete: (roleAssignment) => {
            this.completeUiView(roleAssignment);
          },
        };
      },
    });
  }

  filteredCardData() {
    // Returns an array of "cards" (options from which the user can pick), sorted in the order in
    // which they should appear. Each has the fields described in the comments for
    // Meteor.publish("powerboxOptions") in powerbox-server.js as well as the following fields
    // added client-side:
    //
    // _id: Unique identifier for this card among the results.
    // title: Human-readable title string.
    // appTitle (optional): Human-readable title of the app serving this option.
    // iconSrc (optional): URL of an icon.
    // lastUsed (optional): Date when this item was last accessed.
    // callback: Function returning a function to call if this card is chosen. (The double-function
    //     is necessary because when a function value is named in a Blaze template, Blaze calls
    //     the function, thinking it is a helper.)

    const cards = PowerboxOptions.find({ requestId: this._requestId }).map(cardData => {
      // Use ID as title if we don't find anything better.
      cardData.title = cardData._id;

      if (cardData.grainId) {
        this.extendWithGrainInfo(cardData);
      } else if (cardData.frontendRef) {
        // TODO(cleanup): English text probably desn't belong in source files.
        if (cardData.frontendRef.ipNetwork) {
          cardData.title = "Admin: grant all outgoing network access";
        } else if (cardData.frontendRef.ipInterface) {
          cardData.title = "Admin: grant all incoming network access";
        } else if (cardData.frontendRef.emailVerifier) {
          const services = cardData.frontendRef.emailVerifier.services;
          if (services) {
            const name = services[0];
            const service = Accounts.identityServices[name];
            if (service.loginTemplate.name === "oauthLoginButton") {
              cardData.title = "Verify e-mail addresses using " +
                  service.loginTemplate.data.displayName;
            } else if (name === "email") {
              cardData.title = "Verify e-mail addresses using passwordless e-mail login";
            } else if (name === "ldap") {
              cardData.title = "Verify e-mail addresses using LDAP";
            } else {
              cardData.title = "Verify e-mail addresses using " + name;
            }
          } else {
            cardData.title = "Verify e-mail addresses using any login service";
          }

          cardData.iconSrc = "/email-m.svg";
        } else if (cardData.frontendRef.verifiedEmail) {
          cardData.title = cardData.frontendRef.verifiedEmail.address;
          cardData.iconSrc = "/email-m.svg";
        }

        cardData.callback = () => () => {
          return this.completeNewFrontendRef(cardData.frontendRef, cardData.title);
        };
      }

      return cardData;
    });

    const now = new Date();
    return _.chain(cards)
        .filter(compileMatchFilter(this._filter.get()))
        .sortBy(card => -(card.lastUsed || now).getTime())
        .value();
  }

  extendWithGrainInfo(cardData) {
    // Extend a grain card with display info.

    // Look for an owned grain.
    const grain = this._db.collections.grains.findOne(cardData.grainId);
    if (grain && grain.userId === Meteor.userId()) {
      cardData.title = grain.title;
      const pkg = this._db.collections.packages.findOne(grain.packageId);
      cardData.appTitle = pkg ? SandstormDb.appNameFromPackage(pkg) : "";
      cardData.iconSrc = pkg ? this._db.iconSrcForPackage(pkg, "grain") : "";
      cardData.lastUsed = grain.lastUsed;

      // Because Blaze always invokes functions when referenced as values from the data context, we
      // need to double-wrap this callback.
      cardData.callback = () => () => {
        return this.selectGrain(cardData, grain.cachedViewInfo || {});
      };

      return;
    }

    // Look for an ApiToken.
    const apiToken = this._db.collections.apiTokens.findOne(
        { grainId: cardData.grainId, "owner.user": { $exists: true } });
    if (apiToken) {
      const ownerData = apiToken.owner.user;
      const grainInfo = ownerData.denormalizedGrainMetadata;
      const staticAssetHost = this._db.makeWildcardHost("static");

      cardData.title = ownerData.title;
      cardData.appTitle =
          (grainInfo && grainInfo.appTitle && grainInfo.appTitle.defaultText) || "";
      cardData.iconSrc = (grainInfo && grainInfo.icon && grainInfo.icon.assetId) ?
          (window.location.protocol + "//" + staticAssetHost + "/" + grainInfo.icon.assetId) :
          Identicon.identiconForApp(
              (grainInfo && grainInfo.appId) || "00000000000000000000000000000000");
      cardData.lastUsed = apiToken.lastUsed;
      cardData.apiTokenId = apiToken._id;

      cardData.callback = () => () => {
        Meteor.call("getViewInfoForApiToken", cardData.apiTokenId, (err, result) => {
          if (err) {
            console.log(err);
            this._error.set(err.toString());
          } else {
            this.selectGrain(cardData, result || {});
          }
        });
      };

      return;
    }

    // Didn't find either. Don't know why this option was returned but oh well.
    cardData.callback = () => () => {
      this.selectGrain(cardData, {});
    };
  }

  completeNewFrontendRef(frontendRef, defaultLabel) {

    Meteor.call("newFrontendRef",
      this._requestInfo.sessionId,
      frontendRef,
      (err, result) => {
        if (err) {
          console.log(err);
          this._error.set(err.toString());
        } else {
          this._completed = true;
          this._requestInfo.source.postMessage({
            rpcId: this._requestInfo.rpcId,
            token: result.sturdyRef,
            descriptor: result.descriptor,
          }, this._requestInfo.origin);
          // Completion event closes popup.
          this._requestInfo.onCompleted();
        }
      }
    );
  }
};

const matchesAppOrGrainTitle = function (needle, cardData) {
  if (cardData.title && cardData.title.toLowerCase().indexOf(needle) !== -1) return true;
  if (cardData.appTitle && cardData.appTitle.toLowerCase().indexOf(needle) !== -1) return true;
  return false;
};

const compileMatchFilter = function (searchString) {
  // split up searchString into an array of regexes, use them to match against item
  const searchKeys = searchString.toLowerCase()
      .split(" ")
      .filter(function (k) { return k !== "";});

  return function matchFilter(item) {
    if (searchKeys.length === 0) return true;
    return _.chain(searchKeys)
        .map(function (searchKey) { return matchesAppOrGrainTitle(searchKey, item); })
        .reduce(function (a, b) { return a && b; })
        .value();
  };
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

Template.powerboxRequest.onCreated(function () {
  this.autorun(() => {
    const request = this.data.get();
    if (request) request.subscribe(this);
  });
});

Template.powerboxRequest.onRendered(function () {
  const searchbar = this.findAll(".search-bar")[0];
  if (searchbar) searchbar.focus();
});

Template.powerboxRequest.helpers({
  cards: function () {
    const ref = Template.instance().data.get();
    return ref && ref.filteredCardData() || [];
  },

  selectedProvider: function () {
    const ref = Template.instance().data.get();
    return ref && ref._selectedProvider && ref._selectedProvider.get();
  },

  selectedProviderTemplate: function () {
    const ref = Template.instance().data.get();
    return ref && ref._selectedProvider && ref._selectedProvider.get().templateName;
  },

  selectedProviderTemplateData: function () {
    const ref = Template.instance().data.get();
    return ref && ref._selectedProvider && ref._selectedProvider.get().templateData();
  },

  showWebkeyInput: function () {
    // Transitional feature: treat requests that specified no query patterns to match, not even the
    // empty list, as requests for webkeys.  Later, we"ll want to transition the test apps to
    // specify interfaces, and implement frontendrefs to support those interfaces.
    const ref = Template.instance().data.get();
    return !(ref && ref._requestInfo && ref._requestInfo.query);
  },

  webkeyError: function () {
    // Transitional function:
    const ref = Template.instance().data.get();
    return ref && ref._error.get();
  },
});

Template.powerboxRequest.events({
  "input .search-bar": function (event) {
    Template.instance().data.get()._filter.set(event.target.value);
  },

  "keypress .search-bar": function (event) {
    if (event.keyCode === 13) {
      // Enter pressed.  If a single grain is shown, activate it.
      const ref = Template.instance().data.get();
      const cards = ref.filteredCardData();
      if (cards.length === 1) {
        // Weird double function call needed  as described above, ugh.
        const cb = cards[0].callback()();
      }
    }
  },

  "submit #powerbox-request-form": function (event) {
    // Legacy support for the webkey workflow.
    event.preventDefault();
    const ref = Template.instance().data.get();
    const saveLabel = ref._requestInfo.saveLabel;
    const identityId = ref._requestInfo.identityId;
    const grainId = ref._requestInfo.grainId;
    Meteor.call("finishPowerboxRequest", event.target.token.value, saveLabel,
                identityId, grainId, function (err, token) {
        if (err) {
          ref._error.set(err.toString());
        } else {
          ref._completed = true;
          ref._requestInfo.source.postMessage({
            rpcId: ref._requestInfo.rpcId,
            token: token,
          }, ref._requestInfo.origin);
          // Completion event closes popup.
          ref._requestInfo.onCompleted();
        }
      }
    );
  },
});

Template.powerboxProviderUiView.events({
  "click .connect-button": function (event) {
    event.preventDefault();
    const ref = Template.instance().data;
    const selectedInput = Template.instance().find('form input[name="role"]:checked');
    if (selectedInput) {
      if (selectedInput.value === "all") {
        ref.onComplete({ allAccess: null });
      } else {
        const role = parseInt(selectedInput.value, 10);
        ref.onComplete({ roleId: role });
      }
    }
  },
});

Template.powerboxCardButton.events({
  "click .card-button": function (event, tmpl) {
    const ref = tmpl.data;
    ref && ref.onClick && ref.onClick();
  },
});
