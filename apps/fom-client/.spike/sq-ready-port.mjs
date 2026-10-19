import http from 'node:http';
import fs from 'node:fs';

const port = Number(process.argv[2] || 3091);
const log = process.argv[3] || 'sq-boot2.log';
const ANSI = new RegExp('\\u001B\\[[0-9;]*m', 'g');
const deadline = 300000;
const t0 = Date.now();

function probe() {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, res => {
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
console.log('port ' + port + ' ready status: ' + last + ' after ' + Math.round((Date.now() - t0) / 1000) + 's');
const text = fs.readFileSync(log, 'utf8').replace(ANSI, '');
const urls = text.match(new RegExp('http://127\\.0\\.0\\.1:' + port + '/\\S+', 'g')) || [];
if (urls.length) {
  const url = urls[urls.length - 1].replace(/[.,)]+$/, '');
  fs.writeFileSync('sq-loop2.url', url + '\n', 'utf8');
  console.log('url written to sq-loop2.url, length ' + url.length);
} else {
  console.log('no url in log');
}
const noise = text.split(/\r?\n/).filter(l => /error|Error|denied|EADDR|throw|Unhandled|sqlite|SQLITE|lock|busy/i.test(l));
console.log('--- noise lines (' + noise.length + ') ---');
console.log(noise.slice(0, 20).join('\n') || '(none)');
