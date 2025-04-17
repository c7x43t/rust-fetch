
/* eslint-disable no-use-before-define */
const path = require('path');
const {
    createClient,
    fetch: rawFetch,
} = require(path.join(__dirname, './index.node'));

const client = createClient();
const _cache = new Map();
const _jar = new Map();

async function rustFetch(input, init) {
    init ??= {};
    const {
        signal: extSignal,
        timeout,
        redirect = 'follow',
        cache,
        credentials,
        ...cleanInit
    } = init;
    if (input instanceof Request) {
        const req = input;
        // pull method & headers from the Request
        cleanInit.method = cleanInit.method || req.method;
        cleanInit.headers = cleanInit.headers || req.headers;
        // if it has a body, read it into cleanInit.body
        // if (req.bodyUsed && cleanInit.body == null) {
        if (cleanInit.body == null && typeof req.text === 'function') {
            cleanInit.body = await req.text();
        }
        // now treat input as the URL string
        input = req.url;
    }
    // Prepare URL and origin
    const urlStr = typeof input === 'string' ? input : input.url;
    let parsed;
    try {
        parsed = new URL(urlStr);
    } catch {
        return Promise.reject(new Error(`Invalid URL: ${urlStr} `));
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        return Promise.reject(new Error('unsupported protocol'));
    }
    const origin = parsed.origin;
    const cacheKey = urlStr;
    // ONLY‑IF‑CACHED: if nothing in cache, reject immediately
    if (cache === 'only-if-cached') {
        if (_cache.has(cacheKey)) {
            const { status, statusText, headersObj, bodyBuffer } = _cache.get(cacheKey);
            return Promise.resolve(
                new Response(bodyBuffer.slice(0), { status, statusText, headers: headersObj })
            );
        } else {
            return Promise.reject(new Error('cache miss'));
        }
    }
    // CACHE: force-cache / no-store
    if (cache === 'force-cache' && _cache.has(cacheKey)) {
        const { status, statusText, headersObj, bodyBuffer } = _cache.get(cacheKey);
        return Promise.resolve(
            new Response(bodyBuffer.slice(0), { status, statusText, headers: headersObj })
        );
    }

    // CREDENTIALS: include
    if (credentials === 'include' || credentials === 'same-origin') {
        const saved = _jar.get(origin);
        if (saved) {
            cleanInit.headers = cleanInit.headers || {};
            cleanInit.headers['cookie'] = saved;
        }
    }

    // Redirect validation
    if (!['follow', 'manual', 'error'].includes(redirect)) {
        return Promise.reject(new Error(`Invalid redirect option: ${redirect} `));
    }
    if (extSignal?.aborted) {
        return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }

    // Fast-path for URLSearchParams, Blob, FormData, or non-follow redirect
    const isUrlParams = typeof URLSearchParams !== 'undefined' && cleanInit.body instanceof URLSearchParams;
    const isBlob = typeof Blob !== 'undefined' && cleanInit.body instanceof Blob;
    const isFormData = typeof FormData !== 'undefined' && cleanInit.body instanceof FormData;
    if (isUrlParams || isBlob || isFormData || redirect !== 'follow') {
        const opts = { redirect, signal: extSignal, ...cleanInit };
        return globalThis.fetch(input, opts)
            .then(res => {
                // Store cookies
                if (credentials === 'include' || credentials === 'same-origin') {
                    const sc = res.headers.get('set-cookie');
                    if (sc) {
                        // only keep the name=value before the first semicolon
                        const [pair] = sc.split(/;\s*/);
                        _jar.set(origin, pair);
                    }
                }
                // Cache response
                if (cache === 'force-cache' || cache === 'reload' || cache === 'no-cache') {
                    res.clone().arrayBuffer().then(buf => {
                        const headersObj = {};
                        for (const [k, v] of res.headers) headersObj[k] = v;
                        _cache.set(cacheKey, {
                            status: res.status,
                            statusText: res.statusText,
                            headersObj,
                            bodyBuffer: Buffer.from(buf),
                        });
                    }).catch(() => { });
                }
                return res;
            })
            .catch(err => {
                if (redirect === 'error') throw new Error('redirect error');
                throw err;
            });
    }

    // Rust path for follow redirects and other bodies
    const base = (async () => {
        // Build request options
        let opts = null;
        if (cleanInit.method || cleanInit.headers || cleanInit.body != null) {
            opts = {};
            if (cleanInit.method) opts.method = String(cleanInit.method);
            if (cleanInit.headers) {
                opts.headers = {};
                if (cleanInit.headers instanceof Headers) {
                    cleanInit.headers.forEach((v, k) => opts.headers[k] = v);
                } else {
                    Object.assign(opts.headers, cleanInit.headers);
                }
            }
            if (cleanInit.body != null) {
                opts.body = typeof cleanInit.body === 'string'
                    ? cleanInit.body
                    : String(cleanInit.body);
            }
        }
        opts ||= {};
        opts.redirect = 'follow';

        let resObj;
        try {
            resObj = await rawFetch(client, urlStr, opts);
        } catch (err) {
            if (/error sending request/i.test(err.message)) {
                const e = new Error('ECONNREFUSED'); e.stack = err.stack; throw e;
            }
            throw err;
        }

        const { status, statusText, headers, body, url: finalUrl, redirected, type } = resObj;
        const noBody = [204, 205, 304].includes(status);
        const res = new Response(noBody ? null : body, { status, statusText, headers });
        Object.defineProperties(res, {
            url: { value: finalUrl },
            redirected: { value: redirected },
            type: { value: type },
        });

        // Cache store
        if (cache === 'force-cache' || cache === 'reload' || cache === 'no-cache') {
            const buf = Buffer.from(await res.clone().arrayBuffer());
            const headersObj = {};
            for (const [k, v] of res.headers) headersObj[k] = v;
            _cache.set(cacheKey, {
                status: res.status,
                statusText: res.statusText,
                headersObj,
                bodyBuffer: buf,
            });
        }

        // Cookie jar store
        if (credentials === 'include' || credentials === 'same-origin') {
            const sc = res.headers.get('set-cookie');
            if (sc) {
                // only keep the name=value before the first semicolon
                const [pair] = sc.split(/;\s*/);
                _jar.set(origin, pair);
            }
        }

        return res;
    })();

    // Abort/timeout race
    if (!extSignal && timeout == null) return base;
    return new Promise((resolve, reject) => {
        let done = false, timer;
        const settle = fn => v => { if (done) return; done = true; if (timer) clearTimeout(timer); extSignal?.removeEventListener('abort', onAbort); fn(v); };
        const onAbort = () => settle(reject)(new DOMException('Aborted', 'AbortError'));
        extSignal?.addEventListener('abort', onAbort, { once: true });
        if (timeout != null) {
            timer = setTimeout(() => settle(reject)(new Error(`Request timed out after ${timeout} ms`)), Number(timeout));
        }
        base.then(settle(resolve), settle(reject));
    });
}

module.exports = { rustFetch };

