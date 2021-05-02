// This file is an indirection that re-exports the tap:i18n API for use
// by our typescript code. It exists because:
//
// - There are no upstream type declarations for tap:i18n, so we have to supply them
//   ourselves.
// - I(zenhack) have found adding an indirection like this to be easier than trying
//   to set up the search path for declaration files correctly for a stand-alone
//   declaration.
// - (Less importantly) the original module path has a ':' in it, which is likely to
//   cause problems for anyone who tries to check out the source for Sandstorm on a
//   windows box.
import { TAPi18n } from "meteor/tap:i18n";
export { TAPi18n }
