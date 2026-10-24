// Stores uploaded photos and signatures as files in DATA_DIR/uploads.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 4 * 1024 * 1024;
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

class Files {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  // Save a "data:image/...;base64,..." string. Returns the stored file name.
  saveDataUrl(dataUrl, prefix) {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
    if (!m) throw new Error('Please attach a photo / signature');
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length) throw new Error('Empty image');
    if (buf.length > MAX_BYTES) throw new Error('Image is too large');
    const name = `${prefix}_${crypto.randomBytes(12).toString('hex')}.${TYPES[m[1]]}`;
    fs.writeFileSync(path.join(this.dir, name), buf);
    return name;
  }

  pathOf(name) {
    if (!/^[a-z]+_[0-9a-f]{24}\.(jpg|png|webp)$/.test(String(name || ''))) return null;
    const p = path.join(this.dir, name);
    return fs.existsSync(p) ? p : null;
  }

  remove(name) {
    const p = this.pathOf(name);
    if (p) fs.unlinkSync(p);
  }
}

module.exports = { Files };
