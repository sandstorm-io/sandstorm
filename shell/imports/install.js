// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
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

function isSafeDemoAppUrl(url) {
  // For demo accounts, we allow using a bare hash with no URL (which will never upload a new app)
  // and we allow specifying a sandstorm.io URL.
  return !url ||
      url.lastIndexOf("http://sandstorm.io/", 0) === 0 ||
      url.lastIndexOf("https://sandstorm.io/", 0) === 0 ||
      url.lastIndexOf("https://alpha-j7uny7u376jnimcsx34c.sandstorm.io/", 0) === 0 ||
      url.lastIndexOf("https://app-index.sandstorm.io/", 0) === 0;
};

export { isSafeDemoAppUrl };
