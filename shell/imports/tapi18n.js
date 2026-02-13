import { Meteor } from "meteor/meteor";
import { Template } from "meteor/templating";

import en from "/i18n/en.i18n.json";
import fi from "/i18n/fi.i18n.json";
import fr from "/i18n/fr.i18n.json";
import nl from "/i18n/nl.i18n.json";
import ru from "/i18n/ru.i18n.json";
import zhCN from "/i18n/zh-CN.i18n.json";
import zhTW from "/i18n/zh-TW.i18n.json";

const dictionaries = {
  en,
  fi,
  fr,
  nl,
  ru,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
};

const languageMeta = {
  en: { name: "English" },
  fi: { name: "Finnish" },
  fr: { name: "French" },
  nl: { name: "Dutch" },
  ru: { name: "Russian" },
  "zh-CN": { name: "Chinese (Simplified)" },
  "zh-TW": { name: "Chinese (Traditional)" },
};

let currentLanguage = "en";

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const getByPath = (obj, path) => {
  const parts = path.split(".");
  let cur = obj;
  for (const part of parts) {
    if (!cur || typeof cur !== "object" || !hasOwn(cur, part)) return undefined;
    cur = cur[part];
  }

  return cur;
};

const interpolate = (raw, positional, named) => {
  if (typeof raw !== "string") return raw;

  let out = raw;
  if (positional.length > 0) {
    let idx = 0;
    out = out.replace(/%s/g, () => {
      const value = idx < positional.length ? positional[idx] : "%s";
      idx += 1;
      return `${value}`;
    });
  }

  if (named && typeof named === "object") {
    out = out.replace(/__([A-Za-z0-9_-]+)__/g, (_, key) => {
      if (hasOwn(named, key)) return `${named[key]}`;
      return `__${key}__`;
    });
  }

  return out;
};

const translate = (key, positional = [], named = undefined) => {
  const localized = getByPath(dictionaries[currentLanguage], key);
  const fallback = getByPath(dictionaries.en, key);
  const raw = localized !== undefined ? localized : fallback;
  if (raw === undefined) return key;
  if (typeof raw !== "string") {
    if (Meteor.isClient) {
      console.warn(`Non-string i18n value for key "${key}"`);
    }

    return key;
  }

  return interpolate(raw, positional, named);
};

const deferredResult = {
  done(fn) {
    if (typeof fn === "function") fn();
    return this;
  },
  fail(_) {
    return this;
  },
};

const TAPi18n = {
  __(key, ...args) {
    let named;
    let positional = args;
    if (args.length > 0) {
      const last = args[args.length - 1];
      if (last && typeof last === "object" && !Array.isArray(last)) {
        named = last;
        positional = args.slice(0, -1);
      }
    }

    return translate(key, positional, named);
  },

  getLanguages() {
    return languageMeta;
  },

  setLanguage(lang) {
    if (hasOwn(dictionaries, lang)) {
      currentLanguage = lang;
    } else if (lang && lang.includes("-")) {
      const prefix = lang.split("-")[0];
      if (hasOwn(dictionaries, prefix)) currentLanguage = prefix;
    }

    return deferredResult;
  },
};

if (Meteor.isClient) {
  const coerceTemplatePrimitive = (value) => {
    if (value === null || value === undefined) return value;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return value;
    }

    if (typeof value === "function") return coerceTemplatePrimitive(value());
    if (Array.isArray(value)) {
      return value.map((part) => {
        const coerced = coerceTemplatePrimitive(part);
        return coerced === null || coerced === undefined ? "" : String(coerced);
      }).join("");
    }

    if (typeof value === "object" && hasOwn(value, "value")) {
      return coerceTemplatePrimitive(value.value);
    }

    return value;
  };

  Template.registerHelper("_", function (key, ...args) {
    const normalizedKey = coerceTemplatePrimitive(key);
    if (typeof normalizedKey !== "string") return "";
    const last = args.length > 0 ? args[args.length - 1] : null;
    const hash = last && typeof last === "object" && hasOwn(last, "hash") ? last.hash : undefined;
    const positional = hash ? args.slice(0, -1) : args;
    const translated = translate(normalizedKey, positional, hash);
    if (typeof translated !== "string") {
      console.error("i18n helper returned non-string", {
        key: normalizedKey,
        originalKey: key,
        translated,
        positional,
        hash,
      });
      return normalizedKey;
    }

    return translated;
  });
}

export { TAPi18n };
