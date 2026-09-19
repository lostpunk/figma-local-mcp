function base64FromBytes(bytes) {
    const chunk = 0x8000;
    const parts = [];
    for (let offset = 0; offset < bytes.length; offset += chunk) {
        parts.push(String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunk, bytes.length))));
    }
    return btoa(parts.join(''));
}
export async function normalizeImage(message) {
    try {
        const response = await fetch('data:' + (message.mimeType || 'application/octet-stream') + ';base64,' + message.base64);
        const blob = await response.blob();
        const bitmap = await createImageBitmap(blob);
        const scale = Math.min(1, 4096 / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context)
            throw new Error('Canvas is unavailable in the Figma plugin UI');
        context.drawImage(bitmap, 0, 0, width, height);
        bitmap.close?.();
        const png = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Canvas PNG encoding failed')), 'image/png'));
        const bytes = new Uint8Array(await png.arrayBuffer());
        parent.postMessage({ pluginMessage: { type: 'decode-image-result', id: message.id, base64: base64FromBytes(bytes) } }, '*');
    }
    catch (error) {
        parent.postMessage({ pluginMessage: { type: 'decode-image-result', id: message.id,
                error: error instanceof Error ? error.message : String(error) } }, '*');
    }
}
