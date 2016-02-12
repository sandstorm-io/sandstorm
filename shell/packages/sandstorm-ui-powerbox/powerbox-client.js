SandstormPowerboxRequest = class SandstormPowerboxRequest {
  constructor(db, requestInfo) {
    check(requestInfo, Match.ObjectIncluding({
      source: Match.Any,
      origin: Match.Any,
      rpcId: Match.Any,
      // For reasons I don't understand, Match.Optional does not work here.
      query: Match.OneOf(undefined, [Object]),
      saveLabel: Match.Optional(Match.Any),
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
  }

  finalize() {
    if (!this._completed) {
      // postMessage back to the origin frame that the request was cancelled.
      this._requestInfo.source.postMessage({
        rpcId: this._requestInfo.rpcId,
        error: this._error.get() || "User cancelled request",
      }, this._requestInfo.origin);
    }
  }

  hex64ToDecimal(n) {
    if (typeof n != "string") {
        throw new Error("Expected string.");
    }
    if (n.length != 18 || !n.match(/0x[0-9a-fA-F]{16}/)) {
        throw new Error("Expected '0x' followed by 16 hexadecimal digits");
    }
    var upper32 = parseInt(n.substring(0, 10));
    var lower32 = parseInt("0x" + n.substring(10, 18));

    var result = "";
    for (var exponent = 0; exponent < 22; exponent += 1 ) {
        var w = Math.floor(upper32 / 10);
        var x = upper32 % 10;

        var lowerPlusRemainder = (x * Math.pow(2, 32)) + lower32;
        var y = Math.floor(lowerPlusRemainder / 10);
        var z = lowerPlusRemainder % 10;

        result = z.toString() + result;

        upper32 = w;
        lower32 = y;

        if (upper32 == 0 && lower32 == 0) {
            break;
        }
    }
    return result;
  }

  decimalify(interfaceId) {
    if (interfaceId.lastIndexOf("0x", 0) === 0 && interfaceId.length === 18) {
      try {
        return this.hex64ToDecimal(interfaceId);
      } catch (e) {
        return interfaceId;
      }
    }
    return interfaceId;
  }

  interfaceIdsMatch(a, b) {
    // Compares two interface IDs which may be either decimal strings or 0x-prefixed hexadecimal
    // strings.  Strictly speaking, node-capnp would also accept octal strings, but there's not
    // a great reason for wanting anything besides hex or decimal here.
    return this.decimalify(a) === this.decimalify(b);
  }

  requestedInterfaceMatchesTag(target) {
    // This whole function should probably be migrated to use the powerbox interface matching code,
    // once that exists.

    // target is (the JS equivalent of) a PowerboxDescriptor.Tag struct.
    check(target, {
      id: String,
      value: Match.Optional(Match.Any),
    });
    if (!this._requestInfo.query) return false;
    for (let i = 0; i < this._requestInfo.query.length; i++) {
      const powerboxDescriptor = this._requestInfo.query[i];
      const tags = powerboxDescriptor.tags;
      const quality = powerboxDescriptor.quality || "acceptable";
      if (quality === "acceptable" || quality === "preferred") {
        for (let j = 0; j < tags.length; j++) {
          const tag = tags[j];
          // TODO: implement the more precise request matching algorithm in grain.capnp
          // which also considers tag values
          if (tag.id) {
            if (this.interfaceIdsMatch(tag.id, target.id)) {
              return true;
            }
          }
        }
      }
    }

    return false;
  }

  completeUiView(roleAssignment) {
    const fulfillingProvider = this._selectedProvider.get();
    if (fulfillingProvider.type === "frontendref-uiview") {
      const fulfillingGrainId = fulfillingProvider.grainId;
      const fulfillingApiToken = fulfillingProvider.apiToken; // Possibly irrelevant?
      const fulfillingGrainTitle = fulfillingProvider.title;

      const saveLabel = this._requestInfo.saveLabel || { defaultText: fulfillingGrainTitle };
      const owner = {
        grain: {
          grainId: this._requestInfo.grainId,
          saveLabel: saveLabel,
          introducerIdentity: this._requestInfo.identityId,
        },
      };
      const provider = {
        identityId: this._requestInfo.identityId,
      };
      Meteor.call("newApiToken",
        provider,
        fulfillingGrainId,
        fulfillingGrainTitle, // petname: for UiViews, just use the grain title.
        roleAssignment,
        owner,
        (err, result) => {
          if (err) {
            console.log("error:", err);
            this._error.set(err.toString());
          } else {
            const apiToken = result.token;
            this._completed = true;
            this._requestInfo.source.postMessage({
              rpcId: this._requestInfo.rpcId,
              token: apiToken,
              descriptor: {
                tags: [
                  { id: "15831515641881813735" }, // UiView
                ],
                quality: "acceptable",
              },
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

  selectGrain(grainCard) {
    this._selectedProvider.set({
      type: "frontendref-uiview",
      grainId: grainCard.grainId,
      title: grainCard.title,
      templateName: "powerboxProviderUiView",
      templateData: () => {
        const grain = this._db.collections.grains.findOne(grainCard.grainId);
        const viewInfo = grain.cachedViewInfo;
        this.annotateViewInfo(viewInfo);
        return {
          _id: grainCard.grainId,
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

  selectApiToken(apiTokenCard) {
    Meteor.call("getViewInfoForApiToken", apiTokenCard._id, (err, result) => {
      if (err) {
        console.log(err);
        this._error.set(err.toString());
      } else {
        const viewInfo = result;
        this.annotateViewInfo(viewInfo);
        this._selectedProvider.set({
          type: "frontendref-uiview",
          grainId: apiTokenCard.grainId,
          apiToken: apiTokenCard._id,
          title: apiTokenCard.title,
          templateName: "powerboxProviderUiView",
          templateData: () => {
            return {
              _id: apiTokenCard._id,
              title: apiTokenCard.title,
              appTitle: apiTokenCard.appTitle,
              iconSrc: apiTokenCard.iconSrc,
              lastUsed: apiTokenCard.lastUsed,
              viewInfo: viewInfo,
              onComplete: (roleAssignment) => {
                this.completeUiView(roleAssignment);
              }
            }
          }
        });
      }
    });
  }

  annotateViewInfo(viewInfo) {
    if (viewInfo.permissions) indexElements(viewInfo.permissions);
    // It's essential that we index the roles *before* hiding obsolete roles,
    // or else we'll produce the incorrect roleAssignment for roles that are
    // described after obsolete roles in the pkgdef.
    if (viewInfo.roles) indexElements(viewInfo.roles);
    viewInfo.roles = removeObsolete(viewInfo.roles);
  }

  filteredCardData() {
    // Map user grains into card data
    const ownedGrains = this._db.currentUserGrains().fetch();
    const ownedGrainIds = _.pluck(ownedGrains, "_id");
    const ownedGrainCardData = mapGrainsToGrainCardData(ownedGrains, this._db, this.selectGrain.bind(this));

    // Also map API tokens.  Be careful to only include tokens for grains that aren't in the grain
    // list, and only include one token for each grain.
    const apiTokens = this._db.currentUserApiTokens().fetch();
    const tokensForGrain = _.groupBy(apiTokens, "grainId");
    const grainIdsForApiTokens = Object.keys(tokensForGrain);
    const grainIdsForApiTokensForNonOwnedGrains = _.filter(grainIdsForApiTokens, (grainId) => {
      return !_.contains(ownedGrainIds, grainId);
    });
    const tokensToList = grainIdsForApiTokensForNonOwnedGrains.map((grainId) => {
      return _.sortBy(tokensForGrain[grainId], function (t) {
        if (t.owner && t.owner.user && t.owner.user.lastUsed) {
          return -t.owner.user.lastUsed;
        } else {
          return 0;
        }
      })[0];
    });
    const apiTokenCardData = mapApiTokensToGrainCardData(tokensToList, this._db, this.selectApiToken.bind(this));

    // Filter cards to match search, then sort cards by recency of usage
    const sortedFilteredCardData = _.chain([ownedGrainCardData, apiTokenCardData])
        .flatten()
        .filter(compileMatchFilter(this._filter.get()))
        .sortBy((card) => card.lastUsed)
        .reverse()
        .value();

    return sortedFilteredCardData;
  };
};

const mapApiTokensToGrainCardData = function (apiTokens, db, selectApiToken) {
  const staticAssetHost = db.makeWildcardHost("static");
  return apiTokens.map((apiToken) => {
    const ownerData = apiToken.owner.user;
    const grainInfo = ownerData.denormalizedGrainMetadata;
    const appTitle = (grainInfo && grainInfo.appTitle && grainInfo.appTitle.defaultText) || "";
    const iconSrc = (grainInfo && grainInfo.icon && grainInfo.icon.assetId) ?
        (window.location.protocol + "//" + staticAssetHost + "/" + grainInfo.icon.assetId) :
        Identicon.identiconForApp((grainInfo && grainInfo.appId) || "00000000000000000000000000000000");
    const grainCard = {
      type: "apiToken",
      _id: apiToken._id,
      grainId: apiToken.grainId,
      title: ownerData.title,
      appTitle: appTitle,
      iconSrc: iconSrc,
      lastUsed: ownerData.lastUsed,
    };
    grainCard.callback = function () {
      // Because Blaze always invokes functions when referenced as values from the data context, we
      // need to double-wrap this callback.
      return function () {
        selectApiToken(grainCard);
      }
    };
    return grainCard;
  });
};

const mapGrainsToGrainCardData = function (grains, db, selectGrain) {
  const packageIds = _.chain(grains)
      .pluck("packageId")
      .uniq()
      .value();
  const packages = db.collections.packages.find({ _id: { $in: packageIds } }).fetch();
  const packagesById = _.indexBy(packages, "_id");
  return grains.map(function (grain) {
    const pkg = packagesById[grain.packageId];
    const iconSrc = pkg ? db.iconSrcForPackage(pkg, "grain") : "";
    const appTitle = pkg ? SandstormDb.appNameFromPackage(pkg) : "";
    const cardData = {
      type: "grain",
      _id: grain._id,
      grainId: grain._id,
      title: grain.title,
      appTitle: appTitle,
      iconSrc: iconSrc,
      lastUsed: grain.lastUsed,
    };
    cardData.callback = function () {
      // Because Blaze always invokes functions when referenced as values from the data context, we
      // need to double-wrap this callback.
      return function () {
        selectGrain(cardData);
      };
    };

    return cardData;
  });
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

Template.powerboxRequest.onRendered(function () {
  const searchbar = this.findAll(".search-bar")[0];
  if (searchbar) searchbar.focus();
});

Template.powerboxRequest.helpers({
  grains: function () {
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

  requestedInterfaceIsImplementedByFrontendRef: function () {
    const ref = Template.instance().data.get();
    return (
      // TODO: support additional frontendref types
      //ref.requestedInterfaceMatchesTag({id: "12214421258504904768"}) || // IpNetwork
      //ref.requestedInterfaceMatchesTag({id: "16369547182874744570"}) || // IpInterface
      ref.requestedInterfaceMatchesTag({ id: "15831515641881813735" }) // UiView
    );
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
    return ref._error.get();
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

Template.grainCardButton.events({
  "click .grain-button": function (event) {
    const ref = Template.instance().data;
    ref && ref.onClick && ref.onClick();
  },
});
