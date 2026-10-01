function stopObserveHandle(handle) {
  if (typeof handle === "function") {
    handle();
  } else if (handle && typeof handle.stop === "function") {
    handle.stop();
  }
}

export function waitForMigrationDocument(collection, selector, isComplete, options = {}) {
  return new Promise((resolve, reject) => {
    let observerHandle;
    let observerReady = false;
    let stopRequested = false;
    let stopped = false;
    let settled = false;

    const stopObserver = () => {
      stopRequested = true;
      if (!observerReady || stopped) return;
      stopped = true;
      try {
        stopObserveHandle(observerHandle);
      } catch (err) {
        console.error(`Failed to stop migrations observer (${options.label || "unknown"}):`, err);
      }
    };

    const consider = (doc) => {
      if (settled) return;
      if (options.onUpdate) options.onUpdate(doc);
      if (!isComplete(doc)) return;

      settled = true;
      stopObserver();
      resolve(undefined);
    };

    let observerPromise;
    try {
      observerPromise = collection.find(selector).observeAsync({
        added: consider,
        changed: consider,
      });
    } catch (err) {
      settled = true;
      reject(err);
      return;
    }

    Promise.resolve(observerPromise).then((handle) => {
      observerHandle = handle;
      observerReady = true;
      if (stopRequested) stopObserver();
    }).catch((err) => {
      if (!settled) {
        settled = true;
        reject(err);
      } else {
        console.error(`Migrations observer failed after completion (${options.label || "unknown"}):`, err);
      }
    });
  });
}

export async function waitForReplicaMigrations(db, migrationCount) {
  await waitForMigrationDocument(
    db.collections.migrations,
    { _id: "migrations_applied" },
    (doc) => doc.value >= migrationCount,
    {
      label: "migrations-applied",
      onUpdate(doc) {
        console.log("Migrations applied elsewhere: " + doc.value + "/" + migrationCount);
      },
    }
  );

  await waitForMigrationDocument(
    db.collections.migrations,
    { _id: "new_server_migrations_applied" },
    (doc) => !!doc.value,
    {
      label: "new-server-migrations",
      onUpdate(doc) {
        if (doc.value) console.log("New server migrations applied elsewhere");
      },
    }
  );
}
