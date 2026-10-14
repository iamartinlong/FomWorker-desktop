import fs from 'node:fs';

const ANSI = new RegExp('\\u001B\\[[0-9;]*m', 'g');
const text = fs.readFileSync('sq-boot.log', 'utf8').replace(ANSI, '');
const urls = text.match(/http:\/\/127\.0\.0\.1:3090\/\S+/g) || [];
if (urls.length === 0) { console.log('no url yet'); process.exit(1); }
const url = urls[urls.length - 1].replace(/[.,)]+$/, '');
fs.writeFileSync('sq-loop.url', url + '\n', 'utf8');
console.log('written to sq-loop.url, length ' + url.length);
console.log(url);
