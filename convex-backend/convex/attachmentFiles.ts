export const maxSize = 50 * 1024 * 1024;
export const storageContentType = "application/vnd.anchor.attachment";
export const exportStorageContentType = "application/vnd.anchor.export";
export const mimeTypes = new Set([
	"image/jpeg",
	"image/png",
	"image/webp",
	"image/gif",
	"audio/mpeg",
	"audio/wav",
	"audio/mp4",
	"audio/x-m4a",
	"audio/ogg",
	"audio/aac",
	"audio/webm",
]);

export function validFilename(name: string | undefined): name is string {
	return !!name && name.length <= 255 && !/[\x00-\x1f\x7f/\\]/.test(name);
}
