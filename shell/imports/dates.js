// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2016 Sandstorm Development Group, Inc. and contributors
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

function formatFutureTime(diff) {
  // diff is in milliseconds
  const units = {
    day: 86400000,
    hour: 3600000,
    minute: 60000,
    second: 1000,
  };

  for (const unit in units) {
    // If it's more than one full unit away, then we'll print in terms of this unit.
    if (diff >= units[unit]) {
      const count = Math.round(diff / units[unit]);
      return "in " + count + " " + unit + (count > 1 ? "s" : "");
    }
  }

  // We're within a second of the countdown, or past it.
  return "any moment";
};

export { formatFutureTime };
