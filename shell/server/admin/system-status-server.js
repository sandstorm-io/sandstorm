const Crypto = Npm.require("crypto");

const hashSessionId = function (sessionId) {
  return Crypto.createHash("sha256").update(sessionId).digest("base64");
};

Meteor.publish("systemStatus", function () {
  // A pseudocollection containing the number of active grain sessions and unique
  // userIds associated with these sessions
  const db = this.connection.sandstormDb;
  if (!db.isAdminById(this.userId)) {
    throw new Meteor.Error(403, "User must be admin to view system status.");
  }

  const _this = this;
  const userIdToSessionHashes = {}; // Maps userId => list of (sha256(sessionId))
  const grainIdToSessionHashes = {}; // Maps grainId => list of (sha256(sessionId))

  let userIdCount = 0;
  let grainIdCount = 0;

  this.added("systemStatus", "globalStatus", {
    activeUsers: userIdCount,
    activeGrains: grainIdCount,
  });

  const query = db.collections.sessions.find();
  const handle = query.observe({
    added(session) {
      const hashedSessionId = hashSessionId(session._id);
      const changed = {};

      // Update userId cache.
      if (session.userId) {
        if (userIdToSessionHashes[session.userId] === undefined) {
          userIdToSessionHashes[session.userId] = [];
          userIdCount = userIdCount + 1;
          changed.activeUsers = userIdCount;
        }

        userIdToSessionHashes[session.userId] =
            _.union(userIdToSessionHashes[session.userId], [hashedSessionId]);
      }

      // Update grainId cache.
      if (grainIdToSessionHashes[session.grainId] === undefined) {
        grainIdToSessionHashes[session.grainId] = [];
        grainIdCount = grainIdCount + 1;
        changed.activeGrains = grainIdCount;
      }

      grainIdToSessionHashes[session.grainId] =
          _.union(grainIdToSessionHashes[session.grainId], [hashedSessionId]);

      if (!_.isEmpty(changed)) {
        _this.changed("systemStatus", "globalStatus", changed);
      }
    },

    removed(session) {
      const hashedSessionId = hashSessionId(session._id);
      const changed = {};

      if (session.userId) {
        userIdToSessionHashes[session.userId] =
            _.without(userIdToSessionHashes[session.userId], hashedSessionId);

        if (userIdToSessionHashes[session.userId].length === 0) {
          userIdToSessionHashes[session.userId] = undefined;
          userIdCount = userIdCount - 1;
          changed.activeUsers = userIdCount;
        }
      }

      grainIdToSessionHashes[session.grainId] =
          _.without(grainIdToSessionHashes[session.grainId], hashedSessionId);

      if (grainIdToSessionHashes[session.grainId].length === 0) {
        grainIdToSessionHashes[session.grainId] = undefined;
        grainIdCount = grainIdCount - 1;
        changed.activeGrains = grainIdCount;
      }

      if (!_.isEmpty(changed)) {
        _this.changed("systemStatus", "globalStatus", changed);
      }
    },
  });
  this.onStop(() => {
    handle.stop();
  });
  this.ready();
});
