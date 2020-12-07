@0xf162f563e1736592;

using Json = import "/capnp/compat/json.capnp";

struct LookupResults {
  status :group {
    code @0 :UInt32;
    name @1 :Text;
  }
  them @2 :List(LookupResult);
}

struct LookupResult {
  id @0 :Text;
  basics :group {
    username @1 :Text;
  }
  profile :group {
    fullName @2 :Text $Json.name("full_name");
  }
  pictures :group {
    primary :group {
      url @3 :Text;
    }
  }
  proofsSummary :group $Json.name("proofs_summary") {
    all @4 :List(Proof);
  }
}

struct Proof {
  proofType @0 :Text $Json.name("proof_type");
  nametag @1 :Text;
  serviceUrl @2 :Text $Json.name("service_url");
}
