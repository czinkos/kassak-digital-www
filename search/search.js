// czssg search client
// Loads the WASM module, fetches shards on demand, returns ranked results.

let wasmInstance = null;
let manifest = null;   // { shardKey: filename }
let docPaths = null;   // string[] — index matches DocRef.doc_id

// ── Bootstrap ────────────────────────────────────────────────────────────────

export async function init(basePath = '.') {
    const [wasm, mf, dp] = await Promise.all([
        WebAssembly.instantiateStreaming(fetch(`${basePath}/search_client.wasm`)),
        fetch(`${basePath}/manifest.json`).then(r => r.json()),
        fetch(`${basePath}/docs.json`).then(r => r.json()),
    ]);
    wasmInstance = wasm.instance.exports;
    manifest = mf;
    docPaths = dp;
}

// ── Public API ───────────────────────────────────────────────────────────────

// Returns [{doc_id, path, score}] ranked by score, deduplicated across shards.
export async function search(query, basePath = '.') {
    if (!wasmInstance) throw new Error('Call init() first');

    const tokens = tokenize(query);
    if (!tokens.length) return [];

    // Group tokens by shard key, fetch each shard once
    const keyToTokens = new Map();
    for (const tok of tokens) {
        const key = shardKey(tok);
        if (!keyToTokens.has(key)) keyToTokens.set(key, []);
        keyToTokens.get(key).push(tok);
    }

    // Fetch and search each required shard
    const scoreMap = new Map(); // doc_id → total score

    await Promise.all([...keyToTokens.entries()].map(async ([key, toks]) => {
        const filename = manifest[key];
        if (!filename) return; // no shard for this prefix

        const shardBytes = new Uint8Array(
            await fetch(`${basePath}/${filename}`).then(r => r.arrayBuffer())
        );

        for (const tok of toks) {
            const matches = wasmSearch(tok, shardBytes);
            for (const { doc_id, score } of matches) {
                scoreMap.set(doc_id, (scoreMap.get(doc_id) || 0) + score);
            }
        }
    }));

    return [...scoreMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([doc_id, score]) => ({
            ...(docPaths[doc_id] ?? {}),
            doc_id,
            score,
        }));
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function wasmSearch(query, shardBytes) {
    const wasm = wasmInstance;

    const queryBytes = new TextEncoder().encode(query);
    const qPtr = wasm.alloc(queryBytes.length);
    const sPtr = wasm.alloc(shardBytes.length);

    const mem = () => new Uint8Array(wasm.memory.buffer);
    mem().set(queryBytes, qPtr);
    mem().set(shardBytes, sPtr);

    wasm.search_shard(qPtr, queryBytes.length, sPtr, shardBytes.length);

    const rPtr = wasm.result_ptr();
    const rLen = wasm.result_len();
    const json = new TextDecoder().decode(mem().slice(rPtr, rPtr + rLen));

    wasm.dealloc(qPtr, queryBytes.length);
    wasm.dealloc(sPtr, shardBytes.length);

    return JSON.parse(json);
}

// Must match czssg indexer: split on non-alphanumeric, min length 2, lowercase
function tokenize(text) {
    return (text.match(/[\p{L}\p{N}]{2,}/gu) ?? []).map(t => t.toLowerCase());
}

// Must match czssg indexer shard_key()
function shardKey(term) {
    if (!term) return '__other';
    const chars = [...term];           // iterate Unicode code points
    if (!/^[a-zA-Z]$/.test(chars[0])) return '__other';
    if (chars.length < 2) return chars[0] + '_';
    return chars[0] + chars[1];
}
