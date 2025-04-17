// .task(move || {
//     TOKIO_RT.block_on(async {
//         let resp = HTTP_CLIENT
//             .get(&url)
//             .send()
//             .await
//             .map_err(|e| e.to_string())?;
//         // pull these out *before* consuming resp
//         let status = resp.status().as_u16();
//         let header_map = resp.headers().clone();
//         let body = resp.text().await.map_err(|e| e.to_string())?;
//         // serialize headers if you like:
//         let header_pairs = header_map
//             .iter()
//             .map(|(k, v)| {
//                 let key = k.as_str().to_owned();
//                 let value = v.to_str().unwrap_or_default().to_owned();
//                 (key, value)
//             })
//             .collect::<Vec<(String, String)>>();
//         Ok((status, header_pairs, body))
//     })
// })
// .promise(
//     |mut cx, result: Result<(u16, Vec<(String, String)>, String), String>| {
//         match result {
//             Err(err) => cx.throw_error(err),
//             Ok((status, header_pairs, body)) => {
//                 let js_obj = cx.empty_object();
//                 // 1) status: split number generation & set
//                 let js_status = cx.number(status as f64);
//                 js_obj.set(&mut cx, "status", js_status)?;
//                 // 2) headers: build JS object with one borrow per stmt
//                 let js_h = cx.empty_object();
//                 for (k, v) in header_pairs {
//                     let js_val = cx.string(v);
//                     js_h.set(&mut cx, &*k, js_val)?;
//                 }
//                 js_obj.set(&mut cx, "headers", js_h)?;
//                 // 3) body: same pattern
//                 let js_body = cx.string(body);
//                 js_obj.set(&mut cx, "body", js_body)?;
//                 Ok(js_obj)
//             }
//         }
//     },
// );
