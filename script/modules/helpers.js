export function setStatus(msg, type) {
    const statusText = document.getElementById("status-text");
    const dot = document.getElementById("dot");
    if (statusText) statusText.textContent = msg;
    if (dot) dot.className = "dot" + (type ? " " + type : "");
}

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

export function formatAadhaarNumber(aadhaarNumber) {
    const last4 = (aadhaarNumber || "????").slice(-4);
    return `XXXX XXXX ${last4}`;
}

export function extractComment(bytes) {
    for (let i = 0; i < bytes.length - 4; i++) {
        if (bytes[i] === 0xff && bytes[i + 1] === 0x64) {
            const len = (bytes[i + 2] << 8) | bytes[i + 3];
            return new TextDecoder()
                .decode(bytes.slice(i + 6, i + 2 + len))
                .replace(/\0/g, "");
        }
    }
    return null;
}
