const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const isWrappedTemplateValue = (value) => {
  return value && typeof value === "object" && !value.htmljsType && hasOwn(value, "value");
};

export const unwrapTemplateValue = (value, options = {}) => {
  if (value === null || value === undefined) return value;
  if (typeof value === "function") {
    if (options.ignoreFunctionErrors) {
      try {
        return unwrapTemplateValue(value(), options);
      } catch (e) {
        return value;
      }
    }

    return unwrapTemplateValue(value(), options);
  }

  if (Array.isArray(value)) return value.map((part) => unwrapTemplateValue(part, options));
  if (isWrappedTemplateValue(value)) return unwrapTemplateValue(value.value, options);
  return value;
};

export const coerceTemplateText = (value) => {
  const unwrapped = unwrapTemplateValue(value);
  if (unwrapped === null || unwrapped === undefined) return undefined;
  if (typeof unwrapped === "string") return unwrapped;
  if (typeof unwrapped === "number" || typeof unwrapped === "boolean") return String(unwrapped);
  if (Array.isArray(unwrapped)) {
    return unwrapped.map((part) => coerceTemplateText(part) || "").join("");
  }

  return undefined;
};
