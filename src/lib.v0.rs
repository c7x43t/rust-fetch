use neon::prelude::*;
use once_cell::sync::Lazy;
use reqwest::Client;
use smol_str::SmolStr;
use std::cell::RefCell;
use std::time::Duration;
use tokio::runtime::Runtime;
// ─── 1) Singletons ────────────────────────────────────────────────────────────
thread_local! {
    /// One buffer per OS thread; capacity tuned to your typical header‐count.
    static HEADER_SCRATCH: RefCell<Vec<(SmolStr, SmolStr)>> =
        RefCell::new(Vec::with_capacity(16));
}

// Build a multi‑threaded Tokio runtime once
static TOKIO_RT: Lazy<Runtime> = Lazy::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        // .worker_threads(num_cpus::get())
        .worker_threads(1)
        .enable_all()
        .build()
        .expect("failed to build tokio runtime")
});

// Build a shared reqwest::Client once (rustls + compression)
static HTTP_CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        // .pool_max_idle_per_host() // tweak as needed
        .pool_idle_timeout(Duration::from_secs(90))
        .pool_max_idle_per_host(10)
        .build()
        .expect("failed to build reqwest client")
});

// Marker type: no interior data, all instances share the above singletons
pub struct HttpClient;

// Neon’s JsBox types must implement Finalize
impl Finalize for HttpClient {}

// ─── 2) Neon exports ─────────────────────────────────────────────────────────

// JS: const client = createClient();
fn create_client(mut cx: FunctionContext) -> JsResult<JsBox<HttpClient>> {
    Ok(cx.boxed(HttpClient))
}

// JS: fetch(client, "https://...") -> Promise<string>
fn fetch(mut cx: FunctionContext) -> JsResult<JsPromise> {
    // 0th arg: the boxed HttpClient (not used internally, but enforces usage)
    let _client = cx.argument::<JsBox<HttpClient>>(0)?;
    let url = cx.argument::<JsString>(1)?.value(&mut cx);

    // 2nd arg may be an init object
    let mut headers_vec = Vec::new();
    let mut body_opt = None;
    // default‑only‑allocate GET
    let method = if let Some(init_val) = cx.argument_opt(2) {
        let obj = init_val
            .downcast::<JsObject, _>(&mut cx)
            .or_throw(&mut cx)?;

        // === method (only allocates if overridden) ===
        let method_str = obj
            .get_value(&mut cx, "method") // JsResult<Handle<JsValue>>
            .ok() // Option<Handle<JsValue>>
            .and_then(|v| v.downcast::<JsString, _>(&mut cx).ok())
            .map(|js_str| js_str.value(&mut cx))
            .unwrap_or_else(|| "GET".to_string());

        // === headers ===
        if let Some(js_hdrs) = obj.get_opt::<JsObject, _, _>(&mut cx, "headers")? {
            for key in js_hdrs.get_own_property_names(&mut cx)?.to_vec(&mut cx)? {
                let k = key
                    .downcast::<JsString, _>(&mut cx)
                    .or_throw(&mut cx)?
                    .value(&mut cx);
                let v = js_hdrs
                    .get_value(&mut cx, &*k)?
                    .downcast::<JsString, _>(&mut cx)
                    .or_throw(&mut cx)?
                    .value(&mut cx);
                headers_vec.push((k, v));
            }
        }

        // === body ===
        // if let Ok(js_body) = obj.get_value(&mut cx, "body") {
        //     let s = js_body
        //         .downcast::<JsString, _>(&mut cx)
        //         .or_throw(&mut cx)?
        //         .value(&mut cx);
        //     body_opt = Some(s);
        // }

        if let Some(js_body) = obj.get_opt::<JsString, _, _>(&mut cx, "body")? {
            // get_opt only gives you a JsString if the property exists *and* is a string
            body_opt = Some(js_body.value(&mut cx));
        }
        method_str
    } else {
        "GET".to_string()
    };
    // Schedule the HTTP task on Neon’s thread pool and return a JsPromise
    let promise = cx
        .task(move || {
            TOKIO_RT.block_on(async {
                let mut req = HTTP_CLIENT.request(method.parse().unwrap(), &url);

                // apply headers
                for (k, v) in headers_vec.into_iter() {
                    req = req.header(k, v);
                }

                // apply body if any
                if let Some(b) = body_opt {
                    req = req.body(b);
                }

                // send it
                let resp = req.send().await.map_err(|e| e.to_string())?;
                // 1) Extract everything that doesn't consume `resp`
                let status = resp.status().as_u16();
                let status_txt = resp
                    .status()
                    .canonical_reason()
                    .unwrap_or_default()
                    .to_string();

                // let header_pairs = resp
                //     .headers()
                //     .iter()
                //     .map(|(k, v)| {
                //         (
                //             k.as_str().to_string(),
                //             v.to_str().unwrap_or_default().to_string(),
                //         )
                //     })
                //     .collect::<Vec<(String, String)>>();

                let header_pairs = resp
                    .headers()
                    .iter()
                    .map(|(k, v)| {
                        (
                            // for short header names/values this will live on the stack
                            SmolStr::new(k.as_str()),
                            SmolStr::new(v.to_str().unwrap_or_default()),
                        )
                    })
                    .collect::<Vec<(SmolStr, SmolStr)>>();
                // **NEW**: grab the final URL before consuming the body
                let final_url = resp.url().as_str().to_string();
                let redirected = final_url != url;

                // 2) Now consume `resp` for the body bytes
                // let body_bytes = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
                // let body_text = resp.text().await.map_err(|e| e.to_string())?;
                let body_bytes = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
                Ok((
                    status,
                    status_txt,
                    header_pairs,
                    body_bytes,
                    // body_text, //body_bytes,
                    final_url,
                    redirected,
                ))
            })
        })
        .promise(
            |mut cx: TaskContext,
             result: Result<
                (u16, String, Vec<(SmolStr, SmolStr)>, Vec<u8>, String, bool),
                String,
            >| {
                match result {
                    Err(err) => cx.throw_error(err),
                    Ok((status, status_text, headers, body, url, redirected)) => {
                        // 1) empty object
                        let js_obj = cx.empty_object();

                        // 2) status
                        let js_status = cx.number(status as f64);
                        js_obj.set(&mut cx, "status", js_status)?;

                        // 3) statusText
                        let js_status_text = cx.string(status_text);
                        js_obj.set(&mut cx, "statusText", js_status_text)?;

                        // 4) headers
                        let js_h = cx.empty_object();
                        for (k, v) in headers {
                            let js_val = cx.string(&*v);
                            js_h.set(&mut cx, &*k, js_val)?;
                        }
                        js_obj.set(&mut cx, "headers", js_h)?;

                        // 5) body
                        let js_body = JsBuffer::external(&mut cx, body);
                        // let js_body = cx.string(body);
                        js_obj.set(&mut cx, "body", js_body)?;

                        // 6) url
                        let js_url = cx.string(url);
                        js_obj.set(&mut cx, "url", js_url)?;

                        // 7) redirected
                        let js_redir = cx.boolean(redirected);
                        js_obj.set(&mut cx, "redirected", js_redir)?;

                        // 8) type
                        let js_type = cx.string("basic");
                        js_obj.set(&mut cx, "type", js_type)?;

                        Ok(js_obj)
                    }
                }
            },
        );
    Ok(promise)
}

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    // export both functions to JS
    cx.export_function("createClient", create_client)?;
    cx.export_function("fetch", fetch)?;
    Ok(())
}
