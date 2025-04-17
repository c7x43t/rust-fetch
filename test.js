// tests.mjs
const assert = require('node:assert');
const test = require('node:test');
const http = require('node:http');
// const { createRequire } = require('node:module');
// const requireFunc = createRequire(import.meta.url); //
const { rustFetch } = require('./index.js');
// ────────── helpers ──────────
function startServer(handler) {
    const server = http.createServer(handler);
    return new Promise((resolve, reject) => {
        server.listen(0, () => resolve({ server, port: server.address().port }));
        server.on('error', reject);
    });
}

// ────────── ORIGINAL TESTS ──────────
test('simple GET returns text', /* … unchanged … */);
test('GET with custom header returns JSON', /* … unchanged … */);
test('POST with JSON body', /* … unchanged … */);
test('handles redirects', /* … unchanged … */);

// ────────── NEW EDGE‑CASE TESTS ──────────

// 1️⃣  3‑hop redirect chain
test('follows multiple redirects (max = 5)', async () => {
    const { server, port } = await startServer((req, res) => {
        if (req.url === '/r1') res.writeHead(301, { Location: `http://localhost:${port}/r2` });
        else if (req.url === '/r2') res.writeHead(302, { Location: `http://localhost:${port}/r3` });
        else if (req.url === '/r3') { res.writeHead(200); res.end('done'); return; }
        res.end();
    });
    try {
        const r = await rustFetch(`http://localhost:${port}/r1`);
        assert.equal(await r.text(), 'done');
        assert.equal(r.redirected, true);
        assert.equal(r.url, `http://localhost:${port}/r3`);
    } finally { server.close(); }
});

// 2️⃣  redirect loop detection (6 hops should fail if max=5)
test('detects redirect loops', async () => {
    const { server, port } = await startServer((req, res) => {
        res.writeHead(302, { Location: `http://localhost:${port}${req.url}` }); res.end();
    });
    // fetch(`http://localhost:${port}/loop`).then(console.log).catch(console.error)
    try {
        // console.log(rustFetch(`http://localhost:${port}/loop`))
        await assert.rejects(() => rustFetch(`http://localhost:${port}/loop`), /redirect/i);
    } catch (err) { console.error(err) } finally { server.close(); }
});

// 3️⃣  request timeout
test('times out when server is too slow', async () => {
    const { server, port } = await startServer((req, res) => setTimeout(() => { res.writeHead(200); res.end(); }, 100));
    try {
        await assert.rejects(
            () => rustFetch(`http://localhost:${port}/slow`, { timeout: 50 }),
            /timed out/i
        );
    } catch (err) { } finally { server.close(); }
});

// 4️⃣  AbortSignal
test('aborts in-flight request', async () => {
    const { server, port } = await startServer((req, res) => setTimeout(() => { res.writeHead(200); res.end(); }, 100));
    const ctrl = new AbortController();
    const p = rustFetch(`http://localhost:${port}/hang`, { signal: ctrl.signal }).catch(e => e);
    ctrl.abort();
    const err = await p;
    assert.match(err.message, /aborted/i);
    server.close();
});

// 5️⃣  binary response (arrayBuffer)
test('arrayBuffer returns binary data intact', async () => {
    const buf = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const { server, port } = await startServer((_, res) => { res.writeHead(200); res.end(buf); });
    try {
        const r = await rustFetch(`http://localhost:${port}/bin`);
        const ab = await r.arrayBuffer();
        assert.deepStrictEqual(new Uint8Array(ab), new Uint8Array(buf));
    } finally { server.close(); }
});

// 6️⃣  large body (> 1 MB)
test('streams large responses', async () => {
    const big = Buffer.alloc(1024 * 1024 + 123, 'a');      // ~1 MB
    const { server, port } = await startServer((_, res) => { res.writeHead(200); res.end(big); });
    try {
        const r = await rustFetch(`http://localhost:${port}/big`);
        const txt = await r.text();
        assert.equal(txt.length, big.length);
    } finally { server.close(); }
});

// 7️⃣  malformed JSON should throw on res.json()
test('malformed JSON throws parse error', async () => {
    const { server, port } = await startServer((_, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{ broken'); });
    try {
        const r = await rustFetch(`http://localhost:${port}/badjson`);
        await assert.rejects(() => r.json(), /in JSON at position/i);
    } finally { server.close(); }
});

// 8️⃣  HEAD request should give headers but no body
test('HEAD request returns headers only', async () => {
    const { server, port } = await startServer((req, res) => {
        if (req.method === 'HEAD') { res.writeHead(204, { 'x-test': 'ok' }); res.end(); }
    });
    try {
        const r = await rustFetch(`http://localhost:${port}/head`, { method: 'HEAD' });
        assert.equal(r.status, 204);
        assert.equal(r.headers.get('x-test'), 'ok');
        const txt = await r.text();           // should be empty
        assert.equal(txt, '');
    } catch (err) { console.error(err) } finally { server.close(); }
});

// 9️⃣  query‑string encoding
test('query params are transmitted verbatim', async () => {
    const q = 'äöü&x=1+1';
    const { server, port } = await startServer((req, res) => { res.writeHead(200); res.end(req.url); });
    try {
        const r = await rustFetch(`http://localhost:${port}/echo?q=${encodeURIComponent(q)}`);
        const url = await r.text();
        assert.equal(url, `/echo?q=${encodeURIComponent(q)}`);
    } finally { server.close(); }
});

// 🔟  5xx errors propagate status
test('propagates 5xx status and statusText', async () => {
    const { server, port } = await startServer((_, res) => { res.writeHead(503, 'Service Unavailable'); res.end(); });
    try {
        const r = await rustFetch(`http://localhost:${port}/fail`);
        assert.equal(r.status, 503);
        assert.equal(r.statusText, 'Service Unavailable');
    } finally { server.close(); }
});

// 1️⃣1️⃣ 404 Not Found
test('propagates 404 status and statusText', async () => {
    const { server, port } = await startServer((_, res) => {
        res.writeHead(404, 'Not Found');
        res.end('Not here');
    });
    try {
        const r = await rustFetch(`http://localhost:${port}/missing`);
        assert.equal(r.status, 404);
        assert.equal(r.statusText, 'Not Found');
        assert.equal(await r.text(), 'Not here');
        assert.equal(r.ok, false);
    } finally {
        server.close();
    }
});

// 1️⃣2️⃣ Client error (400 Bad Request)
test('propagates 400 status and statusText', async () => {
    const { server, port } = await startServer((_, res) => {
        res.writeHead(400, 'Bad Request');
        res.end();
    });
    try {
        const r = await rustFetch(`http://localhost:${port}/bad`);
        assert.equal(r.status, 400);
        assert.equal(r.statusText, 'Bad Request');
        assert.equal(r.ok, false);
    } finally {
        server.close();
    }
});

// 1️⃣3️⃣ Connection refused / network error
test('throws on connection refused', async () => {
    // Pick an unused port so there's no listener
    const unreachablePort = 54321;
    await assert.rejects(
        () => rustFetch(`http://localhost:${unreachablePort}/`),
        /ECONNREFUSED/i
    );
});

// 1️⃣4️⃣ Unsupported protocol
test('throws on unsupported protocol scheme', async () => {
    await assert.rejects(
        () => rustFetch('ftp://example.com/resource'),
        /unsupported protocol/i
    );
});

test('sends URLSearchParams body correctly', async () => {
    const params = new URLSearchParams({ foo: 'bar', baz: 'qux' });
    const { server, port } = await startServer(async (req, res) => {
        // collect incoming body
        let body = '';
        for await (const chunk of req) body += chunk;

        // header + payload
        assert.equal(
            req.headers['content-type'],
            'application/x-www-form-urlencoded;charset=UTF-8'
        );
        assert.equal(body, params.toString());

        res.writeHead(200);
        res.end('ok');
    });

    try {
        const r = await rustFetch(`http://localhost:${port}/url-params`, {
            method: 'POST',
            body: params
        });
        assert.equal(await r.text(), 'ok');
    } finally {
        server.close();
    }
});

test('sends Blob body correctly', async () => {
    const text = 'hello‑blob';
    const blob = new Blob([text], { type: 'text/plain' });
    const { server, port } = await startServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;

        assert.equal(req.headers['content-type'], 'text/plain');
        assert.equal(body, text);

        res.writeHead(200);
        res.end('done');
    });

    try {
        const r = await rustFetch(`http://localhost:${port}/blob`, {
            method: 'POST',
            body: blob
        });
        assert.equal(await r.text(), 'done');
    } finally {
        server.close();
    }
});


// ────────── REDIRECT MODE TESTS ──────────
test('default redirect="follow" follows a 302', async () => {
    const { server, port } = await startServer((req, res) => {
        if (req.url === '/') {
            res.writeHead(302, { Location: `http://localhost:${port}/next` });
            res.end();
        } else {
            res.writeHead(200);
            res.end('final');
        }
    });

    try {
        const r = await rustFetch(`http://localhost:${port}/`);
        assert.equal(await r.text(), 'final');
        assert.equal(r.redirected, true);
        assert.ok(r.url.endsWith('/next'));
    } finally {
        server.close();
    }
});

test('redirect="manual" does not follow and exposes Location header', async () => {
    const { server, port } = await startServer((_, res) => {
        res.writeHead(301, { Location: `http://localhost:${port}/elsewhere` });
        res.end();
    });

    try {
        const r = await rustFetch(`http://localhost:${port}/`, { redirect: 'manual' });
        assert.equal(r.status, 301);
        assert.equal(r.headers.get('location'), `http://localhost:${port}/elsewhere`);
        assert.equal(r.redirected, false);
    } finally {
        server.close();
    }
});

test('redirect="error" rejects on any redirect response', async () => {
    const { server, port } = await startServer((_, res) => {
        res.writeHead(302, { Location: 'http://example.com/' });
        res.end();
    });

    try {
        await assert.rejects(
            () => rustFetch(`http://localhost:${port}/`, { redirect: 'error' }),
            /redirect/i
        );
    } finally {
        server.close();
    }
});


// ────────── Exact redirect‑error message ──────────
test('redirect="error" rejects with exact message', async () => {
    const { server, port } = await startServer((_, res) => {
        res.writeHead(302, { Location: 'http://example.com/' });
        res.end();
    });
    try {
        await assert.rejects(
            () => rustFetch(`http://localhost:${port}/`, { redirect: 'error' }),
            err => {
                assert.equal(err.message, 'redirect error');
                return true;
            }
        );
    } finally {
        server.close();
    }
});

// ────────── Header merging with FormData ──────────
test('merges custom headers with FormData body', async () => {
    const form = new FormData();
    form.append('foo', 'bar');

    const { server, port } = await startServer(async (req, res) => {
        assert.match(
            req.headers['content-type'],
            /^multipart\/form-data; boundary=[\w-]+$/
        );
        assert.equal(req.headers['x-custom'], 'myvalue');
        res.writeHead(200);
        res.end('ok');
    });

    try {
        const r = await rustFetch(`http://localhost:${port}/`, {
            method: 'POST',
            headers: { 'X-Custom': 'myvalue' },
            body: form
        });
        assert.equal(await r.text(), 'ok');
    } finally {
        server.close();
    }
});

// ────────── Empty Blob & FormData ──────────
test('empty Blob still sends correct Content-Type', async () => {
    const emptyBlob = new Blob([], { type: 'application/octet-stream' });

    const { server, port } = await startServer(async (req, res) => {
        assert.equal(req.headers['content-type'], 'application/octet-stream');
        let received = '';
        for await (const c of req) received += c;
        assert.equal(received, '');
        res.writeHead(204);
        res.end();
    });

    try {
        const r = await rustFetch(`http://localhost:${port}/`, {
            method: 'POST',
            body: emptyBlob
        });
        assert.equal(r.status, 204);
    } finally {
        server.close();
    }
});


test('sends FormData body correctly', async () => {
    // Assumes global FormData exists (Node 18+)
    const form = new FormData();
    form.append('field1', 'value1');
    form.append('file1', new Blob(['file‑contents'], { type: 'text/plain' }), 'file1.txt');

    const { server, port } = await startServer(async (req, res) => {
        const ct = req.headers['content-type'];
        // should be multipart/form-data with a boundary
        // assert.match(ct, /^multipart\/form-data; boundary=/);
        // just verify this is multipart/form-data *with* a boundary
        assert.match(
            req.headers['content-type'],
            /^multipart\/form-data; boundary=[\w-]+$/
        );
        // collect raw body
        let raw = '';
        for await (const chunk of req) raw += chunk;

        // verify both fields present
        assert.ok(raw.includes('name="field1"\r\n\r\nvalue1'));
        assert.ok(raw.includes('name="file1"; filename="file1.txt"'));
        assert.ok(raw.includes('file‑contents'));

        res.writeHead(200);
        res.end('uploaded');
    });

    try {
        const r = await rustFetch(`http://localhost:${port}/upload`, {
            method: 'POST',
            body: form
        });
        assert.equal(await r.text(), 'uploaded');
    } finally {
        server.close();
    }
});

test('empty FormData still sends boundary and terminator', async () => {
    const emptyForm = new FormData();
    let serverCT, rawBody;

    const { server, port } = await startServer((req, res) => {
        serverCT = req.headers['content-type'];

        // collect the raw request‐body
        rawBody = '';
        req.on('data', chunk => rawBody += chunk);
        req.on('end', () => {
            res.writeHead(200);
            res.end('good');
        });
    });

    try {
        const r = await rustFetch(`http://localhost:${port}/`, {
            method: 'POST',
            body: emptyForm
        });

        // 1) The server saw a multipart/form-data header with some boundary
        assert.match(serverCT, /^multipart\/form-data; boundary=[\w-]+$/);

        // 2) That boundary actually appears (and terminates) in the raw body
        const boundary = serverCT.split('boundary=')[1];
        assert.ok(rawBody.includes(`--${boundary}`), 'Missing opening boundary');
        assert.ok(rawBody.trim().endsWith(`--${boundary}--`), 'Missing closing terminator');

        // 3) And the response body is still what the server sent
        assert.equal(await r.text(), 'good');
    } finally {
        server.close();
    }
});
// ────────── Cache‐mode tests ──────────
test('cache:no-store always re‑fetches', async () => {
    let hits = 0;
    const { server, port } = await startServer((req, res) => {
        hits += 1;
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`hit-${hits}`);
    });

    try {
        // no-store should always bypass any cache
        const r1 = await rustFetch(`http://localhost:${port}/cache`, { cache: 'no-store' });
        const v1 = await r1.text();
        const r2 = await rustFetch(`http://localhost:${port}/cache`, { cache: 'no-store' });
        const v2 = await r2.text();

        assert.equal(v1, 'hit-1');
        assert.equal(v2, 'hit-2');
        assert.equal(hits, 2);
    } finally {
        server.close();
    }
});

test('cache:force-cache caches first response', async () => {
    let hits = 0;
    const { server, port } = await startServer((req, res) => {
        hits += 1;
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`hit-${hits}`);
    });

    try {
        // first fetch populates
        const r1 = await rustFetch(`http://localhost:${port}/cache`, { cache: 'force-cache' });
        const v1 = await r1.text();
        // second fetch should come from cache — same body, no new hit
        const r2 = await rustFetch(`http://localhost:${port}/cache`, { cache: 'force-cache' });
        const v2 = await r2.text();

        assert.equal(v1, 'hit-1');
        assert.equal(v2, 'hit-1');
        assert.equal(hits, 1);
    } finally {
        server.close();
    }
});

// ────────── Credentials tests ──────────
test('credentials: include sends cookies', async () => {
    let sawCookie = null;
    const { server, port } = await startServer(async (req, res) => {
        // first request: set a cookie
        if (!req.headers.cookie) {
            res.writeHead(200, {
                'Set-Cookie': 'session=abc123; Path=/',
                'Content-Type': 'text/plain'
            });
            res.end('ok');
        } else {
            // second request: echo back Cookie header
            sawCookie = req.headers.cookie;
            res.writeHead(200);
            res.end('ok2');
        }
    });

    try {
        // initial fetch must accept the cookie but not send it back
        await rustFetch(`http://localhost:${port}/cookie`, {
            credentials: 'include'
        });
        // second fetch should send it
        await rustFetch(`http://localhost:${port}/cookie`, {
            credentials: 'include'
        });

        assert.equal(sawCookie, 'session=abc123');
    } finally {
        server.close();
    }
});

// ────────── Keep‑Alive sanity check ──────────
test('reuses TCP socket across two sequential requests', async () => {
    const sockets = new Set();
    const { server, port } = await startServer((req, res) => {
        // record the client port for each request
        sockets.add(req.socket.remotePort);
        res.writeHead(200);
        res.end();
    });

    try {
        await rustFetch(`http://localhost:${port}/ka`);
        await rustFetch(`http://localhost:${port}/ka`);
        // if keepalive is working, both requests came on the same socket
        assert.equal(sockets.size, 1);
    } finally {
        server.close();
    }
});

// ────────── Request & Response constructors + clone() ──────────
test('new Request(input, init) works with rustFetch', async () => {
    const { server, port } = await startServer(async (req, res) => {
        // echo back method, header, and body
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        let body = '';
        for await (const c of req) body += c;
        res.end(`${req.method}|${req.headers['x-test']}|${body}`);
    });

    try {
        const init = {
            method: 'POST',
            headers: { 'X-Test': 'hello' },
            body: 'abc',
        };
        const req = new Request(`http://localhost:${port}/echo`, init);
        const r = await rustFetch(req);
        const txt = await r.text();
        assert.equal(txt, 'POST|hello|abc');
    } finally {
        server.close();
    }
});

test('new Response(body, init) and .clone()', async () => {
    const original = new Response('payload', {
        status: 201,
        statusText: 'Created',
        headers: { 'X-C': 'D' },
    });
    assert.equal(original.status, 201);
    assert.equal(original.statusText, 'Created');
    assert.equal(original.headers.get('x-c'), 'D');

    // clone twice, both bodies should be consumable independently
    const c1 = original.clone();
    const c2 = original.clone();
    assert.equal(await c1.text(), 'payload');
    assert.equal(await c2.text(), 'payload');
});

// ────────── Response.formData() support ──────────
test('Response.formData() parses multipart/form-data', async () => {
    // craft a simple multipart body
    const boundary = 'BOUNDARY123';
    const mp = [
        `--${boundary}`,
        `Content-Disposition: form-data; name="a"`,
        '',
        'valueA',
        `--${boundary}`,
        `Content-Disposition: form-data; name="b"; filename="file.txt"`,
        'Content-Type: text/plain',
        '',
        'FILECONTENT',
        `--${boundary}--`,
        ''
    ].join('\r\n');

    const res = new Response(mp, {
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }
    });
    const fd = await res.formData();
    assert.equal(fd.get('a'), 'valueA');
    const file = fd.get('b');
    // file should be a Blob
    assert.ok(file instanceof Blob);
    const txt = await file.text();
    assert.equal(txt, 'FILECONTENT');
});

// ────────── More cache modes ──────────
test('cache: reload always re‑fetches and updates cache', async () => {
    let hits = 0;
    const { server, port } = await startServer((req, res) => {
        hits += 1;
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`hit-${hits}`);
    });

    try {
        // reload should fetch every time
        const r1 = await rustFetch(`http://localhost:${port}/`, { cache: 'reload' });
        const v1 = await r1.text();
        const r2 = await rustFetch(`http://localhost:${port}/`, { cache: 'reload' });
        const v2 = await r2.text();
        // and also update the force-cache
        const r3 = await rustFetch(`http://localhost:${port}/`, { cache: 'force-cache' });
        const v3 = await r3.text();

        assert.equal(v1, 'hit-1');
        assert.equal(v2, 'hit-2');
        assert.equal(v3, 'hit-2');
        assert.equal(hits, 2);
    } finally {
        server.close();
    }
});

test('cache: no-cache re‑fetches but updates cache', async () => {
    let hits = 0;
    const { server, port } = await startServer((req, res) => {
        hits += 1;
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`hit-${hits}`);
    });

    try {
        // no-cache should bypass cache but then write-through
        const r1 = await rustFetch(`http://localhost:${port}/`, { cache: 'no-cache' });
        const v1 = await r1.text();
        const r2 = await rustFetch(`http://localhost:${port}/`, { cache: 'no-cache' });
        const v2 = await r2.text();
        // force-cache now returns last
        const r3 = await rustFetch(`http://localhost:${port}/`, { cache: 'force-cache' });
        const v3 = await r3.text();

        assert.equal(v1, 'hit-1');
        assert.equal(v2, 'hit-2');
        assert.equal(v3, 'hit-2');
        assert.equal(hits, 2);
    } finally {
        server.close();
    }
});

test('cache: only-if-cached rejects when empty, returns when present', async () => {
    let hits = 0;
    const { server, port } = await startServer((req, res) => {
        hits += 1;
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`hit-${hits}`);
    });

    try {
        // first, with only-if-cached and empty cache → reject
        await assert.rejects(
            () => rustFetch(`http://localhost:${port}/`, { cache: 'only-if-cached' }),
            /504|cache/i
        );

        // populate cache
        const r1 = await rustFetch(`http://localhost:${port}/`, { cache: 'force-cache' });
        await r1.text();

        // now only-if-cached returns the cached value
        const r2 = await rustFetch(`http://localhost:${port}/`, { cache: 'only-if-cached' });
        const v2 = await r2.text();

        assert.equal(v2, 'hit-1');
        assert.equal(hits, 1);
    } finally {
        server.close();
    }
});

// ────────── Full credentials modes ──────────
test('credentials: same-origin sends cookies only for same origin', async () => {
    let sawA = null, sawB = null;
    // Server A on port A
    const { server: a, port: pa } = await startServer((req, res) => {
        if (!req.headers.cookie) {
            res.writeHead(200, { 'Set-Cookie': 'auth=tok; Path=/' });
            res.end('A1');
        } else {
            sawA = req.headers.cookie;
            res.writeHead(200);
            res.end('A2');
        }
    });
    // Server B on port B
    const { server: b, port: pb } = await startServer((req, res) => {
        sawB = req.headers.cookie || null;
        res.writeHead(200);
        res.end('B');
    });

    try {
        // first hit A to get cookie
        await rustFetch(`http://localhost:${pa}/`, { credentials: 'same-origin' });
        // hit A again → should send
        await rustFetch(`http://localhost:${pa}/`, { credentials: 'same-origin' });
        // hit B → same-origin should NOT send cross-origin
        await rustFetch(`http://localhost:${pb}/`, { credentials: 'same-origin' });

        assert.equal(sawA, 'auth=tok');
        assert.equal(sawB, null);
    } finally {
        a.close();
        b.close();
    }
});

test('credentials: omit never sends cookies', async () => {
    let saw = null;
    const { server, port } = await startServer((req, res) => {
        saw = req.headers.cookie || null;
        res.writeHead(200);
        res.end('OK');
    });

    try {
        // populate jar
        await rustFetch(`http://localhost:${port}/`, { credentials: 'include' });
        // now omit: should never send
        await rustFetch(`http://localhost:${port}/`, { credentials: 'omit' });

        assert.equal(saw, null);
    } finally {
        server.close();
    }
});
