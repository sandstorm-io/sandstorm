export function getClientSetting(db, name) {
  const setting = db.collections.settings.findOne(name);
  return setting && setting.value;
}

export function getClientServerTitle(db) {
  return getClientSetting(db, "serverTitle") || "Sandstorm";
}

export function getClientSmtpConfig(db) {
  return getClientSetting(db, "smtpConfig");
}

export function getClientReturnAddress(db) {
  const config = getClientSmtpConfig(db);
  return config && config.returnAddress || "";
}

export function getClientReturnAddressWithDisplayName(db, userId) {
  const user = db.collections.users.findOne(userId);
  if (!user) return undefined;

  const displayName = user.profile.name + " (via " + getClientServerTitle(db) + ")";
  const sanitized = displayName.replace(/"|<|>|\\|\r/g, "");
  return { name: sanitized, address: getClientReturnAddress(db) };
}

export function getClientLdapSettings(db) {
  return {
    url: getClientSetting(db, "ldapUrl") || "",
    searchBindDn: getClientSetting(db, "ldapSearchBindDn") || "",
    searchBindPassword: getClientSetting(db, "ldapSearchBindPassword") || "",
    base: getClientSetting(db, "ldapBase") || "",
    searchUsername: getClientSetting(db, "ldapSearchUsername") || "uid",
    nameField: getClientSetting(db, "ldapNameField") || "cn",
    emailField: getClientSetting(db, "ldapEmailField") || "mail",
    filter: getClientSetting(db, "ldapFilter") || "",
    caCert: getClientSetting(db, "ldapCaCert") || "",
  };
}

export function getClientSamlSettings(db) {
  return {
    entryPoint: getClientSetting(db, "samlEntryPoint") || "",
    logout: getClientSetting(db, "samlLogout") || "",
    publicCert: getClientSetting(db, "samlPublicCert") || "",
    entityId: getClientSetting(db, "samlEntityId") || window.location.hostname,
  };
}
