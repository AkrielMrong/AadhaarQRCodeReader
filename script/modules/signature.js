/**
 * @module modules/signature
 * @description Offline cryptographic verification of Aadhaar Secure QR digital signatures
 * using the W3C Web Crypto API (crypto.subtle).
 *
 * Implements client-side RSA-2048 / SHA-256 signature verification against official
 * UIDAI public key certificates (covering 2020 through 2029) without any network access.
 */

// ─── UIDAI Public Key Trust Store (2020 – 2029) ──────────────────────────────

/**
 * Official UIDAI SPKI public keys extracted from published UIDAI signing certificates.
 */
const UIDAI_KEYS = [
    {
        file: "uidai_auth_sign_prod_2023.cer",
        name: "UIDAI DS 01 (2020–2023)",
        period: "2020 – 2023",
        subject: "CN=DS UIDAI 01, UIDAI Technology Centre",
        spkiB64: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1Ig2iA6b9jenLPTGogsTgLx4nv1p/V2T0q3RBa4gJDKrZt41bMEWaXkFUEuN5S+NtZvPbO/jJj2Wi1NvSQqVYTA/7Jy0hVUOWJpYev7/PFzAAUOgkotQsmiS8hhpR5IOssO+1KrYrd7Kki+ZLkN/9PqaIEkrJhvEOP7wtNnF5JeHXbEFSz1fpHGRZIzZyogmQ89vaY9gXByG1MJzNqlpRhoahAHqZtvBbU9BHqpfFQFV58V7fvewaHc/K3LRs47D80FgcsRLWn7eNRdKnai+ozGwQQirRz+gKOOFslhQprTX3QSFkPJNiiMa42wPhUJvuMmTXE3ruzMQrJhDYt3/jQIDAQAB"
    },
    {
        file: "uidai_offline_publickey_26022021.cer",
        name: "UIDAI Offline DS 05 (2021–2024)",
        period: "2021 – 2024",
        subject: "CN=DS UNIQUE IDENTIFICATION AUTHORITY OF INDIA 05",
        spkiB64: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAonIsDl8t5bpwftk/A27CsfC5VZMjkPrMDwvL8gyAoVwIi0iGhmty6yWrC/VaL+Brae29XMg7dMdwnbIUHmwHxovN+FnT2vfz/O0kHQcgVdwVSIR0tFwsmC+pVKpSqm//skgYYcZQhdhLZBWOn0PZ81ymm0jOkwBSIQKkyuCTv/1HSwjTLR0EBvaH9+Vb0iaiOEv1ikHDhMOXTxx8URWBnJJt463z7LuZBMSG8fXVMDl3vqY1hDZzKbXBaK/clRIXMff0jUOvfPMfabHju+eUnceosQwL3eurq96+oHahz4FmrfBqikHe3xQ7/4NdvSvVuwth0kcsI0ptRBG8m1NglQIDAQAB"
    },
    {
        file: "uidai_auth_sign_prod_2026.cer",
        name: "UIDAI Auth Sign (2023–2026)",
        period: "2023 – 2026",
        subject: "CN=UIDAI, Technology Centre Bangalore",
        spkiB64: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAt6ei4Qnec7W2nWNYa3d6zwNzTPtrHogh1iAv62ydWg4rFKUYGhxP79shMmczd/Ef8ij8uoUUVKvCjn3QLxVnrOqhQYyNCn0VbUw1WX8Nj1IiNaSFMoXtLqqFuszjenGlLiNvGIbYAwMy8tfIOg6dRcXFN+3fIrWVnOz7OUA53tIkFQyV0gITwtxqrKtnXQAbuAILh1YiVVMH4F/N0Chx500tZpAfMGUQBKkwbP2jTcw8Dw4vd6MxKlzr40N5NYaG3Ngx/3ASSOjzPcNvTIP52X6p392vgmCxKbfc79IdkB80QxqlPOshAzS5E50k5t5YOlc3Tzq3Jq9TkN+/NXU2xQIDAQAB"
    },
    {
        file: "uidai_offline_publickey_17022026.cer",
        name: "UIDAI Offline DS 05 (2024–2026)",
        period: "2024 – 2026",
        subject: "CN=DS Unique Identification Authority of India 05",
        spkiB64: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmMIJKj28JcTN1B72p2/pgzDCoguhs/rbIXgN/ybNNh0NVOrZV2KllrmT5VOYlMrABpvIp7JU/n6hma3/O14n7nvngJ/y3colh8rk7msDwVAO7ZuVD+GCzfaYPLLkUS+wqH7M7FOHIn/pyJo1Rkxm98lO3dyox5RuLG2Uqm7JfVIomm0t7QKJoM5rf8JNvPXdwsxN89eWlT2Bf7BF//G3FKiF7ZHfvIyyqte/3orRRG/M80QqLrDP1RIeOa53ZTgILXcyQOb2yZOqNH3iN2uSKRsusNO17To5FOb2J9Hd5wIMuDv3zw4MWTrKAWuTYon90QSeGRKv1d5AQNRt0x5dSwIDAQAB"
    },
    {
        file: "uidai_offline_publickey_2026.cer",
        name: "UIDAI Offline DS 06 (2026–2029)",
        period: "2026 – 2029",
        subject: "CN=DS Unique Identification Authority of India 06",
        spkiB64: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAh1+zYnvbcEm0Yz73s5u42odpUJMr9wv5bVw7sOE5nFNbrB+U++5I0f8cL2HoHnJOkwvLZzrD0jG/vxAKi6vii/gjEzUEgrkdIHxMP3D6GJs0MSQHiEXvIGOwPIH3BLtBOc3m28NVNT6Q9iq0gUwuxnlhV38UdNhCllqNYhWmAMPJkImgaKrRZvY2pWNs6gd+PlAF/9SO69x3+1meA8kPk2ZvQanZlx9tfaExeOe9or3NQiKy2+UbtXrpcoAfYbbWi1OUzXi5bJdhbGp239c1fX6UKyUM5IUMY+m3I7wu2WQ7lmeO2n/vwzQz/PKHXPWYu3bydWMLdCi07vOQBqzCKwIDAQAB"
    },
    {
        file: "uidai_auth_prod.cer",
        name: "UIDAI Auth Prod (2025–2028)",
        period: "2025 – 2028",
        subject: "CN=UIDAI, Technology Center Karnataka",
        spkiB64: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAz83ldUE+gDAtZlmBKSJH/g1vbIsYWMr7P8Z96qRote0hQkm3Dik50r3Ls19wCv02+/tE/zXPmzFVMzyPuyykntaU8nazBTqgPHn4T80qfu02AfLAQBICtGR2Scjl+LukxgU5rpvx5JhzcNkTAUyCHatr6b/RPrzKEiUUf5QQn+FU5HJWUIvU3W3TJ8A/CNx0OxYAMOacOMXuX6ENUKvh8jKf31NeV8rgF0SQ47R1Tnv5w/JcmmklO9hcxX8UMUx4bvLXP3YN/Y86/nV1DYVT31FtpnKu5FTIytzTvKowj1B+twox1Ui7t1tAt8aWFBCX9cG7zK1MmY/GdDEWyHhoDwIDAQAB"
    }
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Converts a base64 string to an ArrayBuffer.
 * @param {string} b64
 * @returns {ArrayBuffer}
 */
function base64ToArrayBuffer(b64) {
    const binStr = atob(b64);
    const len = binStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binStr.charCodeAt(i);
    }
    return bytes.buffer;
}

/** Cache for imported CryptoKey instances */
let importedKeys = null;

/**
 * Lazily imports and caches UIDAI CryptoKey objects.
 * @returns {Promise<Array<{ entry: typeof UIDAI_KEYS[0], key: CryptoKey }>>}
 */
async function getImportedKeys() {
    if (importedKeys) return importedKeys;

    importedKeys = [];
    const subtle = (typeof window !== "undefined" ? window.crypto : crypto).subtle;

    for (const entry of UIDAI_KEYS) {
        try {
            const keyBuffer = base64ToArrayBuffer(entry.spkiB64);
            const key = await subtle.importKey(
                "spki",
                keyBuffer,
                { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
                false,
                ["verify"]
            );
            importedKeys.push({ entry, key });
        } catch (err) {
            console.warn(`Could not import UIDAI key [${entry.name}]:`, err);
        }
    }

    return importedKeys;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * @typedef {Object} SignatureVerificationResult
 * @property {boolean} isValid - Whether the signature is genuine and mathematically verified.
 * @property {string} [signerName] - Name of the matching UIDAI signing key.
 * @property {string} [signerPeriod] - Validity period of the matching certificate.
 * @property {string} [subject] - X.509 certificate subject.
 * @property {string} [error] - Error message if signature verification failed.
 */

/**
 * Verifies the 256-byte digital signature of an Aadhaar Secure QR code.
 *
 * @param {Uint8Array} decompressedBytes - Full decompressed payload bytes.
 * @returns {Promise<SignatureVerificationResult>}
 */
export async function verifyAadhaarSignature(decompressedBytes) {
    if (!decompressedBytes || decompressedBytes.length <= 256) {
        return {
            isValid: false,
            error: "Payload too small to contain a 2048-bit digital signature"
        };
    }

    // The signature occupies the last 256 bytes (2048 bits)
    const signedData = decompressedBytes.slice(0, decompressedBytes.length - 256);
    const signature = decompressedBytes.slice(decompressedBytes.length - 256);

    const subtle = (typeof window !== "undefined" ? window.crypto : crypto).subtle;
    const keys = await getImportedKeys();

    for (const { entry, key } of keys) {
        try {
            const isVerified = await subtle.verify(
                "RSASSA-PKCS1-v1_5",
                key,
                signature,
                signedData
            );

            if (isVerified) {
                return {
                    isValid: true,
                    signerName: entry.name,
                    signerPeriod: entry.period,
                    subject: entry.subject
                };
            }
        } catch (e) {
            // Check next key
        }
    }

    return {
        isValid: false,
        error: "Digital signature verification failed. The QR code may be altered, forged, or signed by an unknown key."
    };
}
