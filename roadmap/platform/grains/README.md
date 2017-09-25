# Grains

A grain is an instance of an app. A grain typically represents some logical unit of sharing, e.g. each document in Etherpad is a grain. Each grain runs in a separate container isolated from other grains by default. The grain receives some private storage space and can export a user interface. Over time, grains can import and export capabilities, thus forming connections to other grains or the outside world.

A grain is thus a combination of:

- Some metadata, mainly identifying what app to run it with.
- Some storage (POSIX filesystem).
- Outgoing capability connections to other grains.

Sandstorm supports many useful operations on whole grains independent of the application.

## Backup

### One-off

A user may interactively download a grain as a zip archive file containing the grain's complete filesystem contents and some metadata. This backup can be uploaded to the same server or a different one to create a new grain with exactly the same state.

Metadata is stored about the users and capabilities the app knows about so that these can be reconnected to working objects when the backup is later restored.

_TODO(bug): Currently capabilities are not retained in any way, so they'll all fail to restore after restoring a backup._

_TODO(bug): Currently user IDs are not tracked in any special way in grain backups, so after saving a backup and restoring it, the app will not recognize users of the restored copy as being in any way related to users of the original (except that some apps special-case the owner). To fix this we need to record a table of known users in the grain's metadata, and we need to provide a UI to map these identity IDs to users on restore. The metadata should record hints about the user's identity (e.g., their e-mail address) which can be used to automatically fill in the mapping on restore, but allowing the restorer to fill the mapping manually will be necessary in cases where the grain has transferred to a different server that uses a different login mechanism._

### TODO(project): Mass backup

Sandstorm will offer an API by which an app can act as a backup agent for other data on the Sandstorm server. Through the API, the app can get access to encrypted archives of other grains. It may then store those in some arbitrary remote location, e.g. on Dropbox or Amazon Glacier.

For a regular user, the app is able to back up that user's own grains. For an admin, the app can back up all grains from all users.

## TODO(project): Server sync

A grain may be transferred between Sandstorm servers. When this occurs, all persistent capability connections between the grain and other grains are automatically redirected appropriately so that they continue to work.

A grain may even be configured to exist on two servers simultaneously, but only actually executes on one server at a time. When a user opens a grain while it is not running anywhere, it will be started up on the server that the user is currently using, and other servers will mark their version of the grain as outdated. Before the grain can start on another server, they must syncronize. If syncronization is impossible (say, because a server is isolated from the network), the user can still choose to [fork](../version-control) the grain.

## TODO(project): Version Control

Sandstorm can provide classic "git" operations on grains:

- Snapshot
- Rollback
- Fork (aka "clone" or "make a copy")

Users can access these functions directly through the UI.

### History

Sandstorm will automatically maintain snapshots of grains so that the user can roll back in case of problems (this is particularly useful after upgrading to a new version of the app and discovering that it is broken). Automatic snapshots should be taken frequently, but thinned out as they age. Snapshots should be stored as a diff, not as a complete copy.

### Forking

The default implementation of fork simply copies the grain's storage. This approach is simple and robust, but is only safe to offer to the grain's owner, because the grain's storage may contain secrets that aren't intended to be visible to anyone else.

An app may implement an explicit fork function by defining, in its manifest, an action taking a capability to another grain as input. This then creates a new grain and initializes it to a copy of the input grain using only interfaces to which the forking user has permissions.

### Merging

Merging cannot be directly implement at the platform level, as the logic for merging depends on the app's data model. Instead, an app may implement merge as a regular app feature, by making a powerbox request for an instance to merge from and then implementing any arbitrary business logic on top of that to perform the merge.

## TODO(feature): Grain groups

Sometimes it makes sense to perform the operations above on a whole group of grains in one archive, e.g. back up a collection and all its contents in one archive. Sandstorm should support this. Capabilities pointing within a group should, upon cloning, point to the new cloned copy, while capabilities pointing outside the group should continue to point to the same object as the original copy did.

It's currently unclear how a "group" should be defined -- should the user manually specify, or can it be automated somehow? Maybe a selection UI can be informed by analyzing the capability graph?

## TODO(project): Subordinate Grains

A grain can create additional grains that it directly owns. A subordinate grain runs in its own container, but does not export a `UiView`. Instead, the bootstap capability exported by the subordinate's main process can have any type, as it is only given to the parent grain, and the parent similarly exports an arbitrary bootstrap capability to the subordinate. A subordinate grain runs the same package as its parent, but starts up (and continues) using a different command, specified by the parent grain when it creates the subordinate.

Subordinate grains are useful for two main purposes:

1. They allow a grain to distribute itself over a Blackrock cluster, since each subordinate grain may execute on a different machine. This could be useful, for example, to run Hadoop on Sandstorm.
2. They allow an app to use Sandstorm containers to isolate its own components from each other for added security. This may be particularly useful if the app needs to run some code it doesn't trust, such as a continuous integration system trying to test a pull request from an untrusted third party. (However, where practical, apps should instead use a language that allows for sandboxing, especially an object-capability language, which will be much more efficient than subordinate grains.)

Subordinate grains are completely invisible to the user. They do not appear in the user's [account](../accounts), and any action that normally operates on a whole grain (like downloading a backup) includes all subordinate grains as well.

Subordinate grains can start up and shut down independently of their parent. When creating a new grain, the parent receives a capability to force it to stay open, similar to the [background processing API](../background).

Note that it is up to the parent grain to implement SturdyRef infrastructure that reaches the subordinate. From the platform's point of view, externally-held SturdyRefs pointing into a grain point at the top-level grain only, never directly to a subordinate, although the app may internally implement routing of `restore()` requests into subordinate grains. Similarly, a subordinate grain does not, by default, receive `SandstormApi` and thus has no way to restore SturdyRefs unless the parent gives it such a capability.

### Owned grains

A slightly different class of subordinate grains, owned grains are grains that run a different app from the owner, but are treated like subordinate grains for ownership purposes. That is, the grain is owned by another grain, not by a user. This could be used to implement an app which contains or embeds other apps, but where it is inappropriate for the contained/embedded grains to appear directly on the owners's grain list, and where the embedded grains should be destroyed when the owning grain is destroyed.

An app responding to a powerbox request may actually create a new grain that satisfies the request, and may cause the requesting grain to take ownership of the newly-created grain. This is useful for a couple reasons:

- If the new grain contains some data that needs to be deleted when the requesting grain is destroyed (or when it drops all its references to the owned grain).
- If the new grain contains secrets that ought to be separate, in an access control sense, from the grain that responded to the request. For example, an e-mail client app might make a request for an IMAP mailbox. The IMAP driver might guide the user through specifying their IMAP server credentials, which are a secret. The IMAP driver could then store those secrets itself, and return a Mailbox capability back to the requesting app. However, this leads to a situation where the server's IMAP driver becomes a high-value target: it stores credentials for many different users. Meanwhile all users have permission to open the IMAP driver thus can potentially attack it. To solve this, the IMAP driver may instead create a new grain that stores the credentials, and may return that grain to be owned by the e-mail client grain. This way, the credentials are stored in a grain that is only accessible to the user who owns them. Sandstorm's usual access control and fine-grained encryption can then be relied upon for security.
