# App publishing guide

After you've completed developing and testing your app's package for Sandstorm, you can publish it in the [Sandstorm App Market](https://apps.sandstorm.io/).

## Verify your identity

Sandstorm packages are signed in two ways to ensure the authenticity of the package source. First, with a publicly-known Keybase key, which identifies the author. And second, by signing each app with unique ed25519 keys, ensuring that new versions of the app are from an appropriately authorized source.

### Sign up with [Keybase.io](https://keybase.io)

Currently, Keybase is invite-only. If you need an invite, you can contact [community@sandstorm.io](mailto:community@sandstorm.io). You should connect some of your public identites with your Keybase account, like Twitter and GitHub.

Sandstorm app authors are verified using a PGP key linked to Keybase. You should get the [prerequisites](https://keybase.io/docs/command_line/prerequisites) and follow [their directions](https://keybase.io/docs/command_line/installation) to get their software set up.

### Link your Sandstorm package with your Keybase key

In order to verify that you are the author of the app in question, you need to sign the following ASCII statement: `I am the author of the Sandstorm.io app with the following ID: <app-id>`, where `<app-id>` is the one from your `sandstorm-pkgdef.capnp` file.

To generate a pgp-signature file using gpg, run a command like this:

`echo -n "I am the author of the Sandstorm.io app with the following ID: <app-id>" |
     gpg --sign > pgp-signature`

If you do it correctly, `cat pgp-signature | gpg` should print out the statement that you signed.

### Export your public key

To verify your signature, you also need to export your public key and include it in your app package. You can run the following command, where `<key-id>` is a PGP key ID or a username associated with the key:

`gpg --export <key-id> > pgp-keyring`

## Add required metadata

Your app's manifest, or package definition file, (`sandstorm-pkgdef.capnp`) contains all of the metadata to list it in the app store, including descriptions, screenshots, categories, and more. You can look at [Etherpad's manifest](https://github.com/kentonv/etherpad-lite/blob/sandstorm/sandstorm-pkgdef.capnp) for an example of how the data is formatted, and the most current version of the file which defines acceptable fields and values for package definition files can be found [here](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/package.capnp). You can see Etherpad's app store listing [here](https://apps.sandstorm.io/app/h37dm17aa89yrd8zuqpdn36p6zntumtv08fjpu8a8zrte7q1cn60).

### Metadata guide

#### icons

You can embed both SVGs or PNGs, and Sandstorm will use the best version provided for the use in question.

* The `appGrid` icon represents your app on the "New" screen on Sandstorm. It should be 128 x 128 pixels, and no larger than 64 KB.
* The `grain` icon represents individual grains on both the navbar and the grain list. It should be 24 x 24 pixels, and no larger than 4 KB. If you omit this, the appGrid icon will be used.
* The `market` icon is used in the app market. It should be 150 x 150 pixels, and no larger than 256 KB. If you omit this, the appGrid icon will be used.
* The `marketBig` icon is used on an app's specific page on the app market. It should be 300 x 300 pixels, and no larger than 256 KB. If you omit this, the market icon will be used (raster images may look bad).

#### website

This should be the app's main website URL.

#### codeUrl

This should be the URL of the app's source code repository, like GitHub. It is recommended if there is a repository specific to the Sandstorm package, you utilize that one, rather than the upstream one. This field is mandatory if you utilize a license that requires redistributing code, like the GPL, but is optional otherwise.

#### license

This is how you will specify the license under which you are distributing the app. The default is `none`, which conveys no rights of redistribution to the user.

Currently, the following open source licenses are recognized: `mit`, `apache2`, `gpl3`, `agpl3`, `bsd3Clause`, `bsd2Clause`, `gpl2`, `lgpl2`, `lgpl3`, `isc`, `artistic2`, `python2`, `php3`, `mpl2`, `cddl`, `epl`, and `cpal`. If you need to add an additional license, you can open an issue or submit a pull request.

You can select `openSource` and specify an OSI-approved license, or select `proprietary` and embed the full text of the license. If you choose a proprietary license, which may contain more restrictive permissions, Sandstorm will display the license to the user and have them accept it before they are able to use the app. If your app does not contain more restrictive permissions, you may consider releasing under `none` to avoid this. Finally, `publicDomain` is also available, but it is preferable to use a permissive open source license instead.

You may also need to include `notices` if your app is required to display any third-party copyright notices, for example due to use of third-party open source libraries.

#### categories

You may select the market categories to which your app belongs. You may select multiple, but you may be asked to make changes if the market moderators feel they are inappropriate.

Currently, the following categories are accepted: productivity, communications, social, webPublishing, office, developerTools, science, graphics, media, games, and other.

#### author

The author can be an individual, organization, or even a pseudo-identity representing the app. In order for users to be able to verify the author of a package, the app author must also be identified by PGP key. The Sandstorm team recommends using keybase.io.

* The `upstreamAuthor` is the name of the primary author of the original app. This indicates the author identified by the key ported the app, which was developed by someone else. If the original author is the one publishing the app, do not include this.
* The `contactEmail` is the address to contact for any issues with this app. This both includes administrative issues with the app market listing as well as end user support requests. It is very important that this email be monitored.
* The `pgpSignature` field is where you embed a signed ASCII statement verifying that you are the author of this app package.

#### pgpKeyring

This is where you embed a keyring in GPG keyring format containing the public key needed to verify your signature.

#### description

You should embed a description of your app in GitHub-flavored Markdown. It may not contain HTML or image tags, as you can attach screenshots separately.

#### shortDescription

Include two or three words here that briefly characterize your app. This is shown in the app card to people as they browse the market, and can communicate what type of app it is, like a "document editor" or a "media player".

#### screenshots

You can attach a number of screenshots here. You should specify the height and width of the picture here in pixels. You may embed PNGs or JPGs here. Your total metadata should be less than 1 MB in size, so be sure to use JPGs on photo-like screenshots.

#### changeLog

Here you may embed a log of changes in GitHub-flavored Markdown. It is recommended to format this with a H1 heading for each release followed by a bullet list of changes. As an example, you can look at Etherpad's changelog [here](https://raw.githubusercontent.com/kentonv/etherpad-lite/sandstorm/CHANGELOG.md).

## Check your work

You can run `spk verify mypackage.spk` on your app package to see the details of your metadata. Ensure everything looks like it is supposed to before you publish your app.

## Send to the Sandstorm App Market

In order to submit your app to the market, you need to run one of the following commands, depending on your build tool: `spk publish mypackage.spk` or `vagrant-spk publish mypackage.spk`.

It will then go into the queue for us to review. We'll check that everything looks right. If it does, we'll publish the app, otherwise we'll email you to let you know what needs fixing.
