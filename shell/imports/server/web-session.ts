// This module provides mappings from status codes to WebSession responses.
//
// TODO: ideally we would generate some or all of this from the schema
// itself.

export type ResponseCodeInfo =
  | { type: "content", code: "ok" | "created" | "accepted" }
  | { type: "noContent", shouldResetForm: boolean }
  | { type: "redirect", switchToGet: boolean, isPermanent: boolean }
  | { type: "preconditionFailed" }
  | {
      type: "clientError",
      clientErrorCode:
        | "badRequest"
        | "forbidden"
        | "notFound"
        | "methodNotAllowed"
        | "notAcceptable"
        | "conflict"
        | "gone"
        | "requestEntityTooLarge"
        | "requestUriTooLong"
        | "unsupportedMediaType"
        | "imATeapot",
      descriptionHtml: string,
    }
  | { type: "serverError" }

export const responseCodes: { [k: number]: ResponseCodeInfo } = {
  200: { type: "content", code: "ok" },
  201: { type: "content", code: "created" },
  202: { type: "content", code: "accepted" },
  204: { type: "noContent", shouldResetForm: false },
  205: { type: "noContent", shouldResetForm: true },

  // Unsupported until something demonstrates need.
  // 206: {type: 'noContent'},
  // 300: {type: 'redirect'},
  301: { type: "redirect", switchToGet: true, isPermanent: true },
  302: { type: "redirect", switchToGet: true, isPermanent: false },
  303: { type: "redirect", switchToGet: true, isPermanent: false },

  304: { type: "preconditionFailed" },

  // Unsupported until something demonstrates need.
  // 305: {type: 'redirect'},
  307: { type: "redirect", switchToGet: false, isPermanent: false },
  308: { type: "redirect", switchToGet: false, isPermanent: true },
  400: { type: "clientError", clientErrorCode: "badRequest", descriptionHtml: "Bad Request" },
  403: { type: "clientError", clientErrorCode: "forbidden", descriptionHtml: "Forbidden" },
  404: { type: "clientError", clientErrorCode: "notFound", descriptionHtml: "Not Found" },
  405: { type: "clientError", clientErrorCode: "methodNotAllowed", descriptionHtml: "Method Not Allowed" },
  406: { type: "clientError", clientErrorCode: "notAcceptable", descriptionHtml: "Not Acceptable" },
  409: { type: "clientError", clientErrorCode: "conflict", descriptionHtml: "Conflict" },
  410: { type: "clientError", clientErrorCode: "gone", descriptionHtml: "Gone" },
  412: { type: "preconditionFailed" },
  413: { type: "clientError", clientErrorCode: "requestEntityTooLarge", descriptionHtml: "Request Entity Too Large" },
  414: { type: "clientError", clientErrorCode: "requestUriTooLong", descriptionHtml: "Request-URI Too Long" },
  415: { type: "clientError", clientErrorCode: "unsupportedMediaType", descriptionHtml: "Unsupported Media Type" },
  418: { type: "clientError", clientErrorCode: "imATeapot", descriptionHtml: "I'm a teapot" },
  500: { type: "serverError" },
  501: { type: "serverError" },
  502: { type: "serverError" },
  503: { type: "serverError" },
  504: { type: "serverError" },
  505: { type: "serverError" },
};
