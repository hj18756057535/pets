const fs = require('node:fs');
const path = require('node:path');
const { readPet } = require('../src/core.cjs');
const source = process.argv[2];
if (!source) { console.error('用法：npm run import-pet -- "宠物目录"'); process.exit(1); }
const pet = readPet(path.resolve(source));
const target = path.join(__dirname, '..', '.local-pets', 'current');
fs.mkdirSync(target, { recursive: true });
fs.writeFileSync(path.join(target, 'spritesheet.webp'), pet.image);
fs.writeFileSync(path.join(target, 'pet.json'), JSON.stringify({ displayName: pet.name, description: pet.description, spriteVersionNumber: pet.version, spritesheetPath: 'spritesheet.webp' }, null, 2), 'utf8');
console.log(`已导入 ${pet.name} (${pet.size.width} × ${pet.size.height})。原资源未修改，本地资源不加入 Git。`);
