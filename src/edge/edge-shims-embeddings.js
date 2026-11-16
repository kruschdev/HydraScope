export function l2Normalize(vec) {
    if (!Array.isArray(vec) || vec.length === 0) return [];
    let sumSq = 0;
    for (let i = 0; i < vec.length; i += 1) {
        const v = Number(vec[i]) || 0;
        sumSq += v * v;
    }
    const norm = Math.sqrt(sumSq);
    if (norm === 0) return vec.map(() => 0);
    return vec.map((v) => (Number(v) || 0) / norm);
}

export function cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
        return 0;
    }
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (let i = 0; i < a.length; i += 1) {
        const va = Number(a[i]) || 0;
        const vb = Number(b[i]) || 0;
        dot += va * vb;
        magA += va * va;
        magB += vb * vb;
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
}

export function generateDeterministicVector(seedText, dims = 256) {
    const safeDims = Number.isInteger(dims) && dims > 0 ? dims : 256;
    const out = Array.from({ length: safeDims }, () => 0);
    const str = String(seedText || '');
    for (let i = 0; i < str.length; i += 1) {
        const idx = (str.charCodeAt(i) * 31 + i * 17) % safeDims;
        out[idx] += i % 2 === 0 ? 1 : -1;
    }
    return l2Normalize(out);
}

export async function embedBatch() {
    throw new Error('Edge runtime uses pre-embedded 1024d vectors or lexical cosine.');
}
