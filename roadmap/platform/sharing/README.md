# Sharing

"Sharing" is when a user who has access to a grain makes the grain accessible to other users. Usually, these users are all human. Granting access to apps (rather than humans) is typically done through [the Powerbox](../powerbox) instead.

* [**Model:**](#model) How access control is represented and governed.
* [**Sending:**](#sending) How the user grants access to new collaborators.
* [**Auditing:**](#auditing) How the user checks who has access to a grain (and possibly edits that access).
* [**Policies:**](#policies) How the user restricts the sharing actions of downstream users.

## Model

Sandstorm apps need not track users' permissions internally; all access control is performed thorugh the platform UI.

When a user opens a grain, a new UI session is created. At this time, the platform informs the app of what permissions the creating user possesses over the grain. It is up to the app to enforce these permissions by prohibiting the session from performing any actions outside of what the permissions allow. The app should typically also use the permissions to modulate the user interface such that disallowed actions are not offered in the first place.

When using `sandstorm-http-bridge`, permissions are passed to the app as a header on every HTTP request made in the session.

If a user's permissions change while they have a session open, the session will immediately be closed, forcing the user to reconnect and open a new session, which will have the new permissions.

### Roles

An app may define, as part of its manifest, a set of "roles" which may be assigned to users. For example, a document editor app may have roles like "editor", "commenter", and "viewer".

Any time a user shares access to a grain, they specify exactly one role to assign to the recipient.

### Permissions

In addition to roles, an app may also define a set of "permissions" which may be assigned to users. For example, a document editor app may have permissions "read", "write", and "add comment". The difference between roles and permissions is that permissions are independent, orthogonal bits. Each role maps to a set of permissions that it grants. In our example, "editor" grant all three permissions, whereas "viewer" would only grant the "read" permission.

The reason for the separation of roles and permissions is:

- Roles are much more user-friendly, because they match the user's mental model and eliminate nonsensical choices. For example, it usually makes no sense to grant someone write access to a document without read access -- they wouldn't be able to see what they're doing. Roles can be listed in a drop-down menu where the user makes a single selection.

- However, we need a well-defined way to "union" two roles. Imagine Alice owns a document and shares role B to Bob and role C to Carol. Now imagine both Bob and Carol share their respective roles to Dave. What access does Dave have? If neither B nor C is a superset of the other, this question is hard to answer. Our solution is to map both roles to permission sets, then union the sets.

The sharing UI could offer an "advanced" menu where individual permissions can be enabled or disabled, with a warning that the result may not make any sense.

### Delegation

Normally, any user who has access to a grain may share that access with others. This differs from traditional ACL-based sharing where typically only the owner can grant access to new people.

Delegation is the cornerstone of civilization. Prohibiting it prevents people from getting work done. For example, if I hire an assistant to help me with some work, it's important that I be able to grant them access to the things I'm working on, even when I'm not the owner of those things. Making me ask permission from the owner is an unnecessary obstacle.

It is technically impossible to prevent delegation. No matter what security measures you implement, I can always run a proxy program on my computer which allows a third party to act as me. More commonly, users are often driven to share their login credentials, which is a huge security risk. It's better that delegation be permitted.

With that said, the owner of a grain has a right to know when delegation has occurred, and has a right to know who performed the delegation. That is to say, if I grant my assistant access to your document, then you should be able to see that my assistant has access and that they gained access by my doing. Moreover, if you revoke *my* access, my assistant's access should by default be revoked as well.

Despite all of the above, we recognize that in some cases the owner of a grain may feel more comfortable prohibiting delegation as a matter of policy. For example, I may share pictures from a private party with some friends, but I may not want my friends to share those pictures with others, and I may be worried that my friends will share the pictures without thinking. In these cases I should be able to specify a policy that the grain cannot be reshared, and Sandstorm should enforce this policy on a "best effort" basis. As described above, it's impossible to actually prevent resharing (my friends could always download the pictures and e-mail them to someone), but by blocking them from sharing through the regular UI I can be fairly confident that my friends won't reveal my private pictures by accident.

### Petnames

When a user shares a grain with a new recipient, the newly-created sharing link should be assigned a descriptive label so that the user can identify it in the future. Usually, the label should describe who the user believes they are sharing with, and perhaps why.

Petnames allow the sharing graph to be represented without a global identity authority. With petnames, even if all of the recipients of sharing are completely anonymous, the sending user can still understand who they shared with.

With that said, where possible we will also supplement the sharing graph visualization with names and photos based on [account profiles](../accounts#profile).

## Sending

When the user clicks the "share" button in the UI, they are presented with the "send" UI, since this is what the user is usually interested in. The auditing and policy UIs hang off of this, perhaps as menus or links the user can click through.

The sending UI allows the user to grant another user access to the grain. Note that any user of a grain -- not just the owner -- can share whatever access they have. Delegation is the cornerstone of civilization. (But policies may voluntarily limit delegation; see below.)

### Email sharing

The user may enter an e-mail address in the sharing box along with a message. Sandstorm will send an e-mail to the given address containing a secret URL which the recipient may click to gain access to the document.

E-mail sharing should work correctly when the recipient is a mailing list. This means that there cannot be a limit on the number of people who are allowed to exercise the secret URL. However, the audit UI will allow the user to see how many separate people received a particular link.

If possible, the secret URL should be embedded inside an attachment. Most mail clients include attachments in forwarded messages but not in replies, which seems appropriate for capability URLs. Experience shows that if the URL is embedded in the body of the message, users will not understand that replying to the message (and possibly CC'ing other people on the reply) will give them access.

### URL Sharing

Instead of sending e-mail, the user may request the creation of a new secret URL which they may send through any arbitrary communications medium (e.g. by IM). The user still specifies a role to share and a petname, then is given a URL to share.

### Request Access

If the user copy/pastes the grain URL from their address bar, this does not grant any access to the recipient. If the recipient does not already have access, they will be presented with the opportunity to request access. If they do so, an e-mail will be sent to the grain owner prompting them to share the grain. This flow is not meant to be a primary method of sharing, but rather is meant as a way to recover from sharing failures.

### Powerbox Sharing

This is another alternative to the sharing UI. A communications app written for Sandstorm could support attaching capabilities to messages. When the user invokes this functionality, the app will make a powerbox request for a capability to attach (specifically, a UiView capability). Within the powerbox, the user specifies a role and a petname. The capability is attached to the message and sent to another user, who upon receipt may click on the capbaility to open the grain.

This approach is implemented for example by Rocket.Chat (sharing a grain to a chat room) and the collections app.

## Auditing

Some time after sharing is occurred, the user needs the ability to find out who has access to a grain, and possibly modify or revoke said access. Through the sharing UI, users will have access to the "audit" interface for this purpose.

### Graph Visualization

The audit UI will include a visualization of the sharing graph.

The purpose of this visualization is to communicate:
- Which users have access to the grain, and their access levels.
- Which users shared access to which other users, and the access levels shared.
- Which other grains may be communicating with the grain (e.g. via connections set up by powerbox interactions).

### TODO(feature): Access Log

The audit UI will feature an access log showing timestamps at which users accessed the grain. With the help of the app (through the [activity events API](../activity)), the log can also display details about what the user did during the visit.

### Revocation

Any user may revoke (or modify permissions of) any sharing link they created.

For example, say Alice owns a document which she shares to Bob and Carol, and Bob reshares his access to Dave. Bob can revoke Dave's access, but cannot revoke Carol's access. If Carol also shares to Dave, then Bob can revoke the access Dave received from Bob but cannot affect the access Dave received from Carol.

A tricky question in the above scenario is: can Alice directly revoke Dave's permissions?

Alice can revoke Bob's (and Carol's) permissions, which will cause Dave to transitively lose the access he received from them. (If Alice actually wants Dave to keep access, she can replace his access with a direct share.)

However, if Alice wishes to revoke Dave without affecting Bob and Carol, she can only do it by imposing a new [policy](#policies) on Bob and Carol. This doesn't actually remove the sharing link to Dave, but makes it invalid.

## TODO(feature): Policies

Policies allow a user to specify restrictions on downstream users' ability to reshare the access they receive from the user specifying the policy.

For example, say Alice is arranging a surprise party for Dave and is using a Sandstorm app to coordinate. She shares the grain to Bob and Carol, but she's worried that they might accidentally pass the grain to Dave. So, Alice may apply a policy saying "Dave should never receive access.".

Policies are fundamentally voluntary. The system makes a best-effort attempt to enforce policies, but it cannot truly prevent Bob or Carol from giving Dave access, for example by copy/pasting the grain contents or by running a proxy app that allows Dave to act on Bob's or Carol's behalf. Alice must rely on the fact that Bob and Carol aren't actively trying to subvert her, in which case policies are safe.

### Applying a policy

A policy may be applied to all of a user's outgoing share links, or to some subset.

A policy specifies negative permissions: permissions bits which are not allowed to be shared to some destination. The user interface may simplify this by allowing the user to specify a "maximum role" and then disallowing the permissions bits not granted by that role.

### Policy targets

The "target" of a policy is the user or users who are being prevented from gaining access.

Possible targets include:
- A particular user, specified by an identity and applying to any account tied to that identity.
- All users who do not have rights to create grains on the Sandstorm server.
- All users who are not members of a particular Blackrock organization.
- Apps (that is, the policy prevents the user from connecting a grain to other grains using powerbox).

Instead of a target, a policy can also specify a depth of sharing that is allowed, or a total number of users that one user is allowed to share with (transitively).

### Super policies

Super policies apply across a whole collection of grains. A super policy may be set by:
- A user, across all of their own grains.
- A server administrator, across all grains on the server.
- A Blackrock organization owner, across all grains belonging to users in the organization.

Super policies may apply to specific apps (and thus can specify permissions limitations specific to that app) or may apply across all apps (in which case they can only deny *all* permissions).

For instance, a paranoid compary may wish to prevent its employees from sharing grains to non-employees.
