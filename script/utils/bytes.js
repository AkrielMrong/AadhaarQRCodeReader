/**
 * @module utils/bytes
 * @description Low-level binary utilities for converting and decompressing
 * the raw byte streams found inside Aadhaar Secure QR payloads.
 */

/**
 * Converts a base-10 decimal string into a raw `Uint8Array` of bytes.
 *
 * Aadhaar Secure QR codes encode their compressed payload as a single,
 * very large decimal integer. This function converts that integer —
 * via `BigInt` to avoid precision loss — into the equivalent sequence
 * of bytes so it can be passed to {@link gunzip}.
 *
 * @param {string} decStr - Decimal-encoded byte string (may have leading /
 *   trailing whitespace, which is trimmed automatically).
 * @returns {Uint8Array} Raw bytes represented by the decimal value.
 *
 * @example
 * const bytes = decimalToBytes("31337"); // → Uint8Array [0x7a, 0x69]
 */
export function decimalToBytes(decStr) {
    const n = BigInt(decStr.trim());
    let hex = n.toString(16);
    if (hex.length % 2) hex = "0" + hex;

    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
}

/**
 * Decompresses a gzip-compressed `Uint8Array` using the browser's built-in
 * `DecompressionStream` API (available in all modern browsers and Node ≥ 18).
 *
 * The function streams all chunks from the decompression reader, concatenates
 * them into a single contiguous `Uint8Array`, and resolves with the result.
 *
 * @param {Uint8Array} uint8 - Gzip-compressed input bytes (magic bytes `1F 8B`).
 * @returns {Promise<Uint8Array>} Resolves with the decompressed bytes.
 * @throws {Error} If the input is not a valid gzip stream.
 *
 * @example
 * const raw = await gunzip(compressedBytes);
 */
export async function gunzip(uint8) {
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    writer.write(uint8);
    writer.close();

    const chunks = [];
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
    }

    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
    }
    return out;
}
