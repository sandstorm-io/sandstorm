# Activity Events

Sandstorm offers an API to apps through which they can indicate when an "activity event" occurs. An activity event is any event that might be useful to log and/or to notify users about. For example, Etherpad logs at activity event every time a user makes some edits, or leaves a comment.

## Activity indicator

Grains which have had new activity which the user hasn't seen yet will be highlighted in the user's grain list and (if they are currently open) in the sidebar. This allows users to notice when things change, without having to repeatedly open the grains to scan for changes.

## Notifications

Activity events may generate notifications, to more actively attract the user's attention. There are a number of rules that determine when and how notifications should be generated. The app may indicate certain event types should be "noisier" than others, and individual events can indicate that they "mention" certain users, both of which affect whether the event generates notifications and to whom.

TODO(feature): The user, for their part, may adjust the "noisiness" levels of each type of notification or subscribe to certain grains or "threads" in order to control what kinds of events generate notifications for them.

Notifications may be delivered in several forms:

- Via the "bell menu" in the upper-right corner. When unread notifications arrive, a number appears in a small red circle, attracting the user to click the bell icon and open the menu. The notifications are dismissed when the user visits them or clicks to dismiss them.
- Via the sidebar, for open grains, an indicator will show if there are new notifications.
- Via HTML5 desktop notifications, if Sandstorm is open when the notification arrives.
- TODO(feature): Via e-mail, if the user has configured it.

### TODO(feature): Notification threads and inline replies

Many apps organize activity into "threads". Think, for example, of Github, where each issue and each pull request is a thead.

Often, it is convenient for users to be able to "reply" to these threads directly in the notification interface, without actually opening the full app. For example, when the user clicks a notification in the bell menu, it could expand the full thread and let the user reply there.

More interestingly, for e-mail notifications, the user might simply reply to the e-mail. Sandstorm should take care of sanitizing this reply (e.g. removing bottom-quoted e-mail text and other extraneous info) in order to post back to the app.

## TODO(feature): Audit logging / activity feeds

Activity events also feed into Sandstorm's audit logging system.

- Users can see a unified feed of activity occurring across grains to which they have access, or perhaps across all grains in a particular collection, etc.
- The organization administrator can enable organization-wide audit logging, in which case they can monitor all activity across the organization.

Audit logging is important for security and is often required by various regulations, e.g. HIPAA.
