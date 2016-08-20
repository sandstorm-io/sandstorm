import { HTTP } from "meteor/http";

const userPictureUrl = function (user) {
  if (user.services && !(user.profile && user.profile.picture)) {
    // Try to determine user's avatar URL from login service.

    const google = user.services.google;
    if (google && google.picture) {
      return google.picture;
    }

    const github = user.services.github;
    if (github && github.id) {
      return "https://avatars.githubusercontent.com/u/" + github.id;
    }

    // Note that we do NOT support Gravatar for email addresses because pinging Gravatar would be
    // a data leak, revealing that the user has logged into this Sandstorm server. Google and
    // Github are different because they are actually the identity providers, so they already know
    // the user logged in.
  }
};

const fetchPicture = function (db, url) {
  try {
    const result = HTTP.get(url, {
      npmRequestOptions: { encoding: null },
      timeout: 5000,
    });

    const metadata = {};

    metadata.mimeType = result.headers["content-type"];
    if (metadata.mimeType.lastIndexOf("image/png", 0) === -1 &&
        metadata.mimeType.lastIndexOf("image/jpeg", 0) === -1) {
      throw new Error("unexpected Content-Type:", metadata.mimeType);
    }

    const enc = result.headers["content-encoding"];
    if (enc && enc !== "identity") {
      metadata.encoding = enc;
    }

    return db.addStaticAsset(metadata, result.content);
  } catch (err) {
    console.error("failed to fetch user profile picture:", url, err.stack);
  }
};

export { userPictureUrl, fetchPicture };
