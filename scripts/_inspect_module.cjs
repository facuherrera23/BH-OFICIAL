const fs = require('fs');
const s = fs.readFileSync(process.argv[2], 'utf8');
const needle = process.argv[3];
const span = parseInt(process.argv[4] || '4000', 10);
const i = s.indexOf(needle);
if (i === -1) { console.log('NOT FOUND:', needle); process.exit(0); }
console.log(s.slice(i, i + span));
