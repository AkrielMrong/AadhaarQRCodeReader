/**
 * decodeAadhaarQR - Parses and decodes Aadhaar Secure QR code data (version 3).
 * Supports encrypted format with photo extraction.
 *
 * Reference: https://uidai.gov.in/images/resource/User_manulal_QR_Code_15032019.pdf
 */
import { decimalToBytes, gunzip } from "../utils/bytes.js";

// Aadhaar QR text is encoded in ISO-8859-1 (Latin-1). A single shared decoder
// instance is reused to avoid repeated allocations while parsing fields.
const TEXT_DECODER = new TextDecoder("iso-8859-1");

// Aadhaar QR fields are separated by a single 0xff byte.
const FIELD_DELIMITER = 0xff;

// JPEG2000 codestreams start with the marker FF 4F FF 51 and end with FF D9.
const JP2_START_MARKER = new Uint8Array([0xff, 0x4f, 0xff, 0x51]);
const JP2_END_MARKER = new Uint8Array([0xff, 0xd9]);

// gzip streams start with the magic bytes 1F 8B.
const GZIP_MAGIC = [0x1f, 0x8b];

/**
 * @typedef {Object} AadhaarData
 * @property {string} [version]
 * @property {string} email_mobile_status
 * @property {string} referenceid
 * @property {string} name
 * @property {string} dob
 * @property {string} gender
 * @property {string} aadhaar_num
 * @property {boolean} email - Whether an email is registered.
 * @property {boolean} mobile - Whether a mobile number is registered.
 * @property {Uint8Array | null} imageBytes - Raw JPEG2000 photo, if present.
 */

// ─── Internal utility ─────────────────────────────────────────────────────

/**
 * Finds the first index of a subarray inside a Uint8Array.
 * @param {Uint8Array} arr
 * @param {Uint8Array} subArr
 * @param {number} startIndex
 * @returns {number} Index of the first match, or -1 if not found.
 */
function _findSubarrayIndex(arr, subArr, startIndex = 0) {
    outer: for (let i = startIndex; i <= arr.length - subArr.length; i++) {
        for (let j = 0; j < subArr.length; j++) {
            if (arr[i + j] !== subArr[j]) {
                continue outer;
            }
        }
        return i;
    }

    return -1;
}

/**
 * Returns field names based on Aadhaar QR version marker.
 * @param {Uint8Array} bytes
 * @returns {string[]}
 */
function _getDetailsCol(bytes) {
    const details = [
        "email_mobile_status",
        "referenceid",
        "name",
        "dob",
        "gender",
        "careof",
        "district",
        "landmark",
        "house",
        "location",
        "pincode",
        "postoffice",
        "state",
        "street",
        "subdistrict",
        "vtc",
    ];

    const firstTwo = TEXT_DECODER.decode(bytes.slice(0, 2));

    if (firstTwo[0] === "V" && /\d/.test(firstTwo[1] ?? "")) {
        details.unshift("version");
        details.push("last_4_digits_mobile_no");
    }

    return details;
}

/**
 * Concatenates two Uint8Arrays without spreading into a temporary JS array
 * (spreading large typed arrays risks a call-stack overflow and is slow).
 *
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {Uint8Array}
 */
function _concatBytes(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

/**
 * Finds JPEG2000 image block inside Aadhaar QR bytes.
 * JPEG2000 codestream usually starts with FF 4F FF 51.
 *
 * @param {Uint8Array} bytes
 * @returns {{ start: number, end: number } | null}
 */
function _findImageInfo(bytes) {
    const jp2Start = _findSubarrayIndex(bytes, JP2_START_MARKER);

    if (jp2Start === -1) {
        return null;
    }

    const jp2End = _findSubarrayIndex(bytes, JP2_END_MARKER, jp2Start);

    return {
        start: jp2Start,
        end: jp2End > -1 ? jp2End + 2 : bytes.length,
    };
}

/**
 * Finds field delimiter indexes.
 *
 * Aadhaar QR fields are separated by 0xff.
 *
 * @param {Uint8Array} bytes
 * @returns {number[]}
 */
function _findFieldDelimiters(bytes) {
    const delimiters = [-1]; // Start with -1 to capture the first field correctly.

    for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === FIELD_DELIMITER) {
            delimiters.push(i);
        }
    }

    return delimiters;
}

/**
 * Parses a timestamp in the format "YYYYMMDDHHMMSSsss" into a JavaScript Date.
 *
 * Example:
 *   "20260524121352786"
 *    YYYY MM DD HH MM SS mmm
 *    2026 05 24 12 13 52 786
 *
 * @param {string} ts - Timestamp string in the format "YYYYMMDDHHMMSSsss".
 * @returns {Date} Parsed Date object in the local timezone.
 * @throws {TypeError} If the timestamp is not a 17-character string.
 */
function parseTimestamp(ts) {
    if (typeof ts !== "string" || ts.length !== 17) {
        return null;
    }

    try {
        const d = new Date(
            Number(ts.slice(0, 4)), // year
            Number(ts.slice(4, 6)) - 1, // month (0-based)
            Number(ts.slice(6, 8)), // day
            Number(ts.slice(8, 10)), // hour
            Number(ts.slice(10, 12)), // minute
            Number(ts.slice(12, 14)), // second
            Number(ts.slice(14, 17)) // millisecond
        );
        return isNaN(d.getTime()) ? null : d;
    } catch {
        return null;
    }
}
/**
 * Parses text fields from decompressed Aadhaar QR bytes.
 *
 * @param {Uint8Array} bytes
 * @returns {Record<string, string>}
 */
function _parseDetails(bytes) {
    const delimiters = _findFieldDelimiters(bytes);
    const fieldNames = _getDetailsCol(bytes);
    const data = {};

    for (let i = 0; i < delimiters.length; i++) {
        const start = delimiters[i] + 1;
        const end = delimiters[i + 1] ?? bytes.length;
        const fieldName = fieldNames[i] ?? `details_${i}`;

        data[fieldName] = TEXT_DECODER.decode(bytes.slice(start, end));
    }

    const ref = data.referenceid ?? "";
    data.aadhaar_num = ref.slice(0, 4);
    data.referenceid = ref.slice(4);
    data.reference_date = parseTimestamp(ref.slice(4));

    if (data.reference_date instanceof Date && !isNaN(data.reference_date.getTime())) {
        console.log("Reference date:", data.reference_date.toISOString());
    }

    const EMAIL_MOBILE_STATUS = {
        0: "none",
        1: "email",
        2: "mobile",
        3: "both",
    };
    data.email_mobile_status =
        EMAIL_MOBILE_STATUS[
            Number.parseInt(data.email_mobile_status ?? "", 10)
        ];

    if (
        data.email_mobile_status === "email" ||
        data.email_mobile_status === "both"
    ) {
        data.email = data[`details_${fieldNames.length}`];
        delete data[`details_${fieldNames.length}`];
    }

    return data;
}

/**
 * Decodes an Aadhaar secure QR payload (version 2/3).
 *
 * @param {string} base10encodedstring - Base-10 encoded QR payload string.
 * @returns {Promise<AadhaarData>}
 * @throws {TypeError} If the payload is not a non-empty string.
 * @throws {Error} If the payload is not a valid gzip stream.
 */
export async function decodeAadhaarQR(base10encodedstring) {
    if (
        typeof base10encodedstring !== "string" ||
        base10encodedstring.trim() === ""
    ) {
        throw new TypeError("Aadhaar QR payload must be a non-empty string");
    }

    const gzipBytes = decimalToBytes(base10encodedstring);

    if (gzipBytes[0] !== GZIP_MAGIC[0] || gzipBytes[1] !== GZIP_MAGIC[1]) {
        throw new Error("Payload does not start with gzip magic bytes: 1f 8b");
    }

    const decompressedBytes = await gunzip(gzipBytes);

    const imageInfo = _findImageInfo(decompressedBytes);

    if (!imageInfo) {
        console.warn("JPEG2000 magic bytes not found in decompressed data");
    }

    const imageBytes = imageInfo
        ? decompressedBytes.slice(imageInfo.start, imageInfo.end)
        : null;

    const fieldBytes = imageInfo
        ? _concatBytes(
              decompressedBytes.slice(0, imageInfo.start),
              decompressedBytes.slice(
                  imageInfo.end,
                  decompressedBytes.length - 256
              )
          )
        : decompressedBytes;

    const data = _parseDetails(fieldBytes);
    console.log(data);

    return {
        ...data,
        imageBytes,
    };
}
