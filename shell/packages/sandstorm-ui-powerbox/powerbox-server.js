Meteor.methods({
  newFrontendRef(sessionId, frontendRefVariety) {
    // Checks if the requester is an admin, and if so, provides a new frontendref of the desired
    // variety, provided by the requesting user, owned by the grain for this session.
    check(sessionId, String);
    check(frontendRefVariety, Match.OneOf(
      { ipNetwork: Boolean },
      { ipInterface: Boolean },
    ));

    const db = this.connection.sandstormDb;
    if (!db.isAdmin(this.userId)) {
      throw new Meteor.Error(403, "User must be an admin to powerbox offer frontendrefs");
    }

    const session = db.collections.sessions.findOne(sessionId);
    if (!session) {
      throw new Meteor.Error(403, "Invalid session ID");
    }

    const grainId = session.grainId;
    const apiTokenOwner = {
      grain: {
        grainId: grainId,
        saveLabel: {defaultText: "Admin-provided raw outgoing network access"},
        introducerIdentity: session.identityId,
      },
    };

    const requirements = [{
      userIsAdmin: Meteor.userId(),
    }];

    // TODO: refactor: reaches out into core.js
    const sturdyRef = waitPromise(saveFrontendRef(frontendRefVariety, apiTokenOwner, requirements)).sturdyRef;
    return sturdyRef.toString();
  },
});
