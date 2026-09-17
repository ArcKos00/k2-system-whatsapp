/**
 * What WhatsApp can render inline — as a photo, a video or an audio bubble — and what it can
 * only ever deliver as a document card.
 *
 * whatsapp-web.js decides between the two purely by mimetype, so a file that arrives with a
 * generic `application/octet-stream` (which is what many HTTP clients send when they do not
 * know better) is silently turned into a document even when it is a plain JPEG. Fixing the
 * mimetype from the file extension first is what makes inline delivery possible at all.
 */

const MIME_BY_EXTENSION: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
    heic: 'image/heic',
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    '3gp': 'video/3gpp',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    opus: 'audio/ogg',
    wav: 'audio/wav',
    amr: 'audio/amr',
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain',
    csv: 'text/csv',
    json: 'application/json',
    xml: 'application/xml',
    zip: 'application/zip',
    rar: 'application/vnd.rar',
    '7z': 'application/x-7z-compressed',
};

/** Mimetypes that say nothing about the content and should be replaced when we can do better. */
const GENERIC_MIMETYPES = new Set(['application/octet-stream', 'binary/octet-stream', 'application/unknown']);

/**
 * Formats WhatsApp Web accepts as inline media. Anything else — a GIF, a HEIC, an MKV — it
 * would either refuse or quietly wrap as a document, so we do not even try those inline.
 */
const INLINE_MIMETYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'video/mp4',
    'video/3gpp',
    'video/quicktime',
    'audio/mpeg',
    'audio/mp4',
    'audio/aac',
    'audio/ogg',
    'audio/wav',
    'audio/amr',
]);

/**
 * The best mimetype we can vouch for: the declared one when it is specific, otherwise the one
 * the file extension implies, otherwise `application/octet-stream` so the file still goes out
 * as a document instead of failing.
 */
export function resolveMimetype(declared: string | null | undefined, filename: string | null | undefined): string {
    const normalized = declared?.split(';')[0].trim().toLowerCase();
    if (normalized && !GENERIC_MIMETYPES.has(normalized)) {
        return normalized;
    }
    const extension = filename?.split('.').pop()?.toLowerCase();
    if (extension && extension !== filename?.toLowerCase() && MIME_BY_EXTENSION[extension]) {
        return MIME_BY_EXTENSION[extension];
    }
    return normalized || 'application/octet-stream';
}

/** True when WhatsApp can show this file as a photo, video or audio bubble rather than a file card. */
export function canSendInline(mimetype: string): boolean {
    return INLINE_MIMETYPES.has(mimetype.toLowerCase());
}

/**
 * What the first bytes of a file say it really is.
 *
 * WhatsApp Web prepares a photo or a video by decoding it in the page before the upload, so a
 * file whose bytes do not match its declared type does not come back as a rejected send — the
 * prep simply yields nothing, and the library then hands `undefined` to an in-page getter and
 * dies inside WhatsApp's own bundle with a message about memoization. Sniffing the content
 * first is what keeps a mislabelled file on the document path, where nothing is decoded.
 */
const MAGIC_SIGNATURES: ReadonlyArray<{ mimetype: string; matches: (bytes: Buffer) => boolean }> = [
    {mimetype: 'image/jpeg', matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff},
    {mimetype: 'image/png', matches: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))},
    {mimetype: 'image/gif', matches: (b) => b.subarray(0, 3).toString('latin1') === 'GIF'},
    {mimetype: 'image/bmp', matches: (b) => b.subarray(0, 2).toString('latin1') === 'BM'},
    {mimetype: 'image/webp', matches: (b) => isRiff(b, 'WEBP')},
    {mimetype: 'audio/wav', matches: (b) => isRiff(b, 'WAVE')},
    {mimetype: 'video/x-matroska', matches: (b) => b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))},
    {mimetype: 'audio/ogg', matches: (b) => b.subarray(0, 4).toString('latin1') === 'OggS'},
    {mimetype: 'audio/mpeg', matches: (b) => b.subarray(0, 3).toString('latin1') === 'ID3'},
    {mimetype: 'application/pdf', matches: (b) => b.subarray(0, 4).toString('latin1') === '%PDF'},
    {mimetype: 'application/zip', matches: (b) => b[0] === 0x50 && b[1] === 0x4b},
    {mimetype: 'text/html', matches: (b) => /^\s*<(!doctype html|html|\?xml)/i.test(b.subarray(0, 64).toString('latin1'))},
];

/** ISO base media brands, which all sit at offset 4 behind `ftyp`, mapped to what they play as. */
const ISO_BRANDS: Record<string, string> = {
    qt: 'video/quicktime',
    '3gp': 'video/3gpp',
    M4A: 'audio/mp4',
};

function isRiff(bytes: Buffer, form: string): boolean {
    return bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === form;
}

function sniffIsoMedia(bytes: Buffer): string | undefined {
    if (bytes.subarray(4, 8).toString('latin1') !== 'ftyp') return undefined;
    const brand = bytes.subarray(8, 12).toString('latin1');
    for (const [prefix, mimetype] of Object.entries(ISO_BRANDS)) {
        if (brand.startsWith(prefix)) return mimetype;
    }
    return 'video/mp4';
}

/** The mimetype the bytes themselves imply, or undefined for a format we cannot recognise. */
export function sniffMimetype(bytes: Buffer): string | undefined {
    if (bytes.length < 12) return undefined;
    return MAGIC_SIGNATURES.find((signature) => signature.matches(bytes))?.mimetype ?? sniffIsoMedia(bytes);
}

/**
 * The mimetype to send a file under, with the content having the final say.
 *
 * `resolveMimetype` trusts what the caller declared; this trusts the file. They differ only for
 * a mislabelled upload — a video saved under a `.jpeg` name, an HTML error page downloaded in
 * place of a photo — which is exactly the case that must not reach the inline media path.
 */
export function verifiedMimetype(
    declared: string | null | undefined,
    filename: string | null | undefined,
    bytes: Buffer,
): { mimetype: string; declaredMimetype: string; mismatched: boolean } {
    const declaredMimetype = resolveMimetype(declared, filename);
    const sniffed = sniffMimetype(bytes);
    const mismatched = !!sniffed && sniffed !== declaredMimetype;
    return {mimetype: mismatched ? sniffed! : declaredMimetype, declaredMimetype, mismatched};
}
