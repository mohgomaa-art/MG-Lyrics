const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const svgPath = path.join(__dirname, '..', 'images', 'icon.svg');
const outPath = path.join(__dirname, '..', 'src-tauri', 'icon-source.png');

const svg = fs.readFileSync(svgPath);

sharp(svg, { density: 300 })
  .resize(1024, 1024)
  .png()
  .toFile(outPath)
  .then(() => console.log('Generated icon-source.png (1024x1024)'))
  .catch(err => { console.error('Failed:', err); process.exit(1); });
