Accounts.emailToken = {};

Accounts.emailToken._hashToken = function (token) {
  return {
    digest: SHA256(token),
    algorithm: "sha-256",
  };
};
