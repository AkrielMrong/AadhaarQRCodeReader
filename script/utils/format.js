/**
 * @module utils/format
 * @description Formatting and extraction helpers for Aadhaar card display data.
 */

/**
 * Formats a raw Aadhaar number (or its last-4-digit suffix) into the standard
 * masked display string shown on the physical Aadhaar card.
 *
 * Only the last four digits are ever shown; the first eight are replaced with
 * `X` groups to protect the cardholder's full number.
 *
 * @param {string} aadhaarNumber - The full 12-digit Aadhaar number **or** just
 *   the last-4-digit string extracted from the QR payload.
 * @returns {string} Masked display string in the form `"XXXX XXXX ####"`.
 *
 * @example
 * formatAadhaarNumber("123456781234"); // → "XXXX XXXX 1234"
 * formatAadhaarNumber("1234");         // → "XXXX XXXX 1234"
 * formatAadhaarNumber("");             // → "XXXX XXXX ????"
 */
export function formatAadhaarNumber(aadhaarNumber) {
    const last4 = (aadhaarNumber || "????").slice(-4);
    return `XXXX XXXX ${last4}`;
}

/**
 * Extracts the embedded comment string from a JPEG 2000 (ISO 15444-1) codestream.
 *
 * JPEG 2000 comment (CMT) markers have the binary layout:
 * ```
 * FF 64  — marker code
 * LL LL  — 2-byte big-endian segment length (includes the 4 header bytes)
 * RR RR  — 2-byte registration value (0x0001 = Latin-1 text, 0x0000 = binary)
 * <data> — comment bytes (length − 2 bytes)
 * ```
 * This function scans the byte array for the first `FF 64` marker, reads the
 * payload, strips any embedded null characters, and returns it as a string.
 *
 * @param {Uint8Array} bytes - Raw JPEG 2000 codestream bytes.
 * @returns {string | null} Decoded comment text, or `null` if no CMT marker
 *   is present in the stream.
 *
 * @example
 * const comment = extractComment(jp2Bytes);
 * if (comment) console.log("JP2 comment:", comment);
 */
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
