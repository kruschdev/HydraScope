import { scrubSensitiveStrings } from '../utils/scrubber.js';

export { scrubSensitiveStrings };

export function surrogateVertexId(namespace, logicalId) {
    const hasTwoArgs = logicalId !== undefined;
    const ns = hasTwoArgs ? String(namespace ?? 'default').trim() || 'default' : 'default';
    const id = hasTwoArgs ? String(logicalId ?? '').trim() : String(namespace ?? '').trim();
    const raw = `${ns}\x00${id}`;
    let h1 = 0xdeadbeef ^ raw.length;
    let h2 = 0x41c6ce57 ^ raw.length;
    for (let i = 0; i < raw.length; i += 1) {
        const ch = raw.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 1000 + (4294967296 * (2097151 & h2) + (h1 >>> 0));
}
