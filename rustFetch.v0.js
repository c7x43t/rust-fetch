// index.js
const path = require('path');
const { createClient, fetch: rawFetch } = require(path.join(__dirname, './index.node'));
const client = createClient();

/**
 * A 1:1 drop‑in for Node’s fetch():
 *  - input = URL string or Request
 *  - init  = undefined or plain RequestInit
 */
async function rustFetch(input, init) {
    // 1) Normalize URL and start building our plain-init
    let url = typeof input === 'string'
        ? input
        : input.url;

    // Build a plain‑JS object { method, headers, body } with only string values
    const opts = {};

    // If input was a Request, seed opts from it:
    if (typeof input !== 'string') {
        opts.method = input.method;
        opts.headers = {};
        input.headers.forEach((v, k) => { opts.headers[k] = v; });
        if (input.bodyUsed) {
            // consume its body so we can re‑send it
            opts.body = await input.text();
        }
    }

    // 2) Merge in the user‑supplied init (if any), coercing everything to strings:
    if (init) {
        if (init.method) {
            opts.method = String(init.method);
        }
        if (init.headers) {
            opts.headers = Object.assign({}, opts.headers,
                // normalize Headers instance or plain object
                init.headers instanceof Headers
                    ? Object.fromEntries(init.headers)
                    : init.headers
            );
        }
        if (init.body != null) {
            // assume string or Buffer
            opts.body = typeof init.body === 'string'
                ? init.body
                : init.body.toString();
        }
    }

    // 3) Call into Rust **only** with (client, url, opts) when opts is non‑empty
    const args = [client, url];
    if (opts.method || opts.headers || opts.body !== undefined) {
        args.push(opts);
    }

    const {
        status,
        statusText,
        headers: headerObj,
        body,
        url: finalUrl,
        redirected,
        type
    } = await rawFetch(...args);

    // 4) Wrap that in a real Fetch Response
    const headers = new Headers(headerObj);
    const res = new Response(body, { status, statusText, headers });

    Object.defineProperty(res, 'url', { value: finalUrl });
    Object.defineProperty(res, 'redirected', { value: redirected });
    Object.defineProperty(res, 'type', { value: type });

    return res;
}
/**
 * Raw response object from Rust + auto‑parsed `data` field.
 * @returns {Promise<{
*   status: number,
*   statusText: string,
*   headers: Record<string,string>,
*   body: string,
*   url: string,
*   redirected: boolean,
*   type: string,
*   data: any
* }>}
*/
async function rustFetchRaw(input, init = {}) {
    // 1) normalize URL
    const url = typeof input === 'string' ? input : input.url;

    // 2) build opts exactly as rustFetch does
    const opts = {};
    if (typeof input !== 'string') {
        opts.method = input.method;
        opts.headers = {};
        input.headers.forEach((v, k) => { opts.headers[k] = v; });
        if (input.bodyUsed) opts.body = await input.text();
    }
    if (init.method) opts.method = String(init.method);
    if (init.headers) opts.headers = Object.assign(
        {},
        opts.headers,
        init.headers instanceof Headers
            ? Object.fromEntries(init.headers)
            : init.headers
    );
    if (init.body != null) {
        opts.body = typeof init.body === 'string'
            ? init.body
            : init.body.toString();
    }

    // 3) call into Rust, forwarding opts only if non‑empty
    const args = [client, url];
    if (opts.method || opts.headers || opts.body !== undefined) args.push(opts);
    const raw = await rawFetch(...args);

    // 4) auto‑parse based on content-type
    const ct = raw.headers['content-type'] || '';
    const data = ct.includes('application/json')
        ? JSON.parse(raw.body)
        : raw.body;

    // 5) return everything, plus `.data`
    return { ...raw, data };
}

module.exports = { rustFetch, rustFetchRaw };