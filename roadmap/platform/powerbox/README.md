# Powerbox

The Powerbox is how user connect apps to each other. It is a user interface which allows a user to take a capability (in the Cap'n Proto sense) from one app and give it to another app.

The basic idea behind the Powerbox is:
- At some point, grain A says to Sandstorm: "I have an object implementing Cap'n Proto interface `Foo`; here is a capability to it."
- Later, grain B says to Sandstorm: "I need a capability implementing Cap'n Proto interface `Foo`."
- The system displays a dialog box to the user which allows them to pick from among all their capabilities implementing `Foo` to satisfay grain B's request. Included in the list is grain A's capability, and others like it.
- Grain B receives a Cap'n Proto capability for the object the user chose. By definition, the capability comes with permission to use the object, so the app need not make any separate permissions request. Meanwhile, the app never gets permission to talk to (or even become aware of the existance of) any other capabilities than the one the user chose.

Powerboxes exist today. The best-known example is the `<input type="file">` HTML element. When the user clicks on the element, they are presented with a "file open" dialog. This dialog is, int fact, a powerbox: the requesting web site gets permission to read the file the user chooses and no other.

## UX Styles

The commonly-described "file-open" style of Powerbox is actually only one style. In general, a Powerbox is any UI element which allows the user to grant one app a capability exported from another app.

Sandstorm will implement several styles of Powerboxen.

### File-open style

The default style, as described above.

The file-open dialog implements a heirarchical browser. Initially, the user is shown a list of grains which may be able to satisfy the request. When the user chooses one, the dialog drills down into that grain, and now the user must choose from among capabilities exported by that grain.

A providing app may customize the dialog with its own user interface that the user sees after selecting the grain. For example, in a powerbox request for an audio clip, a music library app might implement a powerbox plugin implementing a UI allowing the user to search or sort by title, artist, genre, etc. An app can even implement a powerbox plugin which creates a brand new capability on-demand, or which allows the user to attenuate a capability, say by making it read-only.

TODO(feature): Some apps may support creating a whole new grain on-demand to satisfy a powerbox request. In this case the user will see "Create a new X" if the app is installed. Additionally, the powerbox may include a "Find an app on the app store" option. (It would be nice to show this option only when we suspect it is relevant, but we should not leak data about the powerbox request to the app store until the user actually clicks it. Perhaps Sandstorm could pre-download a table of request types known to be satisfiable by popular apps.)

### TODO(feature): Autocomplete style

Consider the case of choosing a set of contacts to whom to send an e-mail. The application presents a box where the user may type arbitrary text. When the user does so, possible completions of their text are displayed, and the user can click on one. The user may be able to select multiple objects in this way, all of which are granted to the app.

The autocomplete style is preferrable when the user has a large number of choices that are not organized and the user is likely to remember their text titles. Note that the file-open style of powerbox should also include text search, but the autocomplete style is lighter-weight.

Implementation of this style will be tricky as the powerbox should appear as if it were a regular widget embedded in the app UI, while it is in fact rendered by Sandstorm as an overlay. The app will need to communicate to Sandstorm the location to render the widget.

### TODO(feature): Drag-and-drop

Here, the providing app exposes a draggable UI element representing a capability while the accepting app implements a drop target. The providing app may optionally display a dialog to the user after the drag-and-drop action takes place, but before the capability is granted, in which the user may configure the capability further, such as limiting its permissions.

### TODO(feature): Have object, want app

While the file-open and autocomplete powerbox styles are initiated by a requesting app and return to it a capability, sometimes the opposite is desired: the providing app may want to actively offer a capability to the user, at which point the Powerbox allows the user to decide what to do with it. We call this a "powerbox offer" as opposed to a "powerbox request".

This case may look visually similar to the file-open style, but instead of choosing an object, the user is choosing an app or grain. Some apps may support creating a new grain on-demand to satisfy a Powerbox offer. Some apps may support giving the capability to an existing grain.

## TODO(feature): Incoming OAuth

Sandstorm will implement OAuth (or an OAuth-style protocol) to allow third-party sites and clients to request access to a user's Sandstorm grains.

Whereas most OAuth flows involve a simple yes/no security request, Sandstorm will display a Powerbox, passing back to the requester an API key for the specific capbaility the user chose.

## Query format

When an app market a powerbox request, it specifies one or more `PowerboxDescriptor`s describing the types of capabilities it is interseted in. These are matched against the `PowerboxDescriptor`s each responding app claims to advertise in order to narrow the list of options to present to the user. In many cases the descriptor may simply specify the type ID of a Cap'n Proto interface which the requester is interested in, but in some cases it's useful to further narrow the request. For exampule, an app requesting an image file may specify a generic `File` interface as the type, but may wish to additionally specify that the file should have MIME type `image/*`.

## Special Capability Types

The Powerbox includes special handling for some capability types:

- A request for a `UiView` -- the main interface implemented by any grain -- is effectively a request to choose a whole grain. This is especially useful to implement capability-based sharing: a messaging app may allow a user to attach a grain to a message in order to share it with the recipient. When the user selects a grain, they will also be prompted to choose the role (permissions) that the recipient should receive, as well as specify a petname, as described in [the sharing section](../sharing).

- A request for an `Identity` may allow the user to choose identities from a variety of sources that are not the usual objects-published-by-apps. For example, the user could choose a person that appears on the ACL of another grain, or choose from people who have shared with them in the past, etc. In general, Sandstorm should keep track of people whom you have interacted with in order to populate the Powerbox for an `Identity` request. Note that the sharing UI itself may use an `Identity` Powerbox request to fill in identities to share with. See [profiles](../accounts#profiles).

- Various other "pseudo drivers" are implemented directly in the Sandstorm shell rather than by apps, and so are special-cased there.
