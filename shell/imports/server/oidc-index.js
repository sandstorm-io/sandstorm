// Meteor's accounts-oauth package eagerly creates a unique service ID index when an OAuth
// service is registered. Older Sandstorm releases created the OIDC index without unique=true,
// so it must be reconciled before registering the service under Meteor 3.
export const OIDC_INDEX_MIGRATION_VERSION = 42;

export async function reconcileOidcUsersIndex(db, _backend) {
  const usersRaw = db.collections.users.rawCollection();
  const indexName = "services.oidc.id_1";
  const desiredKey = { "services.oidc.id": 1 };

  let indexes;
  try {
    indexes = await usersRaw.indexes();
  } catch (err) {
    // A fresh Sandstorm may not have created the users collection yet. Creating the desired
    // index below will create the collection, so treat NamespaceNotFound like an empty index list.
    if (err.code === 26 || err.codeName === "NamespaceNotFound") {
      indexes = [];
    } else {
      throw err;
    }
  }

  const existing = indexes.find((idx) => idx.name === indexName);
  if (!existing) {
    await usersRaw.createIndex(desiredKey, { name: indexName, unique: true, sparse: true });
    return;
  }

  const hasDesiredKey =
      existing.key &&
      existing.key["services.oidc.id"] === 1 &&
      Object.keys(existing.key).length === 1;
  const hasDesiredOptions = existing.unique === true && !!existing.sparse === true;
  if (hasDesiredKey && hasDesiredOptions) return;

  const duplicates = await usersRaw.aggregate([
    { $match: { "services.oidc.id": { $exists: true } } },
    { $group: { _id: "$services.oidc.id", count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 1 },
  ]).toArray();

  if (duplicates.length > 0) {
    throw new Error(
      "Cannot migrate services.oidc.id index to unique: duplicate OIDC IDs exist in users."
    );
  }

  await usersRaw.dropIndex(indexName);
  await usersRaw.createIndex(desiredKey, { name: indexName, unique: true, sparse: true });
}
