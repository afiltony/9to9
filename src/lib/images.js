// Server-side photo shrinking, the safety net behind the browser-side resize (old browsers,
// admin uploads). Pure JavaScript (jimp), so it runs on shared hosting without native modules.

// one image at a time: decoding a large photo takes a few hundred MB of memory
let queue = Promise.resolve();

// the card prints the photo at about 21 × 26 mm, so 1200 px is far more than needed; few, large
// steps keep the worst case quick on slow shared-hosting CPUs
const SIDES = [1200, 900, 640, 480];
const QUALITIES = [82, 68, 55];

/**
 * Re-encodes an image as JPEG, stepping down size and quality until it fits in maxBytes.
 * EXIF orientation is applied on read, so phone photos keep the right way up.
 * Returns the JPEG buffer, or throws if the image cannot be decoded.
 */
export function shrinkToFit(buffer, maxBytes) {
  const job = queue.then(async () => {
    const { Jimp, JimpMime } = await import('jimp');
    const original = await Jimp.read(buffer);
    let smallest = null;
    for (const side of SIDES) {
      const img = original.clone();
      if (img.bitmap.width > side || img.bitmap.height > side) img.scaleToFit({ w: side, h: side });
      for (const quality of QUALITIES) {
        const out = await img.getBuffer(JimpMime.jpeg, { quality });
        if (out.length <= maxBytes) return out;
        if (!smallest || out.length < smallest.length) smallest = out;
      }
    }
    return smallest;
  });
  queue = job.catch(() => {});
  return job;
}
