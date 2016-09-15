const computeTitleFromTokenOwnerUser = function (apiTokenOwnerUser) {
  // Given an apiToken.owner.user, return a struct with the effective grain title.
  if (!apiTokenOwnerUser.upstreamTitle) {
    return { title: apiTokenOwnerUser.title };
  } else if (apiTokenOwnerUser.renamed) {
    return { title: apiTokenOwnerUser.title, renamedFrom: apiTokenOwnerUser.upstreamTitle };
  } else {
    return { title: apiTokenOwnerUser.upstreamTitle, was: apiTokenOwnerUser.title };
  }
};

export { computeTitleFromTokenOwnerUser };
