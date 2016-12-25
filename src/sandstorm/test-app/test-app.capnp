@0xdb849475182f3bb4;

#$import "/capnp/c++.capnp".namespace("sandstorm::testapp");

using Powerbox = import "/sandstorm/powerbox.capnp";
using Grain = import "/sandstorm/grain.capnp";
using Spk = import "/sandstorm/package.capnp";

const testAppHtml :Data = embed "test-app.html";
const testPowerboxHtml :Data = embed "test-powerbox.html";

interface TestPowerboxCap @0xdf9518c9479ddfcb extends(Grain.AppPersistent(Text)) {
  struct PowerboxTag {
    i @0 :UInt32;
    s @1 :Text;
  }

  read @0 () -> (text: Text);
}

const testTag :TestPowerboxCap.PowerboxTag = (i = 123, s = "foo");

const testDesc :Powerbox.PowerboxDescriptor = (
  tags = [
    (
      id = 0xdf9518c9479ddfcb,
      value = .testTag,
    )
  ]
);

const testTag2 :TestPowerboxCap.PowerboxTag = (i = 123, s = "bar");

const testDesc2 :Powerbox.PowerboxDescriptor = (
  tags = [
    (
      id = 0xdf9518c9479ddfcb,
      value = .testTag2,
    )
  ]
);

const testTag3 :TestPowerboxCap.PowerboxTag = (i = 123);

const testDesc3 :Powerbox.PowerboxDescriptor = (
  tags = [
    (
      id = 0xdf9518c9479ddfcb,
      value = .testTag3,
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
