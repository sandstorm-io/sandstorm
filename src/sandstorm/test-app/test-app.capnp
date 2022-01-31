@0xdb849475182f3bb4;

$import "/capnp/c++.capnp".namespace("sandstorm::testapp");

using Powerbox = import "/sandstorm/powerbox.capnp";
using Grain = import "/sandstorm/grain.capnp";
using Spk = import "/sandstorm/package.capnp";

const testAppHtml :Data = embed "test-app.html";
const testPowerboxHtml :Data = embed "test-powerbox.html";
const testShutdownHtml :Data = embed "shutdown.html";
const testStaticHtml :Data = embed "static-index.html";

struct ObjectId {
  union {
    text @0 :Text;
    scheduledCallback :group {
      shouldCancel @1 :Bool;
      refStr @2 :Text;
    }
  }
}

interface TestPowerboxCap @0xdf9518c9479ddfcb extends(Grain.AppPersistent(ObjectId)) {
  struct PowerboxTag {
    i @0 :UInt32;
    s @1 :Text;
  }

  read @0 () -> (text: Text);
}

interface PersistentCallback extends(Grain.ScheduledJob.Callback, Grain.AppPersistent(ObjectId)) {}

# Constants used to generate powerbox queries in test-app.html.
#
# To convert e.g. `testDesc` to a base64-packed query string, do:
#
#     capnp eval -p -Isrc src/sandstorm/test-app/test-app.capnp testDesc |
#       base64 -w0 | tr '/+' '_-' | tr -d '='

const testTag :TestPowerboxCap.PowerboxTag = (i = 123, s = "foo");

const testDesc :Powerbox.PowerboxDescriptor = (
  tags = [
    (
      id = 0xdf9518c9479ddfcb,
      value = .testTag,
    )
  ]
);

const testTagNoMatch :TestPowerboxCap.PowerboxTag = (i = 123, s = "bar");

const testDescNoMatch :Powerbox.PowerboxDescriptor = (
  tags = [
    (
      id = 0xdf9518c9479ddfcb,
      value = .testTagNoMatch,
    )
  ]
);

const testTagWildcard :TestPowerboxCap.PowerboxTag = (i = 123);

const testDescWildcard :Powerbox.PowerboxDescriptor = (
  tags = [
    (
      id = 0xdf9518c9479ddfcb,
      value = .testTagWildcard,
    )
  ]
);

# ========================================================================================

const pkgdef :Spk.PackageDefinition = (
  id = "6r8gt8ct5e774489grqvzz7dc4fzntpxjrusdwcy329ppnkt3kuh",

  manifest = (
    appTitle = (defaultText = "Sandstorm Test App"),

    appVersion = 0,
    appMarketingVersion = (defaultText = "0.0.0"),

    actions = [
      ( title = (defaultText = "New Test App Instance"),
        nounPhrase = (defaultText = "instance"),
        command = (argv = ["/test-app"])
      )
    ],

    continueCommand = (argv = ["/test-app"])
  ),

  sourceMap = (
    searchPath = [
      ( packagePath = "test-app", sourcePath = "test-app" ),
    ]
  ),

  alwaysInclude = [ "test-app", "sandstorm-manifest" ]
);
