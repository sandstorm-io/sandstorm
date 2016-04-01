// Pass in username, password as normal
// on any particular call (if you have multiple ldap servers you'd like to connect to)
// You'll likely want to set the dn value here {dn: "..."}
Meteor.loginWithLDAP = function (user, password, callback) {
  // Retrieve arguments as array
  let args = [];
  for (let i = 0; i < arguments.length; i++) {
    args.push(arguments[i]);
  }
  // Pull username and password
  user = args.shift();
  password = args.shift();

  // Check if last argument is a function
  // if it is, pop it off and set callback to it
  if (typeof args[args.length - 1] == "function") callback = args.pop(); else callback = null;

  // Set up loginRequest object
  let loginRequest = _.defaults({
    username: user,
    ldapPass: password,
  }, {
    ldap: true,
  });

  Accounts.callLoginMethod({
    // Call login method with ldap = true
    // This will hook into our login handler for ldap
    methodArguments: [loginRequest],
    userCallback: function (error, result) {
      if (error) {
        callback && callback(error);
      } else {
        callback && callback();
      }
    },
  });
};
