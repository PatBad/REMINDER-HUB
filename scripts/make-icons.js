'use strict';

// Renders assets/logo.svg into the PNG and ICO files the app and installer need.
// Run with:  npm run icons
// To use your own logo, replace assets/logo.svg (square artwork) and run it again.

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'assets', 'logo.svg'));
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

function buildIco(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const entry = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.png)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<html><body></body></html>');
  const src = `data:image/svg+xml;base64,${svg.toString('base64')}`;

  async function render(size) {
    const dataUrl = await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = c.height = ${size};
          const ctx = c.getContext('2d');
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, ${size}, ${size});
          resolve(c.toDataURL('image/png'));
        };
        img.onerror = () => reject(new Error('could not load logo.svg'));
        img.src = ${JSON.stringify(src)};
      })`);
    return Buffer.from(dataUrl.split(',')[1], 'base64');
  }

  const images = [];
  for (const size of ICO_SIZES) images.push({ size, png: await render(size) });
  const ico = buildIco(images);
  const png512 = await render(512);

  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build', 'icon.ico'), ico);
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), png512);
  fs.writeFileSync(path.join(root, 'assets', 'icon.ico'), ico);
  fs.writeFileSync(path.join(root, 'assets', 'icon.png'), png512);
  console.log('Wrote build/icon.ico, build/icon.png, assets/icon.ico, assets/icon.png');
  app.quit();
});
