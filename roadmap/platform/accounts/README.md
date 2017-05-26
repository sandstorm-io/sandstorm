# Accounts

Sandstorm grains are owned by accounts. Each account has certain resource quotas available to it for storing and running grains.

An account always belongs to a human. There should never be a need to create "robot accounts", because automated systems can always access APIs in a capability-based way without needing an account. Allowing an automated agent to access resources through a "robot account" risks introducing confused deputy attacks, which capability-based security avoids.

## Account levels

There are three levels of accounts on a Sandstorm server:

- Admin: These accounts can access the admin settings panel.
- User: Also called "full user", these accounts can install apps and create grains.
- Visitor: Visitors can view grains that have been shared with them, but cannot install apps nor create new grains. By default, Sandstorm allows anyone to create a new visitor account by logging in with a credential that hasn't been seen before. Since a visitor account cannot do anything unless shared with, this is safe.

The admin can modify the level of any account through the admin panel.

## Accounts are capability stores

Abstractly speaking, an account is simply a collection of capabilities -- namely, capabilities to grains.

Some of these capabilities are for grains owned by the account, in which case the resource usage of the grain counts against the account's quotas.

Some of these capabilities are for grains owned by other users. When the user opens any grain that they do not own, the grain is implicitly added to the user's capability store.

### Grain List UI

The grain organizer UI, aka the "file list", is inherently tied to accounts. This UI simply a browser for the user's capability store.

The default grain list UI should basically look like Google Drive. It should offer the user various ways to sort and filter grains, such as viewing by app, by tag, by owner (e.g. to view one's own grains vs. other people's), etc. The UI should display basic stats about grains such as their title and size (though it may not show all stats for grains owned by other accounts).

Eventually, the grain list UI should itself be an app. This app receives a capability to enumerate the user's grains and to direct the Sandstorm shell to open a particular grain. However, the grain list app should _not_ receive the capability to directly interact with any particular grain.

### Capability merging

When an account receives multiple capabilities pointing to the same grain (e.g. because multiple people shared the same grain to them, possibly under different permission levels), those capabilities are "merged" by taking the union of all permissions they grant. Thus, the user only sees one copy of each grain in their grain list, and always has their full permissions when they open the grain.

This goes against capability orthodoxy. Usually, in capability-based security, to prevent "confused deputy" attacks, it's important to use exactly the capability you received for a particular task, and not any other capabilities to the same object that you may have received in the past.

However, "confused deputy" attacks primarily affect programs, not humans, because programs lack awareness of the situation and the ability to think critically. It is much harder to trick a human this way. Meanwhile, humans generally do not expect to have to juggle multiple capabilities to the same object, with multiple permission levels. They are likely to be confused if a grain appears in their grain list multiple times, or if they open the wrong capability and find they do not have the permissions they thought they had. Therefore, merging capabilities is the right thing to do for humans, even if it is the wrong thing to do for computers.

### Powerbox

The [Powerbox](../powerbox) is inherently tied to accounts in that it implements a picker across the user's capability store.

### TODO(feature): Account merging

Two accounts can be merged, combining their capability stores and attached identities. This is useful if a user has previously created two separate accounts under two different identities (say, their Google and Facebook identities) and then realizes they really want them to be the same account. Any time a user attempts to add an identity to their account, but that identity is already attached to some other account, the user will be prompted to merge accounts. Merging requires authenticating as an owning identity on both accounts.

Account merging can be undone, returning any capabilities that were in the respective capabilities stores before the merge to their separate accounts. (This is necessary to recover after an account is hacked and then merged into some other account.)

## Profile

Each account may have some basic "profile data" associated with it:

- A display name, like "Kenton Varda".
- A photo / avatar.
- A preferred pronoun gender (the user may choose: male (he/him), female (she/her), ambiguous (they), or robot (it)).
- A preferred "handle", for apps that need something shaped like a Unix username. (Sandstorm does not guarantee uniqueness of these names, though.)
- Possibly other public profile data (and, perhaps, capabilities) provided by the user.

This data is intended to be useful for representing the user to other users within any context where they might interact. The profile data will be automatically communicated to apps that the user opens so that they can represent the user to collaborators. (In fact, the app will received a Cap'n Proto capability to the user's profile, which includes the ability to read the profile data.)

It should not be possible to trick a user into revealing their identity to you by having them open a link to a Sandstorm grain. Therefore, Sandstorm implements protections in which users are warned when they are about to reveal their identity to an unfamiliar grain and given the chance to go incognito instead. A user may also choose to go into incognito mode, in which they appear anonymous to the grains they open but still have access to their own account and powerbox.

_TODO(bug): Currently, a user can actually have multiple profiles, one attached to each of their credentials. This was part of an earlier design where we thought that it would be useful to have multiple "identities". In hindsight, this was the wrong design._

### Contacts

Each account maintains a list of "contacts" -- profiles of other accounts that it has encountered before. For example, if Alice creates a sharing link and sends it to Bob, and Bob opens the sharing link and chooses to reveal his identity, then Bob's profile will be added to Alice's contacts.

Profiles in a user's contacts can be used as sharing targets (auto-completed in the sharing UI) in order to share directly with another account, without creating a secret link (and thus without the risk of leakage of that link). Apps can also make powerbox requests for contacts, in which case the user chooses from their contact list.

TODO(feature): An app can also `offer()` a profile capability to a user in order to add someone to their contact list. Generally, whenever an app identifies one user to another (say, by showing their display name), it should make the representation clickable. On click, the application should `offer()` the identified user's profile object.

TODO(feature): When the user encounters another user's profile, e.g. through `offer()`, the powerbox will display the object's profile data along with information about when and where the user has seen this profile before. If the profile's display name or avatar are deceptively similar to a profile the user has seen before, the powerbox will warn them of this, to help detect impostors.

## Credentials

_TODO(bug): In the codebase currently, credentials are called "identities" and additionally have profile information attached, but this has been proven to be a poor design choice. See the note under "Profile", above._

Each account has one or more "credentials" attached to it.

A credential can be:

- An OAuth or OpenID account from a third-party service, e.g. Google or Github. TODO(feature): Add Twitter, Facebook, etc.
- A verified e-mail address.
- An LDAP or SAML account.
- TODO(feature): A PGP or other cryptographic key.

Credentials serve multiple purposes:

- A user can log into their Sandstorm account by proving that they have access to one of their credentials. (Note that an account may specify that only some of their credentials are trusted for this purpose.)
- Credentials often prove that the user owns certain e-mail addresses. This is most obivously true of literal e-mail credentials, but other credential types often assert the user's address, and the Sandstorm server may be configured to trust this, so that it's not necessary to actually send the user a verification message.
- TODO(feature): When users share with each other, they may choose to authenticate the target user based on credentials. E.g. the user may choose to share a grain with a particular Github username.
- TODO(feature): Some credentials connect to external services that offer APIs. The user can use the Powerbox to connect their apps to these external APIs, authenticated through the credential. Sandstorm manages access tokens associated with this, so that apps never see such secrets.

Multiple accounts can share a credential, but in this case the credential cannot be used to log into any of the accounts. Sharing a credential is useful e.g. when multiple people share access to a Twitter brand account.

### Global/Federated Authentication

It is important that credentials be "global", meaning that the same credential can be authenticated across multiple Sandstorm servers. This simplifies Sandstorm's federation features, e.g. allowing grains to be moved between servers while still keeping the same user set.

Because of this requirement, username/password authentication does not fit well into the credential system, because a username/password pair would necessarily be specific to one particular Sandstorm server.

_TODO(bug): Possibly this requirement is unrealistic. It's questionable whether LDAP and SAML authentication can really be considered global. Most companies do not expose LDAP publicly and certainly wouldn't be OK with users typing their passwords into third-party servers with federated authentication. Federated SAML is more workable but there are a lot of different ways that people configure this which probably aren't all mutually compatible. Meanwhile, there is lots of demand for built-in username/password authentication in Sandstorm. Perhaps a better way to solve the problem is to create ways that users can map their identities across Sandstorm servers, and tools allowing the identities associated with a grain to be remapped when the grain is transferred._

### TODO(feature): De-duplicating logins

When a user logs in with a credential that the Sandstorm server has not seen before, a new visitor account is created automatically.

However, this often leads to confusion. Since many Sandstorm servers support multiple types of credentials (e.g. Google, Github, and e-mail), a user might forget which one they used in the past and try a different one next time. They may then find an empty account and think their data has been lost.

Before creating a new account, Sandstorm should check if any other credentials exist with the same e-mail address. If so, it should ask the user whether they meant to create a new account or use the existing account. If they choose the latter, Sandstorm should then prompt the user to log in with the correct credential, and then (assuming success) attach the new credential to the existing account.

Relatedly, sometimes a user has multiple e-mail addresses, and forgets which one they used to log in before. This is harder to detect. Possibly, Sandstorm should make it clearer to users when they are creating a new account (probably as part of the profile creation UI), and provide a button that says "I already have an account" which can start a troubleshooting process.

## Organizations

Sandstorm supports a notion of "organizations" -- a set of credentials which belong to a single group, such as employee accounts of a company. An organization might be defined as:

- A particular G Suite domain (formerly known as Google Apps for Work, formerly known as Google Apps for your Domain).
- A particular e-mail domain.
- Everyone who authenticates with LDAP or SAML, where the LDAP/SAML server is usually a corporate SSO server.

### Self-hosted Single-org

The admin of a Sandstorm server can define a single organization for the server. Any account which possesses a credential within that organization will automatically be promoted to a full user (not a visitor).

The admin can also specify that:
- All members of the organization will automatically have all other members in their contact list.
- Collaboration with users outside the organization is prohibited. This effectively disables "visitor" accounts and prohibits opening a sharing link anonymously.

### TODO(feature): Multi-org Shared Hosting

Large shared hosts like Sandstorm Oasis should support organizational features as well, but will need to support the existence of multiple organizations. Each organization should have designated "admins" who are given access to a subset of the usual Sandstorm admin panel in order to configure their organization settings and manage users.

One possible approach to implementing this could be to have multiple metadata databases (currenly backed by Mongo), and dispatch to a database according to domain name. Each organization would get a private domain. This could allow the private domain to look very much like a private Sandstorm server, despite being backed by shared hosting (e.g. Blackrock).

## Quota Management

By default, the only limits on an account's resource usage are the limits of the host machine.

However, the adminsitrator can optionally enable three kinds of resource limits:
- Grain count (typically only applied to "free" accounts, to encourage people to upgrade)
- Disk storage
- TODO(feature): [Compute units](https://blog.sandstorm.io/news/2015-01-14-compute-units.html) (gigabyte-RAM-hours)

These quotas are assigned by the organization administrator, or purchased directly from the host.

Users can examine their current quota usage on their account settings page.
