const { rustFetch } = require('./rustFetch');
// const rustFetch = fetch;
async function bench() {
    try {
        let resps = []
        const iterations = 1e4;
        console.log(`Performing: ${iterations} iterations`)
        var t1 = Date.now();
        for (let i = 0; i < iterations; i++) {
            await rustFetch('http://localhost:8080/albums', {}); // Sequential: 2700 ms, Parallel: 960 ms, Peak memory: 201376 KB
        }
        // await Promise.all(resps)
        var t2 = Date.now();
        console.log(`Sequential: ${t2 - t1} ms | ${Math.floor(iterations * 1e3 / (t2 - t1))} rps`)
        var t2 = Date.now();
        for (let i = 0; i < iterations; i++) {
            const resp = rustFetch('http://localhost:8080/albums', {}); // Sequential: 2700 ms, Parallel: 960 ms, Peak memory: 201376 KB
            resps.push(resp)
        }
        await Promise.all(resps)
        var t3 = Date.now();
        console.log(`Parallel: ${t3 - t2} ms | ${Math.floor(iterations * 1e3 / (t3 - t2))} rps`)
        // console.log(await (await rustFetch('http://localhost:8080/albums', { method: "GET" })).json())
    } catch (err) {
        console.error('Fetch error', err);
    }
}
bench();