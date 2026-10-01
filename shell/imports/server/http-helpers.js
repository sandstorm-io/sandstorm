import { fetchWithTimeout, withSsrfSafeFetch } from "/imports/server/networking";

async function toLegacyResponse(response, binary) {
  const headers = Object.fromEntries(response.headers.entries());
  const content = binary
    ? Buffer.from(await response.arrayBuffer())
    : await response.text();
  let data;

  if (!binary && content) {
    try {
      data = JSON.parse(content);
    } catch (err) {
      // Meteor's HTTP package left data undefined when a response was not JSON.
    }
  }

  const result = {
    content,
    data,
    headers,
    statusCode: response.status,
  };

  if (!response.ok) {
    const error = new Error("HTTP request failed with status " + response.status);
    error.response = result;
    throw error;
  }

  return result;
}

async function httpCallAsync(method, url, options = {}) {
  const headers = new Headers(options.headers);
  let body = options.content;
  if (options.data !== undefined) {
    body = JSON.stringify(options.data);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }

  const init = {
    body,
    headers,
    method,
    timeoutMs: options.timeout,
  };
  const binary = options.binary || options.npmRequestOptions?.encoding === null;
  const consume = response => toLegacyResponse(response, binary);

  if (options.ssrfSafeDb) {
    return await withSsrfSafeFetch(options.ssrfSafeDb, url, init, consume);
  }

  const response = await fetchWithTimeout(url, init, options.timeout);
  return await consume(response);
}

export { httpCallAsync };
