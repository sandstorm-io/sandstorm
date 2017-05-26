const matchesUser = function (searchKey, user) {
  // We match a user if we can find the searchKey in one of the following fields:
  //   * Account ID
  //   * In any of the user's identities:
  //     * identity ID
  //     * intrinsicName
  //     * name (display name)
  //     * handle
  //     * service
  //     * in any of the identity's verified email addresses

  if (user.account._id.indexOf(searchKey) !== -1) return true;

  for (let i = 0; i < user.identities.length; i++) {
    const identity = user.identities[i];
    if (!identity) continue; // Sometimes we have identity IDs but no identity object. :(

    if (identity._id.indexOf(searchKey) !== -1) return true;

    if (identity.profile.intrinsicName.toLowerCase().indexOf(searchKey) !== -1) return true;

    if (identity.profile.name.toLowerCase().indexOf(searchKey) !== -1) return true;

    if (identity.profile.handle.toLowerCase().indexOf(searchKey) !== -1) return true;

    if (identity.profile.service.toLowerCase().indexOf(searchKey) !== -1) return true;

    const verifiedEmails = SandstormDb.getVerifiedEmails(identity);
    for (let j = 0; j < verifiedEmails.lenfth; j++) {
      const email = verifiedEmails[j];
      if (email.toLowerCase().indexOf(searchKey) !== -1) return true;
    }
  }

  return false;
};

const compileMatchFilter = function (searchString) {
  const searchKeys = searchString.toLowerCase()
      .split(" ")
      .filter((k) => { return k !== ""; });

  return function matchFilter(item) {
    if (searchKeys.length === 0) return true;
    return _.chain(searchKeys)
        .map((searchKey) => { return matchesUser(searchKey, item); })
        .reduce((a, b) => a && b)
        .value();
  };
};

Template.newAdminUserTableRow.helpers({
  isSignedUpOrDemo(user) {
    return globalDb.isAccountSignedUpOrDemo(user);
  },

  wrapUserId(userId) {
    return {
      userId,
    };
  },
});

Template.newAdminUserTableRow.events({
  "click .account-row"(evt) {
    const instance = Template.instance();
    Router.go("newAdminUserDetails", { userId: instance.data.user.account._id });
  },
});

Template.newAdminUserTable.onCreated(function () {
  this.sortOrder = new ReactiveVar({
    key: "createdAt",
    order: "ascending",
  });
});

Template.newAdminUserTable.helpers({
  sortOrder() {
    return Template.instance().sortOrder.get();
  },

  equal(a, b) {
    return a === b;
  },

  sortUsers(users) {
    const instance = Template.instance();
    const sortOrder = instance.sortOrder.get();

    const multiplier = sortOrder.order === "ascending" ? 1 : -1;
    if (sortOrder.key === "createdAt") {
      return _.sortBy(users, (user) => {
        return multiplier * (user.account.createdAt);
      });
    } else if (sortOrder.key === "lastActive") {
      return _.sortBy(users, (user) => {
        // If the account has a lastActive time, use that.
        if (user.account.lastActive) return multiplier * user.account.lastActive;
        // If not, check any of the identities for a lastActive time.
        for (let i = 0; i < user.identities.length; i++) {
          const identity = user.identities[i];
          if (identity.lastActive) return multiplier * identity.lastActive;
        }

        return 0;
      });
    }

    // If we don't know about the requested sort order, just return the original set as-is.
    return users;
  },
});

Template.newAdminUserTable.events({
  "click .header-row .created"(evt) {
    const instance = Template.instance();
    const currentSortOrder = instance.sortOrder.get();

    const newSortOrder = {
      key: "createdAt",
      order: "ascending",
    };

    if (currentSortOrder.key === "createdAt" && currentSortOrder.order === "ascending") {
      newSortOrder.order = "decending";
    }

    instance.sortOrder.set(newSortOrder);
  },

  "click .header-row .last-active"(evt) {
    const instance = Template.instance();
    const currentSortOrder = instance.sortOrder.get();

    const newSortOrder = {
      key: "lastActive",
      order: "descending",
    };

    if (currentSortOrder.key === "lastActive" && currentSortOrder.order === "descending") {
      newSortOrder.order = "ascending";
    }

    instance.sortOrder.set(newSortOrder);
  },
});

Template.newAdminUsers.onCreated(function () {
  this.usersSub = this.subscribe("allUsers", undefined);
  this.searchString = new ReactiveVar("");
  this.showAdmins = new ReactiveVar(true);
  this.showUsers = new ReactiveVar(true);
  this.showVisitors = new ReactiveVar(false);

  this.currentMatchFilter = () => {
    const userClassFilter = (item) => {
      if (item.account.isAdmin) return this.showAdmins.get();
      const isFullUser = globalDb.isAccountSignedUpOrDemo(item.account);
      if (isFullUser) {
        return this.showUsers.get();
      } else {
        return this.showVisitors.get();
      }
    };

    const searchStringFilter = compileMatchFilter(this.searchString.get());
    return (item) => {
      return userClassFilter(item) && searchStringFilter(item);
    };
  };

  this.allUsers = () => {
    if (!this.usersSub.ready()) return [];

    const accounts = Meteor.users.find({
      loginIdentities: { $exists: 1 },
    });

    const users = accounts.map((account) => {
      const identityIds = SandstormDb.getUserIdentityIds(account);
      // Identity IDs are given in creation order.
      const identities = identityIds.map((identityId) => {
        const identity = Meteor.users.findOne({ _id: identityId });
        if (identity) {
          // For some reason, various servers (including alpha) appear to have accounts that
          // reference identities which do not exist in the database.
          SandstormDb.fillInProfileDefaults(identity);
          SandstormDb.fillInIntrinsicName(identity);
        }

        return identity;
      });
      return {
        _id: account._id,
        account,
        identities,
      };
    });

    return users;
  };

  this.filterUsers = (users) => {
    const filteredAccounts = _.filter(users, this.currentMatchFilter());
    return filteredAccounts;
  };
});

Template.newAdminUsers.helpers({
  userSubReady() {
    const instance = Template.instance();
    return instance.usersSub.ready();
  },

  allUsers() {
    const instance = Template.instance();
    return instance.allUsers();
  },

  filterUsers(users) {
    const instance = Template.instance();
    return instance.filterUsers(users);
  },

  isNotSearching() {
    const instance = Template.instance();
    return !instance.searchString.get();
  },

  showAdmins() {
    const instance = Template.instance();
    return instance.showAdmins.get();
  },

  showUsers() {
    const instance = Template.instance();
    return instance.showUsers.get();
  },

  showVisitors() {
    const instance = Template.instance();
    return instance.showVisitors.get();
  },

  adminCount(users) {
    return _.filter(users, (user) => {
      return user.account.isAdmin;
    }).length;
  },

  userCount(users) {
    return _.filter(users, (user) => {
      if (user.account.isAdmin) return false;
      return globalDb.isAccountSignedUpOrDemo(user.account);
    }).length;
  },

  visitorCount(users) {
    return _.filter(users, (user) => {
      if (user.account.isAdmin) return false;
      return !globalDb.isAccountSignedUpOrDemo(user.account);
    }).length;
  },
});

Template.newAdminUsers.events({
  "input input[name=search-bar]"(evt) {
    const instance = Template.instance();
    instance.searchString.set(evt.currentTarget.value);
  },

  "keypress input[name=search-bar]"(evt) {
    const instance = Template.instance();
    if (evt.keyCode === 13) {
      const users = instance.filterUsers(instance.allUsers());
      if (users.length === 1) {
        Router.go("newAdminUserDetails", { userId: users[0].account._id });
      }
    }
  },

  "click input[name=show-admins]"(evt) {
    const instance = Template.instance();
    instance.showAdmins.set(!instance.showAdmins.get());
  },

  "click input[name=show-users]"(evt) {
    const instance = Template.instance();
    instance.showUsers.set(!instance.showUsers.get());
  },

  "click input[name=show-visitors]"(evt) {
    const instance = Template.instance();
    instance.showVisitors.set(!instance.showVisitors.get());
  },

  "click .invite-row"(evt) {
    Router.go("newAdminUserInvite");
  },
});
