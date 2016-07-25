const loginWithLDAP = function (user, password, callback) {
  check(user, String);
  check(password, String);
  check(callback, Match.Optional(Function));

  const requestArgs = {
    ldap: true,
    username: user,
    ldapPass: password,
  };

  Accounts.callLoginMethod({
    // Call login method with ldap = true
    // This will hook into our login handler for ldap
    methodArguments: [requestArgs],
    userCallback: function (error, result) {
      if (error) {
        callback && callback(error);
      } else {
        callback && callback();
      }
    },
  });
};

export { loginWithLDAP };
