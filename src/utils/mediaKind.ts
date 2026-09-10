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
