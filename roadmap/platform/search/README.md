# TODO(project): Search

Since Sandstorm isolates apps at a fine granularity, in-app search is often not very useful. Users really want to be able to search across all grains in their [account](../accounts). To solve this, Sandstorm will offer search infrastructure as part of the platform. Each grain must implement an API which the indexer uses to obtain its content. The user can then type into a search box somewhere in the UI (perhaps in the top bar, or as part of the file list) and receive a list of grains as results.

## Per-user indexing and security

Security is a high priority for Sandstorm. A global search index containing data from every user's private grains would be a huge security risk:

- If an attacker got access to that index, they'd be able to see everything.
- If bugs existed in the search algorithm, it could potentially leak one user's private information to another.

Therefore, Sandstorm maintains a separate search index for every user, containing only the data known to be accessible to that user.

However, this may have performance problems: a grain which is accessible to many users would be indexed many times. To solve this, Sandstorm will implement a multi-tiered indexing approach. The system will identify "groups", where some large group of users has access to some large group of grains, and build a single index for the entire group. When any user in the group performs a query, both their personal index and the group index will be queried, and the results merged. A common way that "groups" may emerge is through collections: all users of the collection have access to all grains in the collection. Hence, an index should be created for the collection. However, all of this occurs as an optimization invisible to the user, so Sandstorm can choose arbitrary groupings as it sees fit to optimize performance.

The system will guarantee one-way data flows from apps being indexed to the indexer, so that a buggy or malicious indexer cannot leak information back to other grains. The only output from the indexer is search results, which are displayed directly to the user.

## Search Operators

If the user simply types keywords, they get full-text search results.

We will also support advanced search operators in the style many of many Google apps. For instance, the user could type:

- `from:kenton`: Find grains owned by Kenton.
- `after:2015/02/10`: Find grains newer than Feb 10, 2015.

Applications may define new operators. See gmail's advanced search documentation for ideas for useful operators.

## API

To be searchable (by anything other than Sandstorm-known metadata), a grain's `UiView` must implement the indexing API, which allows the indexer to obtain the grain's content. This API should be designed such that:
- It considers permissions -- some of the app's content may not be accessible to people lacking certain permissions. Probably, the app just needs to specify the single permission bit required by each piece of content.
- It supports subscribing to incremental updates, so that when a big grain changes it's not necessary to re-index everything.
- It supports defining sub-objects within the grain that can be linked to directly, so that for large grains with many internal objects the user can jump directly to the matching one (such as jumping directly to an e-mail in a mailbox app).

Possibly, the API should integrate closely with [activity events](../activity): re-indexing could be triggered by an activity event, and could be granularized based on activity threads. sandstorm-http-bridge could conceivably support automatic indexing for apps that serve pre-rendered HTML.

## Implementation

The indexer is actually itself an app, with a grain for each index (one for each user and each "group"). Possibly, we could support interchangeable indexers, although probably few people would want to do this, and instead the indexer app should be "built in".

The indexer app should probably use some variant of Apache Lucene. Lucene, however, is in Java, and therefore may not be well-optimized for the Sandstorm environment. An intriguing alternative is Apache Lucy, which is a C library that is loosely based on Lucene. This may lack some of Lucene's features but would give the performance benefits we want.
