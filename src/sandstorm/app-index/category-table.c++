// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2015 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#include <sandstorm/app-index/app-index.capnp.h>
#include <kj/main.h>
#include <capnp/message.h>
#include <capnp/serialize.h>
#include <capnp/schema.capnp.h>
#include <capnp/schema-loader.h>
#include <capnp/dynamic.h>
#include <unistd.h>
#include <kj/debug.h>

namespace sandstorm {
namespace appindex {

class CategoryTableMain {
  // Main class for a simple program that produces a SparseData from an input sparse file.
  // The output is written as a single-segment message (no leading segment table).

public:
  CategoryTableMain(kj::ProcessContext& context): context(context) {}

  kj::MainFunc getMain() {
    return kj::MainBuilder(context, "unknown version",
                           "Build a table of category metadata from package.capnp. Actually "
                           "this operates as a code generator plugin, but the output is a "
                           "serialized CategoryTable.")
        .callAfterParsing(KJ_BIND_METHOD(*this, run))
        .build();
  }

  kj::MainBuilder::Validity run() {
    capnp::ReaderOptions options;
    options.traversalLimitInWords = 1 << 30;  // Don't limit.
    capnp::StreamFdMessageReader reader(STDIN_FILENO, options);
    auto request = reader.getRoot<capnp::schema::CodeGeneratorRequest>();

    capnp::SchemaLoader loader;
    for (auto node: request.getNodes()) {
      loader.load(node);
    }

    kj::Vector<CategoryInfo> categories;

    capnp::Schema categorySchema = loader.get(capnp::typeId<spk::Category>());
    for (auto nested: categorySchema.getProto().getNestedNodes()) {
      capnp::Schema child = loader.get(nested.getId());
      auto proto = child.getProto();
      if (proto.isConst()) {
        auto annotations = proto.getAnnotations();
        KJ_ASSERT(annotations.size() == 1);
        auto annotation = annotations[0];
        KJ_ASSERT(annotation.getId() == 0x8d51dd236606d205ull);
        auto value = annotation.getValue();
        KJ_ASSERT(value.isStruct());

        categories.add(CategoryInfo {
          child.asConst().as<uint64_t>(),
          nested.getName(),
          value.getStruct().getAs<spk::Category::Metadata>()
        });
      }
    }

    capnp::MallocMessageBuilder result;
    auto builder = result.initRoot<CategoryTable>().initCategories(categories.size());
    for (auto i: kj::indices(categories)) {
      auto item = builder[i];
      item.setId(categories[i].id);
      item.setName(categories[i].name);
      item.setMetadata(categories[i].metadata);
    }

    capnp::writeMessageToFd(STDOUT_FILENO, result);

    return true;
  }

private:
  kj::ProcessContext& context;

  struct CategoryInfo {
    uint64_t id;
    kj::StringPtr name;
    spk::Category::Metadata::Reader metadata;
  };
};

}  // namespace appindex
}  // namespace sandstorm

KJ_MAIN(sandstorm::appindex::CategoryTableMain)
