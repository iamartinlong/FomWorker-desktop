import http from 'node:http';
import fs from 'node:fs';

const ANSI = new RegExp('\\u001B\\[[0-9;]*m', 'g');
const deadline = 300000;
const t0 = Date.now();

function probe() {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: 3090, path: '/', timeout: 2000 }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', error => resolve('ERR:' + error.code));
    req.on('timeout', () => { req.destroy(); resolve('TIMEOUT'); });
  });
}

let last = null;
while (Date.now() - t0 < deadline) {
  last = await probe();
  if (last === 401 || last === 200) break;
  await new Promise(r => setTimeout(r, 4000));
}
console.log('ready status: ' + last + ' after ' + Math.round((Date.now() - t0) / 1000) + 's');
const text = fs.readFileSync('sq-boot.log', 'utf8').replace(ANSI, '');
const url = text.match(/http:\/\/127\.0\.0\.1:3090\/[^\s"'|]+/g);
console.log('url hits: ' + (url ? url.length : 0));
console.log('--- tail 1800 ---');
console.log(text.slice(-1800));
