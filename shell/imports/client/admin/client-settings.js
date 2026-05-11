export function getClientSetting(db, name) {
  const setting = db.collections.settings.findOne(name);
  return setting && setting.value;
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
