import { setSandstormDbServerHttpCall } from "/imports/sandstorm-db/db";
import { httpCallAsync } from "/imports/server/http-helpers";

setSandstormDbServerHttpCall(httpCallAsync);
